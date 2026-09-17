import {
  Injectable,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  checkTransition,
  availableTransitions,
  ORDER_STATUS,
  computeWarrantyUntil,
  addWorkingDays,
  addCalendarDays,
  isPrepaymentSatisfied,
  isPaidInFull,
  type OrderStatus,
  type GuardCode,
  type EffectCode,
  type TransitionActor,
  type TransitionRule,
  type WorkingCalendar,
} from '@app/shared';
import type { Prisma, StageNorm } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Результат перехода: заказ вместе с последней записью истории статусов.
 *
 * Вынесен в отдельный тип, потому что его возвращают и публичный `transition`,
 * и приватный `applyTransition`. Продублированный inline-тип разошёлся бы при
 * первом же изменении `include`.
 */
export type TransitionResult = Prisma.OrderGetPayload<{ include: { statusHistory: true } }>;

/** Контекст запроса на переход статуса. */
export interface TransitionContext {
  orderId: string;
  to: OrderStatus;
  /**
   * Пользователь, выполняющий переход. `null` — переход выполнен системой
   * (планировщик). Доменное ядро допускает актора `'SYSTEM'` для автоматических
   * переходов (например, `ACCEPTED → UNCLAIMED`). Раньше поле было объявлено как
   * `string`, а `actorRole` — как `RoleCode`, поэтому такие переходы были
   * недостижимы, а `OrderStatusHistory.isSystem` всегда оставался `false`.
   */
  actorId: string | null;
  actorRole: TransitionActor;
  reason?: string;
  version: number;
  payload?: Record<string, unknown>;
  scope: string;
  storeIds: readonly string[];
}

/** Данные, загруженные для проверки условий перехода. */
interface OrderGuardData {
  id: string;
  status: OrderStatus;
  version: number;
  consentCallRecording: boolean;
  itemsCount: number;
  worksCount: number;
  worksTotalMinor: number;
  stonesTotalMinor: number;
  discountMinor: number;
  totalAmountMinor: number;
  paidAmountMinor: number;
  prepaymentRequiredMinor: number;
  requiresPrepayment: boolean;
  approvalsCount: number;
  hasPickupSignature: boolean;
  refusalActExists: boolean;
  /** Заказ включён в активную (не отменённую) партию. */
  batchAssigned: boolean;
  /** Акт приёма-передачи партии сформирован. */
  batchActFormed: boolean;
  performerAssigned: boolean;
  workFinished: boolean;
  readyAt: Date | null;
  workshopId: string | null;
  warrantyMonths: number;
  claimOpen: boolean;
  /** Сложность ремонта — определяет норматив этапа производства. */
  complexity: string;
}

/**
 * Доменный сервис управления статусами заказа.
 *
 * ЭТО ЦЕНТРАЛЬНОЕ МЕСТО БИЗНЕС-ЛОГИКИ. Здесь реализованы требования ТЗ:
 *  * п. 2.5 — блокировка старта работ до подтверждения предоплаты;
 *  * п. 2.7 — расчёт нормативного срока и фиксация просрочек;
 *  * п. 2.8 — условие выдачи только при полной оплате;
 *  * п. 2.9 — расчёт срока гарантии;
 *  * п. 2.4 — обязательное согласие на запись разговоров.
 *
 * Все проверки выполняются НА СЕРВЕРЕ. UI лишь отображает доступные действия,
 * полученные из `availableTransitions`.
 */
@Injectable()
export class OrderWorkflowService {
  private readonly logger = new Logger(OrderWorkflowService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Доступные переходы для пользователя — для отображения кнопок в UI.
   * Не выполняет проверку guard-условий: UI показывает действие, а сервер
   * отклонит его с понятной причиной, если условие не выполнено.
   */
  getAvailableTransitions(status: OrderStatus, actorRole: TransitionActor): readonly TransitionRule[] {
    return availableTransitions(status, actorRole);
  }

  /**
   * Выполнить переход статуса.
   *
   * Порядок проверок (от дешёвых к дорогим):
   *  1. заказ существует и доступен в области видимости (защита от IDOR);
   *  2. оптимистичная блокировка по version (двое не перезапишут друг друга);
   *  3. переход разрешён таблицей для этой роли (docs/04-status-workflow.md §2);
   *  4. guard-условия (предоплата, оплата, согласование, причина и т. д.);
   *  5. применение изменений, побочные эффекты, аудит — в ОДНОЙ транзакции.
   */
  async transition(ctx: TransitionContext): Promise<TransitionResult> {
    const order = await this.loadOrderForGuards(ctx.orderId, ctx.scope, ctx.storeIds);

    // 2. Оптимистичная блокировка: пользователь мог открыть карточку раньше,
    //    а другой сотрудник уже изменил заказ.
    if (order.version !== ctx.version) {
      throw new ConflictException({
        code: 'STALE_VERSION',
        message: 'Заказ был изменён другим сотрудником. Обновите страницу и повторите.',
        details: { expectedVersion: order.version, providedVersion: ctx.version },
      });
    }

    // 3. Проверка таблицы переходов (роль + обязательность причины).
    const check = checkTransition({
      from: order.status,
      to: ctx.to,
      actorRole: ctx.actorRole,
      reason: ctx.reason ?? null,
    });

    if (!check.allowed) {
      throw this.mapDenialToException(check.code, check.message);
    }

    // 4. Guard-условия, требующие данных заказа.
    this.assertGuards(order, ctx, check.rule.guards);

    // 5. Применение в одной транзакции с аудитом и историей.
    const calendar = await this.loadCalendar();
    return this.applyTransition(order, ctx, check.rule.effects, calendar);
  }

  // -------------------------------------------------------------------------
  // Загрузка и проверка данных
  // -------------------------------------------------------------------------

  private async loadOrderForGuards(
    orderId: string,
    scope: string,
    storeIds: readonly string[],
  ): Promise<OrderGuardData> {
    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scope,
      storeIds,
      userId: '',
    });

    const order = await this.prisma.order.findFirst({
      where: { AND: [{ id: orderId }, scopeFilter] },
      include: {
        items: { select: { id: true } },
        works: { select: { id: true, warrantyMonths: true } },
        approvals: { where: { result: 'APPROVED' }, select: { id: true } },
        refusalAct: { select: { id: true } },
        claims: { where: { status: { in: ['OPENED', 'IN_REVIEW'] } }, select: { id: true } },
        assignments: { where: { status: { in: ['ASSIGNED', 'IN_PROGRESS', 'DONE'] } }, select: { id: true, status: true } },
        batchItems: {
          where: { removedAt: null },
          select: { batch: { select: { id: true, status: true, acts: { select: { id: true } } } } },
        },
        // Согласие на запись разговоров хранится у клиента (ТЗ п. 2.4),
        // а не у заказа — иначе его нельзя отозвать централизованно.
        customer: { select: { consentCallRecording: true } },
      },
    });

    // Заказ не найден ИЛИ вне области видимости → 404.
    // Не 403: не раскрываем существование чужих заказов.
    if (!order) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const activeBatch = order.batchItems[0]?.batch;
    const batchIsActive = activeBatch != null && activeBatch.status !== 'CANCELLED';

    return {
      id: order.id,
      status: order.status,
      version: order.version,
      consentCallRecording: order.customer.consentCallRecording,
      itemsCount: order.items.length,
      worksCount: order.works.length,
      worksTotalMinor: order.worksTotalMinor,
      stonesTotalMinor: order.stonesTotalMinor,
      discountMinor: order.discountMinor,
      totalAmountMinor: order.totalAmountMinor,
      paidAmountMinor: order.paidAmountMinor,
      prepaymentRequiredMinor: order.prepaymentRequiredMinor,
      requiresPrepayment: order.requiresPrepayment,
      approvalsCount: order.approvals.length,
      hasPickupSignature: order.pickupSignatureFileId != null,
      refusalActExists: order.refusalAct != null,
      batchAssigned: batchIsActive,
      batchActFormed: batchIsActive && activeBatch.acts.length > 0,
      performerAssigned: order.assignments.length > 0,
      workFinished: order.assignments.some((a) => a.status === 'DONE'),
      readyAt: order.readyAt,
      workshopId: order.workshopId,
      warrantyMonths: order.works.length > 0 ? Math.max(...order.works.map((w) => w.warrantyMonths)) : 6,
      claimOpen: order.claims.length > 0,
      complexity: order.complexity,
    };
  }

  /**
   * Загрузить производственный календарь для расчёта сроков.
   *
   * `public`, потому что его использует и модуль заказов: при согласовании
   * клиента обещанный срок считается по тем же правилам, что и нормативы
   * этапов. Вторая копия этого метода разошлась бы с первой, и срок в карточке
   * перестал бы совпадать со сроком, посчитанным при переводе статуса.
   */
  async loadCalendar(): Promise<WorkingCalendar> {
    const rows = await this.prisma.workingCalendar.findMany({
      where: { storeId: null },
      select: { date: true, isWorkday: true, hours: true },
    });

    const overrides = new Map<string, { isWorkday: boolean; hours?: number }>();
    for (const row of rows) {
      overrides.set(row.date.toISOString().slice(0, 10), {
        isWorkday: row.isWorkday,
        hours: row.hours,
      });
    }
    return { overrides, defaultHours: 8 };
  }

  /**
   * Норматив этапа в рабочих днях/часах — для расчёта dueAt (ТЗ п. 2.7).
   *
   * Норматив может быть задан для конкретного типа работ (`SIMPLE`/`COMPLEX`)
   * либо общим для этапа (`ANY`). Конкретный норматив **приоритетнее** общего:
   * для сложного ремонта срок больше, чем для простого.
   *
   * `workType` в БД не nullable (см. комментарий к модели `StageNorm`):
   * NULL в уникальном индексе PostgreSQL не обеспечивает уникальность.
   */
  private async loadStageNorm(stage: string, workType: string | null): Promise<StageNorm | null> {
    const candidates = await this.prisma.stageNorm.findMany({
      where: {
        stage,
        isActive: true,
        workType: { in: workType === null ? ['ANY'] : [workType, 'ANY'] },
      },
    });

    if (candidates.length === 0) return null;

    // Конкретный тип работ важнее общего норматива.
    return candidates.find((norm) => norm.workType === workType) ?? candidates[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Guard-условия — реализация бизнес-правил ТЗ
  // -------------------------------------------------------------------------

  private assertGuards(
    order: OrderGuardData,
    ctx: TransitionContext,
    guards: readonly GuardCode[],
  ): void {
    for (const guard of guards) {
      switch (guard) {
        case 'CONSENT_CALL_RECORDING':
          // ТЗ п. 2.4: обязательный пункт заявки о записи разговоров.
          if (!order.consentCallRecording) {
            throw new ConflictException({
              code: 'CONSENT_REQUIRED',
              message: 'Необходимо согласие клиента на запись разговора',
            });
          }
          break;

        case 'HAS_ITEMS':
          if (order.itemsCount < 1) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Добавьте хотя бы одно изделие',
            });
          }
          break;

        case 'CALC_NOT_EMPTY':
          if (order.worksCount < 1) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Калькуляция пуста: добавьте хотя бы одну работу',
            });
          }
          break;

        case 'PREPAYMENT_SATISFIED':
          // ТЗ п. 2.5: блокировка старта работ до подтверждения предоплаты.
          if (order.requiresPrepayment) {
            if (!isPrepaymentSatisfied(order.paidAmountMinor, order.prepaymentRequiredMinor)) {
              throw new ConflictException({
                code: 'PREPAYMENT_REQUIRED',
                message: 'Старт работ заблокирован: предоплата не внесена в полном объёме',
                details: {
                  requiredMinor: order.prepaymentRequiredMinor,
                  paidMinor: order.paidAmountMinor,
                  missingMinor: order.prepaymentRequiredMinor - order.paidAmountMinor,
                },
              });
            }
          }
          break;

        case 'PREPAYMENT_NOT_REQUIRED':
          if (order.requiresPrepayment && order.prepaymentRequiredMinor > 0) {
            throw new ConflictException({
              code: 'PREPAYMENT_REQUIRED',
              message: 'Для этого заказа требуется предоплата',
              details: { requiredMinor: order.prepaymentRequiredMinor },
            });
          }
          break;

        case 'APPROVAL_EXISTS':
          // ТЗ п. 2.4: согласование клиента по сумме и сроку.
          if (order.approvalsCount < 1) {
            throw new ConflictException({
              code: 'APPROVAL_MISSING',
              message: 'Отсутствует согласование клиента по сумме и сроку',
            });
          }
          break;

        case 'PAID_IN_FULL':
          // ТЗ п. 2.8: условие выдачи — полная оплата.
          if (!isPaidInFull(order.totalAmountMinor, order.paidAmountMinor)) {
            throw new ConflictException({
              code: 'NOT_PAID_IN_FULL',
              message: 'Выдача невозможна: заказ оплачен не полностью',
              details: {
                totalMinor: order.totalAmountMinor,
                paidMinor: order.paidAmountMinor,
                remainingMinor: order.totalAmountMinor - order.paidAmountMinor,
              },
            });
          }
          break;

        case 'PICKUP_SIGNATURE':
          if (!order.hasPickupSignature) {
            throw new ConflictException({
              code: 'PICKUP_SIGNATURE_REQUIRED',
              message: 'Требуется подпись клиента о получении изделия',
            });
          }
          break;

        case 'REFUSAL_ACT_EXISTS':
          if (!order.refusalActExists) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Оформите акт отказа от оплаты',
            });
          }
          break;

        case 'BATCH_ASSIGNED':
          if (!order.batchAssigned) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Заказ не привязан к партии',
            });
          }
          break;

        case 'BATCH_ACT_FORMED':
          if (!order.batchActFormed) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Акт приёма-передачи партии не сформирован',
            });
          }
          break;

        case 'PERFORMER_ASSIGNED':
          if (!order.performerAssigned) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Назначьте исполнителя производства',
            });
          }
          break;

        case 'WORK_FINISHED':
          if (!order.workFinished) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Работы по заказу ещё не завершены',
            });
          }
          break;

        case 'BATCH_RECEIVED_BY_WORKSHOP':
          // Проверяется при приёмке партии — здесь фиксируется факт.
          break;

        case 'BATCH_RECEIVED_BY_STORE':
          break;

        case 'REWORK_REASON':
          if (!order.claimOpen && !ctx.reason) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Укажите основание для доработки: рекламация или внутренний брак',
            });
          }
          break;

        case 'UNCLAIMED_THRESHOLD': {
          // ТЗ п. 2.8: статус «невостребовано» через 30 дней.
          const unclaimedAfterDays = Number(process.env.UNCLAIMED_AFTER_DAYS ?? 30);
          if (order.readyAt == null) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Заказ ещё не готов к выдаче',
            });
          }
          const threshold = addCalendarDays(order.readyAt, unclaimedAfterDays);
          if (new Date() < threshold) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: `Заказ ожидает выдачи менее ${unclaimedAfterDays} дней`,
              details: { threshold: threshold.toISOString(), readyAt: order.readyAt.toISOString() },
            });
          }
          break;
        }

        case 'REASON_REQUIRED':
          // Проверено в checkTransition; здесь — страховка.
          if (!ctx.reason || ctx.reason.trim().length < 3) {
            throw new ConflictException({
              code: 'REASON_REQUIRED',
              message: 'Необходимо указать причину',
            });
          }
          break;

        case 'WORK_NOT_STARTED':
          if (order.status !== ORDER_STATUS.ACCEPTED) {
            throw new ConflictException({
              code: 'BUSINESS_RULE_VIOLATION',
              message: 'Работы по заказу уже начаты, отмена невозможна',
            });
          }
          break;

        default:
          // Неизвестное условие — лучше отказать, чем пропустить непроверенным.
          this.logger.error(`Неизвестное guard-условие: ${String(guard)}`);
          throw new ForbiddenException({
            code: 'BUSINESS_RULE_VIOLATION',
            message: 'Действие временно недоступно',
          });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Применение перехода
  // -------------------------------------------------------------------------

  private async applyTransition(
    order: OrderGuardData,
    ctx: TransitionContext,
    effects: readonly EffectCode[],
    calendar: WorkingCalendar,
  ): Promise<TransitionResult> {
    const now = new Date();

    // Расчёт изменения дедлайна (ТЗ п. 2.7): при входе в статус ставится
    // норматив этапа. Значения берутся из справочника, не хардкодятся.
    //
    // Сложность заказа передаётся, чтобы для производства применить норматив
    // SIMPLE/COMPLEX, а не общий. Для остальных этапов норматив задан как ANY,
    // и конкретный тип работ там не влияет.
    const norm = await this.loadStageNorm(ctx.to, order.complexity);
    let newDueAt: Date | null = order.readyAt; // значение по умолчанию — не меняем

    if (effects.includes('SET_DUE_AT') && norm) {
      if (norm.unit === 'WORKDAY') {
        newDueAt = addWorkingDays(now, norm.value, calendar);
      } else if (norm.unit === 'CALENDAR_DAY') {
        newDueAt = addCalendarDays(now, norm.value);
      } else {
        // Рабочие часы — приблизительно, через рабочие дни с пропорцией 8 ч/день.
        const days = Math.ceil(norm.value / 8);
        newDueAt = addWorkingDays(now, days, calendar);
      }
    }

    return this.prisma.runInTransaction(async (tx) => {
      // Обновление заказа с проверкой version — защита от гонки.
      const updateData: Record<string, unknown> = {
        status: ctx.to,
        version: { increment: 1 },
        escalatedAt: null, // сбрасываем эскалацию: заказ перешёл на новый этап
      };

      if (newDueAt) updateData.dueAt = newDueAt;
      if (effects.includes('SET_ACCEPTED_AT')) updateData.acceptedAt = now;
      if (effects.includes('SET_APPROVED_AT')) updateData.approvedAt = now;
      if (effects.includes('SET_PREPAYMENT_CONFIRMED_AT')) updateData.prepaymentConfirmedAt = now;
      if (effects.includes('SET_PRODUCTION_STARTED_AT')) updateData.productionStartedAt = now;
      if (effects.includes('SET_PRODUCTION_FINISHED_AT')) updateData.productionFinishedAt = now;
      if (effects.includes('SET_READY_AT')) updateData.readyAt = now;
      if (effects.includes('SET_COMPLETED_AT')) updateData.completedAt = now;
      if (effects.includes('RESET_PERFORMER')) updateData.productionManagerId = null;

      // ТЗ п. 2.9: срок гарантии рассчитывается при выдаче.
      if (effects.includes('COMPUTE_WARRANTY')) {
        updateData.warrantyUntil = computeWarrantyUntil(now, [order.warrantyMonths]);
        updateData.warrantyMonths = order.warrantyMonths;
      }

      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: updateData,
      });

      if (updated.count === 0) {
        // Кто-то изменил заказ между проверкой и записью — не молчим.
        throw new ConflictException({
          code: 'STALE_VERSION',
          message: 'Заказ был изменён другим сотрудником. Обновите страницу.',
        });
      }

      // История статусов — для отчётности по срокам (ТЗ п. 2.7, 2.11).
      const durationMinutes = await this.computeStageDuration(tx, order.id, now, ctx.to);

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: ctx.to,
          stage: ctx.to,
          changedById: ctx.actorId,
          isSystem: ctx.actorRole === 'SYSTEM',
          reason: ctx.reason ?? null,
          dueAtAfter: newDueAt,
          durationMinutes,
        },
      });

      // Аудит: каждое изменение статуса фиксируется (ТЗ п. 4).
      await tx.auditLog.create({
        data: {
          actorId: ctx.actorId,
          // Для системного перехода роль не записывается: `'SYSTEM'` — это не роль,
          // а тип актора, и в enum RoleCode его нет. Признак системности виден по
          // `actorId = null` и по `OrderStatusHistory.isSystem = true`.
          actorRole: ctx.actorRole === 'SYSTEM' ? null : ctx.actorRole,
          action: 'STATUS_CHANGE',
          entity: 'Order',
          entityId: order.id,
          before: { status: order.status, dueAt: order.readyAt },
          after: { status: ctx.to, dueAt: newDueAt },
          reason: ctx.reason ?? null,
        },
      });

      this.logger.log(
        `Заказ ${order.id}: ${order.status} → ${ctx.to} (${ctx.actorRole}, причина: ${ctx.reason ?? '—'})`,
      );

      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { statusHistory: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
    });
  }

  /** Длительность пребывания в предыдущем статусе — для отчёта «Сроки по этапам». */
  private async computeStageDuration(
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
    orderId: string,
    now: Date,
    toStatus: OrderStatus,
  ): Promise<number | null> {
    const previous = await tx.orderStatusHistory.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    if (!previous) return null;
    const minutes = Math.round((now.getTime() - previous.createdAt.getTime()) / 60_000);
    this.logger.debug(`Заказ ${orderId}: длительность этапа ${toStatus} — ${minutes} мин`);
    return minutes;
  }

  /** Преобразование отказа перехода в HTTP-исключение с контрактным кодом. */
  private mapDenialToException(code: string, message: string): Error {
    switch (code) {
      case 'FORBIDDEN_ROLE':
        return new ForbiddenException({ code: 'FORBIDDEN_ROLE', message });
      case 'REASON_REQUIRED':
        return new ConflictException({ code: 'REASON_REQUIRED', message });
      case 'TERMINAL_STATE':
        return new ConflictException({ code: 'INVALID_TRANSITION', message });
      case 'INVALID_TRANSITION':
      default:
        return new ConflictException({ code: 'INVALID_TRANSITION', message });
    }
  }
}