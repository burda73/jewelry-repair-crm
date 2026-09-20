import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ORGANIZATION_SETTING_KEY,
  normalizeRequisites,
  organizationNameForPrint,
  organizationRequisitesSchema,
  type OrganizationRequisites,
} from '@app/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Настройки системы (требование заказчика).
 *
 * ## Почему отдельный модуль, а не чтение `setting` в каждом сервисе
 *
 * До этого настройки читались точечно: сервис эскалаций сам искал ключ
 * `orders.unclaimedAfterDays`, логистика — `logistics.batchMaxItems`. Пока
 * настройку никто не редактировал, это работало. Но как только появляется ЭКРАН,
 * форма значения становится контрактом между экраном, хранилищем и всеми
 * читателями: экран пишет строку, а квитанция ожидает объект, и разойтись они
 * могут молча.
 *
 * Здесь форма значения задаётся один раз — типом и нормализацией из домена, —
 * и все читатели получают уже приведённые данные.
 *
 * ## Переменные окружения остаются запасным вариантом
 *
 * Наименование организации раньше задавалось переменной `COMPANY_NAME`. Если в
 * настройках пусто, значение берётся из окружения: до первого сохранения
 * поведение прежнее, и обновление ничего не ломает.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Реквизиты организации.
   *
   * Никогда не бросает: квитанцию и акт нужно напечатать даже при испорченной
   * настройке. Нечитаемое значение приводится к форме по умолчанию — печатается
   * общее название, и это заметно, тогда как падение печати остановило бы работу
   * магазина.
   */
  async getOrganizationRequisites(): Promise<OrganizationRequisites> {
    const row = await this.prisma.setting.findUnique({
      where: { key: ORGANIZATION_SETTING_KEY },
      select: { value: true },
    });

    return normalizeRequisites(row?.value);
  }

  /**
   * Сохранить реквизиты организации.
   *
   * Запись и аудит — в одной транзакции: без записи в аудите нельзя было бы
   * ответить, кто и когда поменял наименование в документах, а именно им
   * определяется, от чьего имени печатается квитанция.
   */
  async saveOrganizationRequisites(
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<OrganizationRequisites> {
    const parsed = organizationRequisitesSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const before = await this.getOrganizationRequisites();
    const after = normalizeRequisites(parsed.data);

    /*
     * Приведение к `Prisma.InputJsonObject` явное: интерфейс домена не имеет
     * индексной сигнатуры, а Prisma требует именно объект JSON. Приведение здесь
     * безопасно — `after` получен из `normalizeRequisites`, то есть состоит
     * только из строк и `null`.
     */
    const value = after as unknown as Prisma.InputJsonObject;

    await this.prisma.runInTransaction(async (tx) => {
      await tx.setting.upsert({
        where: { key: ORGANIZATION_SETTING_KEY },
        update: { value, updatedById: actor.id },
        create: { key: ORGANIZATION_SETTING_KEY, value, updatedById: actor.id },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'SETTINGS_UPDATE',
          entity: 'Setting',
          entityId: ORGANIZATION_SETTING_KEY,
          // «До» и «после» целиком: реквизиты печатаются в документах, и по
          // журналу должно быть видно, какое наименование действовало когда.
          before: before as unknown as Prisma.InputJsonObject,
          after: value,
        },
      });
    });

    this.logger.log(`Реквизиты организации обновлены (${actor.email})`);

    return after;
  }

  /**
   * Наименование организации для печати.
   *
   * Отдельный метод, потому что квитанция и акт нуждаются только в названии и не
   * должны знать про остальные реквизиты и про запасное значение из окружения.
   */
  async organizationNameForPrint(): Promise<string> {
    const requisites = await this.getOrganizationRequisites();
    return organizationNameForPrint({
      requisites,
      envFallback: this.config.get<string>('COMPANY_NAME') ?? null,
    });
  }
}
