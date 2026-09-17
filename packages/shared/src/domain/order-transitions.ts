/**
 * Таблица переходов статусов заказа с ролями и guard-условиями.
 * Реализует docs/04-status-workflow.md §2. Тесты обязаны покрывать каждый переход.
 *
 * ВАЖНО: это единственное место, где описаны разрешённые переходы. Ни контроллер,
 * ни фронтенд не дублируют эту логику.
 */

import { ORDER_STATUS, type OrderStatus, isTerminalStatus } from './order-status.js';
import { ROLE, type RoleCode } from './roles.js';

/** Кто может выполнить переход: конкретные роли или система (планировщик). */
export type TransitionActor = RoleCode | 'SYSTEM';

/**
 * Guard-условия, проверяемые доменным сервисом перед переходом.
 * Каждое условие соответствует коду ошибки в API (docs/07-api-spec.md §16).
 */
export const GUARD = {
  /** Есть отметка о согласии клиента на запись разговоров (ТЗ п. 2.4). */
  CONSENT_CALL_RECORDING: 'CONSENT_CALL_RECORDING',
  /** В заказе минимум одно изделие. */
  HAS_ITEMS: 'HAS_ITEMS',
  /** Калькуляция не пуста (есть хотя бы одна строка работы). */
  CALC_NOT_EMPTY: 'CALC_NOT_EMPTY',
  /** Предоплата внесена в достаточном объёме (ТЗ п. 2.5). */
  PREPAYMENT_SATISFIED: 'PREPAYMENT_SATISFIED',
  /** Предоплата для этого заказа не требуется. */
  PREPAYMENT_NOT_REQUIRED: 'PREPAYMENT_NOT_REQUIRED',
  /** Есть согласование клиента по сумме и сроку (ТЗ п. 2.4). */
  APPROVAL_EXISTS: 'APPROVAL_EXISTS',
  /** Заказ оплачен полностью (ТЗ п. 2.8). */
  PAID_IN_FULL: 'PAID_IN_FULL',
  /** Есть подпись клиента о получении. */
  PICKUP_SIGNATURE: 'PICKUP_SIGNATURE',
  /** Оформлен акт отказа от оплаты (ТЗ п. 2.8). */
  REFUSAL_ACT_EXISTS: 'REFUSAL_ACT_EXISTS',
  /** Заказ привязан к партии. */
  BATCH_ASSIGNED: 'BATCH_ASSIGNED',
  /** Акт приёма-передачи партии сформирован. */
  BATCH_ACT_FORMED: 'BATCH_ACT_FORMED',
  /** Назначен исполнитель производства. */
  PERFORMER_ASSIGNED: 'PERFORMER_ASSIGNED',
  /** Работы завершены. */
  WORK_FINISHED: 'WORK_FINISHED',
  /** Партия фактически принята цехом. */
  BATCH_RECEIVED_BY_WORKSHOP: 'BATCH_RECEIVED_BY_WORKSHOP',
  /** Партия принята магазином. */
  BATCH_RECEIVED_BY_STORE: 'BATCH_RECEIVED_BY_STORE',
  /** Есть основание для доработки: рекламация или внутренний брак. */
  REWORK_REASON: 'REWORK_REASON',
  /** Готовый заказ не получен клиентом более 30 дней (ТЗ п. 2.8). */
  UNCLAIMED_THRESHOLD: 'UNCLAIMED_THRESHOLD',
  /** Обязательное поле «причина» заполнено. */
  REASON_REQUIRED: 'REASON_REQUIRED',
  /** Работы ещё не начаты (для отмены). */
  WORK_NOT_STARTED: 'WORK_NOT_STARTED',
} as const;

export type GuardCode = (typeof GUARD)[keyof typeof GUARD];

/** Побочные эффекты перехода — выполняются в одной транзакции с изменением статуса. */
export const EFFECT = {
  GENERATE_ORDER_NO: 'GENERATE_ORDER_NO',
  RECALC_TOTALS: 'RECALC_TOTALS',
  SET_DUE_AT: 'SET_DUE_AT',
  SET_ACCEPTED_AT: 'SET_ACCEPTED_AT',
  SET_APPROVED_AT: 'SET_APPROVED_AT',
  SET_PREPAYMENT_CONFIRMED_AT: 'SET_PREPAYMENT_CONFIRMED_AT',
  SET_PRODUCTION_STARTED_AT: 'SET_PRODUCTION_STARTED_AT',
  SET_PRODUCTION_FINISHED_AT: 'SET_PRODUCTION_FINISHED_AT',
  SET_READY_AT: 'SET_READY_AT',
  SET_COMPLETED_AT: 'SET_COMPLETED_AT',
  COMPUTE_WARRANTY: 'COMPUTE_WARRANTY',
  RESET_PERFORMER: 'RESET_PERFORMER',
  NOTIFY_NEXT_RESPIBLE: 'NOTIFY_NEXT_RESPIBLE',
  NOTIFY_CUSTOMER: 'NOTIFY_CUSTOMER',
  NOTIFY_RECEIVER: 'NOTIFY_RECEIVER',
  CLEAR_ESCALATION: 'CLEAR_ESCALATION',
} as const;

export type EffectCode = (typeof EFFECT)[keyof typeof EFFECT];

export interface TransitionRule {
  /** Стабильный идентификатор правила — совпадает с номером в docs/04-status-workflow.md §2. */
  id: number;
  from: OrderStatus | null; // null = создание заказа
  to: OrderStatus;
  actors: readonly TransitionActor[];
  guards: readonly GuardCode[];
  effects: readonly EffectCode[];
  /** Требуется ли обоснование (пишется в AuditLog.reason). */
  requiresReason: boolean;
  /** Подпись действия для UI. */
  label: string;
}

/**
 * Полная таблица переходов. Порядок соответствует docs/04-status-workflow.md §2.
 * Изменение этой таблицы требует обновления документации — это проверяется тестом.
 */
export const ORDER_TRANSITIONS: readonly TransitionRule[] = [
  {
    id: 1,
    from: null,
    to: ORDER_STATUS.DRAFT,
    actors: [ROLE.RECEIVER, ROLE.ADMIN],
    guards: [GUARD.CONSENT_CALL_RECORDING, GUARD.HAS_ITEMS],
    effects: [EFFECT.GENERATE_ORDER_NO],
    requiresReason: false,
    label: 'Создать заказ',
  },
  {
    id: 2,
    from: ORDER_STATUS.DRAFT,
    to: ORDER_STATUS.AWAITING_APPROVAL,
    actors: [ROLE.RECEIVER, ROLE.ADMIN],
    guards: [GUARD.CONSENT_CALL_RECORDING, GUARD.CALC_NOT_EMPTY],
    effects: [EFFECT.RECALC_TOTALS, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Отправить на согласование',
  },
  {
    id: 3,
    from: ORDER_STATUS.DRAFT,
    to: ORDER_STATUS.ACCEPTED,
    actors: [ROLE.RECEIVER, ROLE.ADMIN],
    guards: [GUARD.CALC_NOT_EMPTY, GUARD.PREPAYMENT_NOT_REQUIRED],
    effects: [EFFECT.RECALC_TOTALS, EFFECT.SET_ACCEPTED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Принять в работу',
  },
  {
    id: 4,
    from: ORDER_STATUS.AWAITING_APPROVAL,
    to: ORDER_STATUS.AWAITING_PREPAYMENT,
    actors: [ROLE.RECEIVER, ROLE.CASHIER, ROLE.ADMIN],
    guards: [GUARD.APPROVAL_EXISTS],
    effects: [EFFECT.SET_APPROVED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Согласовано, ждём предоплату',
  },
  {
    id: 5,
    from: ORDER_STATUS.AWAITING_APPROVAL,
    to: ORDER_STATUS.ACCEPTED,
    actors: [ROLE.RECEIVER, ROLE.ADMIN],
    guards: [GUARD.APPROVAL_EXISTS, GUARD.PREPAYMENT_NOT_REQUIRED],
    effects: [EFFECT.SET_APPROVED_AT, EFFECT.SET_ACCEPTED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Согласовано, принят в работу',
  },
  {
    id: 6,
    from: ORDER_STATUS.AWAITING_APPROVAL,
    to: ORDER_STATUS.CANCELLED,
    actors: [ROLE.RECEIVER, ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REASON_REQUIRED],
    effects: [],
    requiresReason: true,
    label: 'Отменить (клиент отказался)',
  },
  {
    id: 7,
    // Система переводит автоматически при поступлении предоплаты; кассир/админ — вручную.
    from: ORDER_STATUS.AWAITING_PREPAYMENT,
    to: ORDER_STATUS.ACCEPTED,
    actors: ['SYSTEM', ROLE.CASHIER, ROLE.ADMIN],
    guards: [GUARD.PREPAYMENT_SATISFIED],
    effects: [EFFECT.SET_PREPAYMENT_CONFIRMED_AT, EFFECT.SET_DUE_AT, EFFECT.NOTIFY_NEXT_RESPIBLE],
    requiresReason: false,
    label: 'Предоплата внесена, работы разблокированы',
  },
  {
    id: 8,
    from: ORDER_STATUS.AWAITING_PREPAYMENT,
    to: ORDER_STATUS.CANCELLED,
    actors: [ROLE.RECEIVER, ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REASON_REQUIRED],
    effects: [],
    requiresReason: true,
    label: 'Отменить (предоплата не внесена)',
  },
  {
    id: 9,
    from: ORDER_STATUS.ACCEPTED,
    to: ORDER_STATUS.QUEUED_FOR_DISPATCH,
    actors: [ROLE.PRODUCTION_MANAGER, ROLE.LOGISTICIAN, 'SYSTEM'],
    guards: [GUARD.PREPAYMENT_SATISFIED],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'В очередь на отправку',
  },
  {
    id: 10,
    from: ORDER_STATUS.ACCEPTED,
    to: ORDER_STATUS.CANCELLED,
    actors: [ROLE.RECEIVER, ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REASON_REQUIRED, GUARD.WORK_NOT_STARTED],
    effects: [],
    requiresReason: true,
    label: 'Отменить до начала работ',
  },
  {
    id: 11,
    from: ORDER_STATUS.QUEUED_FOR_DISPATCH,
    to: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
    actors: [ROLE.PRODUCTION_MANAGER, ROLE.LOGISTICIAN],
    guards: [GUARD.BATCH_ASSIGNED, GUARD.BATCH_ACT_FORMED],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Отправить в цех',
  },
  {
    id: 12,
    from: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
    to: ORDER_STATUS.IN_PRODUCTION,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.BATCH_RECEIVED_BY_WORKSHOP],
    effects: [EFFECT.SET_PRODUCTION_STARTED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Принят цехом',
  },
  {
    id: 13,
    from: ORDER_STATUS.IN_PRODUCTION,
    to: ORDER_STATUS.QUEUED_FOR_DISPATCH,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.REASON_REQUIRED],
    effects: [EFFECT.RESET_PERFORMER, EFFECT.SET_DUE_AT],
    requiresReason: true,
    label: 'Вернуть в очередь (перераспределение)',
  },
  {
    id: 14,
    from: ORDER_STATUS.IN_PRODUCTION,
    to: ORDER_STATUS.IN_TRANSIT_TO_STORE,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.PERFORMER_ASSIGNED, GUARD.WORK_FINISHED],
    effects: [EFFECT.SET_PRODUCTION_FINISHED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Работы завершены, отправить в магазин',
  },
  {
    id: 15,
    from: ORDER_STATUS.IN_PRODUCTION,
    to: ORDER_STATUS.REWORK,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.REWORK_REASON, GUARD.REASON_REQUIRED],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: true,
    label: 'На доработку',
  },
  {
    id: 16,
    from: ORDER_STATUS.REWORK,
    to: ORDER_STATUS.IN_PRODUCTION,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.PERFORMER_ASSIGNED],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Вернуть в производство',
  },
  {
    id: 17,
    from: ORDER_STATUS.IN_TRANSIT_TO_STORE,
    to: ORDER_STATUS.READY_FOR_PICKUP,
    actors: [ROLE.RECEIVER, ROLE.LOGISTICIAN],
    guards: [GUARD.BATCH_RECEIVED_BY_STORE],
    effects: [EFFECT.SET_READY_AT, EFFECT.SET_DUE_AT, EFFECT.NOTIFY_CUSTOMER],
    requiresReason: false,
    label: 'Готов к выдаче',
  },
  {
    id: 18,
    from: ORDER_STATUS.READY_FOR_PICKUP,
    to: ORDER_STATUS.COMPLETED,
    actors: [ROLE.RECEIVER, ROLE.CASHIER, ROLE.ADMIN],
    guards: [GUARD.PAID_IN_FULL, GUARD.PICKUP_SIGNATURE],
    effects: [
      EFFECT.SET_COMPLETED_AT,
      EFFECT.COMPUTE_WARRANTY,
      EFFECT.CLEAR_ESCALATION,
      EFFECT.NOTIFY_CUSTOMER,
    ],
    requiresReason: false,
    label: 'Выдать клиенту',
  },
  {
    id: 19,
    from: ORDER_STATUS.READY_FOR_PICKUP,
    to: ORDER_STATUS.UNCLAIMED,
    actors: ['SYSTEM'],
    guards: [GUARD.UNCLAIMED_THRESHOLD],
    effects: [EFFECT.NOTIFY_RECEIVER],
    requiresReason: false,
    label: 'Невостребовано (30 дней)',
  },
  {
    id: 20,
    from: ORDER_STATUS.READY_FOR_PICKUP,
    to: ORDER_STATUS.REFUSED,
    actors: [ROLE.RECEIVER, ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REFUSAL_ACT_EXISTS, GUARD.REASON_REQUIRED],
    effects: [EFFECT.CLEAR_ESCALATION],
    requiresReason: true,
    label: 'Отказ от оплаты (акт)',
  },
  {
    id: 21,
    from: ORDER_STATUS.UNCLAIMED,
    to: ORDER_STATUS.COMPLETED,
    actors: [ROLE.RECEIVER, ROLE.CASHIER, ROLE.ADMIN],
    guards: [GUARD.PAID_IN_FULL, GUARD.PICKUP_SIGNATURE],
    effects: [EFFECT.SET_COMPLETED_AT, EFFECT.COMPUTE_WARRANTY, EFFECT.CLEAR_ESCALATION],
    requiresReason: false,
    label: 'Выдать клиенту (невостребованный)',
  },
  {
    id: 22,
    from: ORDER_STATUS.UNCLAIMED,
    to: ORDER_STATUS.REFUSED,
    actors: [ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REFUSAL_ACT_EXISTS, GUARD.REASON_REQUIRED],
    effects: [EFFECT.CLEAR_ESCALATION],
    requiresReason: true,
    label: 'Отказ от оплаты (акт, невостребованный)',
  },
];

/** Результат проверки допустимости перехода. */
export type TransitionCheck =
  | { allowed: true; rule: TransitionRule }
  | { allowed: false; code: TransitionDenialCode; message: string };

export type TransitionDenialCode =
  'INVALID_TRANSITION' | 'TERMINAL_STATE' | 'FORBIDDEN_ROLE' | 'REASON_REQUIRED';

/** Найти правило перехода. Возвращает undefined, если переход не разрешён. */
export function findTransition(
  from: OrderStatus | null,
  to: OrderStatus,
): TransitionRule | undefined {
  return ORDER_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/**
 * Проверка перехода по статусу, роли и наличию причины.
 * Проверка guard-условий выполняется отдельно — они требуют данных из БД.
 */
export function checkTransition(params: {
  from: OrderStatus | null;
  to: OrderStatus;
  actorRole: TransitionActor;
  reason?: string | null;
}): TransitionCheck {
  const { from, to, actorRole, reason } = params;

  if (from !== null && isTerminalStatus(from)) {
    return {
      allowed: false,
      code: 'TERMINAL_STATE',
      message: 'Заказ закрыт, изменение статуса невозможно',
    };
  }

  const rule = findTransition(from, to);
  if (!rule) {
    return {
      allowed: false,
      code: 'INVALID_TRANSITION',
      message: `Переход ${from ?? 'создание'} → ${to} не предусмотрен`,
    };
  }

  if (!rule.actors.includes(actorRole) && actorRole !== ROLE.ADMIN) {
    return {
      allowed: false,
      code: 'FORBIDDEN_ROLE',
      message: 'Недостаточно прав для этого действия',
    };
  }

  if (rule.requiresReason && (!reason || reason.trim().length < 3)) {
    return {
      allowed: false,
      code: 'REASON_REQUIRED',
      message: 'Необходимо указать причину (минимум 3 символа)',
    };
  }

  return { allowed: true, rule };
}

/** Все переходы, доступные из текущего статуса указанной роли (для UI). */
export function availableTransitions(
  from: OrderStatus | null,
  actorRole: TransitionActor,
): readonly TransitionRule[] {
  if (from !== null && isTerminalStatus(from)) return [];
  return ORDER_TRANSITIONS.filter(
    (t) => t.from === from && (t.actors.includes(actorRole) || actorRole === ROLE.ADMIN),
  );
}
