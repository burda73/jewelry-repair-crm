/**
 * Статусная модель заказа. Единый источник правды для API и веб-интерфейса.
 * Документация: docs/04-status-workflow.md
 */

export const ORDER_STATUS = {
  DRAFT: 'DRAFT',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  AWAITING_PREPAYMENT: 'AWAITING_PREPAYMENT',
  ACCEPTED: 'ACCEPTED',
  QUEUED_FOR_DISPATCH: 'QUEUED_FOR_DISPATCH',
  IN_TRANSIT_TO_PRODUCTION: 'IN_TRANSIT_TO_PRODUCTION',
  IN_PRODUCTION: 'IN_PRODUCTION',
  IN_TRANSIT_TO_STORE: 'IN_TRANSIT_TO_STORE',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  UNCLAIMED: 'UNCLAIMED',
  COMPLETED: 'COMPLETED',
  REFUSED: 'REFUSED',
  CANCELLED: 'CANCELLED',
  REWORK: 'REWORK',
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const ALL_ORDER_STATUSES: readonly OrderStatus[] = Object.values(ORDER_STATUS);

/** Этап жизненного цикла — используется для нормативов сроков и отчётности. */
export const ORDER_STAGE = {
  INTAKE: 'INTAKE',
  APPROVAL: 'APPROVAL',
  PREPAYMENT: 'PREPAYMENT',
  QUEUE: 'QUEUE',
  LOGISTICS_OUT: 'LOGISTICS_OUT',
  PRODUCTION: 'PRODUCTION',
  LOGISTICS_IN: 'LOGISTICS_IN',
  PICKUP: 'PICKUP',
  CLOSED: 'CLOSED',
} as const;

export type OrderStage = (typeof ORDER_STAGE)[keyof typeof ORDER_STAGE];

/** Соответствие «статус → этап». Этап определяет, по какому нормативу считать dueAt. */
export const STATUS_STAGE: Record<OrderStatus, OrderStage> = {
  DRAFT: ORDER_STAGE.INTAKE,
  AWAITING_APPROVAL: ORDER_STAGE.APPROVAL,
  AWAITING_PREPAYMENT: ORDER_STAGE.PREPAYMENT,
  ACCEPTED: ORDER_STAGE.INTAKE,
  QUEUED_FOR_DISPATCH: ORDER_STAGE.QUEUE,
  IN_TRANSIT_TO_PRODUCTION: ORDER_STAGE.LOGISTICS_OUT,
  IN_PRODUCTION: ORDER_STAGE.PRODUCTION,
  IN_TRANSIT_TO_STORE: ORDER_STAGE.LOGISTICS_IN,
  READY_FOR_PICKUP: ORDER_STAGE.PICKUP,
  UNCLAIMED: ORDER_STAGE.PICKUP,
  COMPLETED: ORDER_STAGE.CLOSED,
  REFUSED: ORDER_STAGE.CLOSED,
  CANCELLED: ORDER_STAGE.CLOSED,
  REWORK: ORDER_STAGE.PRODUCTION,
};

/** Терминальные статусы: заказ закрыт, переходы из них запрещены. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.REFUSED,
  ORDER_STATUS.CANCELLED,
];

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Статусы, в которых заказ считается «в работе» (для дашбордов и загрузки). */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ALL_ORDER_STATUSES.filter(
  (s) => !isTerminalStatus(s) && s !== ORDER_STATUS.DRAFT,
);

/** Статусы, в которых заказ физически находится в производстве. */
export const IN_PRODUCTION_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.IN_PRODUCTION,
  ORDER_STATUS.REWORK,
];

/** Статусы, в которых заказ находится на стороне магазина (можно выдать клиенту). */
export const AT_STORE_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.READY_FOR_PICKUP,
  ORDER_STATUS.UNCLAIMED,
];

/** Человекочитаемые названия для интерфейса. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  AWAITING_APPROVAL: 'Ожидает согласования',
  AWAITING_PREPAYMENT: 'Ожидает предоплату',
  ACCEPTED: 'Принят в работу',
  QUEUED_FOR_DISPATCH: 'В очереди на отправку',
  IN_TRANSIT_TO_PRODUCTION: 'В пути в цех',
  IN_PRODUCTION: 'В производстве',
  IN_TRANSIT_TO_STORE: 'В пути в магазин',
  READY_FOR_PICKUP: 'Готов к выдаче',
  UNCLAIMED: 'Невостребовано',
  COMPLETED: 'Выдан',
  REFUSED: 'Отказ от оплаты',
  CANCELLED: 'Отменён',
  REWORK: 'Доработка',
};

/**
 * Цветовая кодировка статусов для UI. Единый словарь, чтобы бейдж в списке
 * и в карточке заказа выглядели одинаково (docs/08-ui-ux.md §6).
 */
export const STATUS_COLORS: Record<OrderStatus, string> = {
  DRAFT: 'gray',
  AWAITING_APPROVAL: 'amber',
  AWAITING_PREPAYMENT: 'amber',
  ACCEPTED: 'blue',
  QUEUED_FOR_DISPATCH: 'blue',
  IN_TRANSIT_TO_PRODUCTION: 'violet',
  IN_PRODUCTION: 'cyan',
  IN_TRANSIT_TO_STORE: 'violet',
  READY_FOR_PICKUP: 'green',
  UNCLAIMED: 'orange',
  COMPLETED: 'emerald',
  REFUSED: 'red',
  CANCELLED: 'red',
  REWORK: 'cyan',
};

export function statusLabel(status: OrderStatus): string {
  return STATUS_LABELS[status];
}

export function statusColor(status: OrderStatus): string {
  return STATUS_COLORS[status];
}

/** Этап, к которому относится статус (для расчёта норматива). */
export function statusStage(status: OrderStatus): OrderStage {
  return STATUS_STAGE[status];
}