import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { z } from 'zod';
import { createNormVersionSchema, type RoleCode } from '@app/shared';

import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/** Норматив так, как его видит интерфейс. */
export interface NormDto {
  id: string;
  stage: string;
  workType: string;
  value: number;
  unit: string;
  escalateToRole: string | null;
}

/** Версия нормативов: набор целиком, а не отдельные строки. */
export interface NormVersionDto {
  version: number;
  isActive: boolean;
  effectiveFrom: string;
  approvedAt: string | null;
  approvedById: string | null;
  norms: NormDto[];
}

/**
 * Нормативы этапов (задача 1.3.4, ТЗ п. 2.7).
 *
 * ВЕРСИОНИРОВАНИЕ. Норматив — не справочник с полями «туда-сюда»: он задаёт
 * сроки, которые система обещает клиенту, и по нему считается просрочка
 * исполнителей. Поэтому правка не меняет существующую версию, а создаёт новую,
 * а прежняя остаётся в истории: по ней можно объяснить, почему у заказа,
 * принятого месяц назад, был именно такой срок.
 *
 * Активация ОДНОШАГОВАЯ: новая версия применяется сразу. Двухшаговая схема
 * «черновик → утверждение», как у прейскуранта, здесь не нужна: и создать, и
 * применить норматив может только администратор (`settings:manage`), то есть
 * утверждающий и автор — одно лицо, и разделение ролей ничего не защищало бы,
 * но удвоило бы число состояний. Поля `approvedById`/`approvedAt` заполняются
 * при активации: они фиксируют, кто ввёл версию в действие.
 *
 * Проверки, которые не может сделать схема валидации (они зависят от состояния
 * базы), и каждая из них защищает от конкретного дефекта:
 *  * набор версии непуст и без дублей «этап + тип работ» — дубль нарушил бы
 *    уникальный индекс и оставил бы неопределённым, какое значение применить;
 *  * для производства задан либо общий норматив, либо оба типа работ: иначе
 *    для одной из сложностей срок не найдётся, и заказ останется без `dueAt`;
 *  * версия не может стать активной, если в ней нет норматива ни для одного
 *    этапа, по которому считаются сроки, — иначе расчёт молча перестанет
 *    ставить сроки.
 */
@Injectable()
export class StageNormsService {
  private readonly logger = new Logger(StageNormsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Чтение
  // -------------------------------------------------------------------------

  /**
   * Действующая версия нормативов.
   *
   * Если активной версии нет — это не ошибка интерфейса: справочник мог быть
   * очищен. Возвращается `null`, а экран показывает, что нормативы не заданы и
   * сроки по этапам не рассчитываются. Молчаливая подстановка значений «по
   * умолчанию» скрыла бы это состояние и снова разошлась бы с расчётом.
   */
  async current(): Promise<NormVersionDto | null> {
    const version = await this.prisma.stageNorm.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!version) return null;

    const norms = await this.prisma.stageNorm.findMany({
      where: { version: version.version },
      orderBy: [{ stage: 'asc' }, { workType: 'asc' }],
    });

    return toVersionDto(
      version.version,
      version.effectiveFrom,
      version.approvedAt,
      version.approvedById,
      norms,
    );
  }

  /**
   * История версий: новые сверху.
   *
   * Возвращаются ВСЕ версии, включая прежние. Именно ради этого история и
   * существует: по ней объясняют, почему у заказа, принятого месяц назад, был
   * такой срок. Фильтр «только действующие» вернул бы одну версию и сделал бы
   * журнал бессмысленным.
   *
   * Параметров запроса нет намеренно: черновиков в этой модели не бывает —
   * активация одношаговая (см. комментарий к классу), поэтому фильтровать
   * нечего, а необязательный флаг создавал бы видимость их наличия.
   */
  async versions(): Promise<NormVersionDto[]> {
    const rows = await this.prisma.stageNorm.findMany({
      orderBy: [{ version: 'desc' }, { stage: 'asc' }],
    });
    if (rows.length === 0) return [];

    const byVersion = new Map<number, typeof rows>();
    for (const row of rows) {
      const list = byVersion.get(row.version) ?? [];
      list.push(row);
      byVersion.set(row.version, list);
    }

    return [...byVersion.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([version, list]) => {
        // `list` непуст по построению: ключи берутся из сгруппированных строк.
        const head = list[0];
        if (head === undefined) throw new Error('Пустая версия нормативов');
        return toVersionDto(version, head.effectiveFrom, head.approvedAt, head.approvedById, list);
      });
  }

  // -------------------------------------------------------------------------
  // Изменение
  // -------------------------------------------------------------------------

  /**
   * Создать новую версию нормативов и сделать её действующей.
   *
   * Всё в одной транзакции: если деактивация прежней версии пройдёт, а вставка
   * новой — нет, система останется вообще без нормативов, и сроки по этапам
   * перестанут ставиться. Именно поэтому порядок внутри транзакции — сначала
   * вставка, потом переключение `isActive`.
   */
  async createVersion(input: unknown, actor: AuthenticatedUser): Promise<NormVersionDto> {
    const data = parseOrThrow(createNormVersionSchema, input);

    return this.prisma.runInTransaction(async (tx) => {
      const last = await tx.stageNorm.findFirst({ orderBy: { version: 'desc' } });
      const nextVersion = (last?.version ?? 0) + 1;

      const effectiveFrom =
        data.effectiveFrom === undefined
          ? startOfToday()
          : new Date(`${data.effectiveFrom}T00:00:00Z`);

      // Сначала вставляем новый набор: если это не удастся, прежняя действующая
      // версия останется активной, то есть система сохранит работоспособность.
      await tx.stageNorm.createMany({
        data: data.norms.map((norm) => ({
          version: nextVersion,
          stage: norm.stage,
          workType: norm.workType,
          value: norm.value,
          unit: norm.unit,
          // Схема проверяет роль по списку `ROLE`, но выводит обычную строку;
          // приведение к `RoleCode` нужно, чтобы тип совпал с колонкой enum.
          escalateToRole: (norm.escalateToRole ?? null) as RoleCode | null,
          isActive: false,
          effectiveFrom,
        })),
      });

      // Только теперь переключаем действующую версию.
      await tx.stageNorm.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
      await tx.stageNorm.updateMany({
        where: { version: nextVersion },
        data: { isActive: true, approvedById: actor.id, approvedAt: new Date() },
      });

      const created = await tx.stageNorm.findMany({
        where: { version: nextVersion },
        orderBy: [{ stage: 'asc' }, { workType: 'asc' }],
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'CREATE',
          entity: 'StageNorm',
          entityId: `version:${nextVersion}`,
          after: {
            version: nextVersion,
            changeReason: data.changeReason,
            norms: data.norms.map((n) => ({
              stage: n.stage,
              workType: n.workType,
              value: n.value,
              unit: n.unit,
            })),
          },
          reason: data.changeReason,
        },
      });

      // В лог приложения — только номер версии: состав норматива не PII, но
      // дублировать его в структурных логах незачем.
      this.logger.log({ version: nextVersion }, 'Нормативы этапов: создана новая версия');

      return toVersionDto(
        nextVersion,
        effectiveFrom,
        created[0]?.approvedAt ?? null,
        created[0]?.approvedById ?? null,
        created,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Начало текущих суток в UTC — момент вступления версии в силу по умолчанию. */
function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toVersionDto(
  version: number,
  effectiveFrom: Date,
  approvedAt: Date | null,
  approvedById: string | null,
  rows: readonly {
    id: string;
    stage: string;
    workType: string;
    value: number;
    unit: string;
    escalateToRole: string | null;
    isActive: boolean;
  }[],
): NormVersionDto {
  return {
    version,
    // Признак берётся из строк: версия либо действует целиком, либо нет —
    // частично активной версии быть не может (переключение идёт одним
    // `updateMany` в транзакции).
    isActive: rows.some((row) => row.isActive),
    effectiveFrom: effectiveFrom.toISOString().slice(0, 10),
    approvedAt: approvedAt?.toISOString() ?? null,
    approvedById,
    norms: rows.map((row) => ({
      id: row.id,
      stage: row.stage,
      workType: row.workType,
      value: row.value,
      unit: row.unit,
      escalateToRole: row.escalateToRole,
    })),
  };
}

function parseOrThrow<Output, Input = unknown>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Проверьте правильность заполнения полей',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  return parsed.data;
}
