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
  /**
   * Заказ физически в цехе; работа ещё не распределена.
   *
   * Сохраняется ради заказов, которые уже прошли приём цехом до введения
   * отдельных статусов производства (задача 7.1). Новые заказы идут через
   * `ACCEPTED_BY_WORKSHOP` → `IN_WORK` → `WORK_COMPLETED`.
   */
  IN_PRODUCTION: 'IN_PRODUCTION',
  /** Партия принята цехом: менеджер получил изделия и распределяет работу. */
  ACCEPTED_BY_WORKSHOP: 'ACCEPTED_BY_WORKSHOP',
  /** Исполнитель назначен, работа идёт. */
  IN_WORK: 'IN_WORK',
  /** Работа выполнена и принята менеджером: изделие готово к возврату. */
  WORK_COMPLETED: 'WORK_COMPLETED',
  IN_TRANSIT_TO_STORE: 'IN_TRANSIT_TO_STORE',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  UNCLAIMED: 'UNCLAIMED',
  COMPLETED: 'COMPLETED',
  /** Отказ от оплаты после выполненных работ (нужен акт отказа). */
  REFUSED: 'REFUSED',
  /**
   * Клиент отказался от ремонта ДО начала работ (дефект 67).
   *
   * Отдельный статус, а не `CANCELLED`: отмена — действие магазина по своей
   * инициативе, а здесь инициатива клиента, и изделие уже успело съездить в цех
   * и вернуться. Общий `CANCELLED` не позволял отличить «клиент передумал» от
   * «заказ отменён сотрудником», а главное — не был достижим: заказ возвращался
   * в магазин статусом «Готов к выдаче», из которого отмена не предусмотрена,
   * и закрыть отказ клиента было нечем.
   */
  REFUSED_BEFORE_WORK: 'REFUSED_BEFORE_WORK',
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
  ACCEPTED_BY_WORKSHOP: ORDER_STAGE.PRODUCTION,
  IN_WORK: ORDER_STAGE.PRODUCTION,
  WORK_COMPLETED: ORDER_STAGE.PRODUCTION,
  IN_TRANSIT_TO_STORE: ORDER_STAGE.LOGISTICS_IN,
  READY_FOR_PICKUP: ORDER_STAGE.PICKUP,
  UNCLAIMED: ORDER_STAGE.PICKUP,
  COMPLETED: ORDER_STAGE.CLOSED,
  REFUSED: ORDER_STAGE.CLOSED,
  REFUSED_BEFORE_WORK: ORDER_STAGE.CLOSED,
  CANCELLED: ORDER_STAGE.CLOSED,
  REWORK: ORDER_STAGE.PRODUCTION,
};

/** Терминальные статусы: заказ закрыт, переходы из них запрещены. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.REFUSED,
  ORDER_STATUS.REFUSED_BEFORE_WORK,
  ORDER_STATUS.CANCELLED,
];

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Статусы, в которых заказ считается «в работе» (для дашбордов и загрузки). */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ALL_ORDER_STATUSES.filter(
  (s) => !isTerminalStatus(s) && s !== ORDER_STATUS.DRAFT,
);

/**
 * Статусы, в которых заказ физически находится в производстве.
 *
 * `IN_PRODUCTION` сохранён в наборе наравне с новыми статусами: заказы,
 * принятые цехом до задачи 7.1, остаются в нём, и исключение его из набора
 * сделало бы их невидимыми для загрузки производства и отчётов.
 */
export const IN_PRODUCTION_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.IN_PRODUCTION,
  ORDER_STATUS.ACCEPTED_BY_WORKSHOP,
  ORDER_STATUS.IN_WORK,
  ORDER_STATUS.WORK_COMPLETED,
  ORDER_STATUS.REWORK,
];

/** Находится ли заказ в производстве (в цехе). */
export function isInProduction(status: OrderStatus): boolean {
  return IN_PRODUCTION_STATUSES.includes(status);
}

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
  ACCEPTED_BY_WORKSHOP: 'Принят цехом',
  IN_WORK: 'Выдано в работу',
  WORK_COMPLETED: 'Работы завершены',
  IN_TRANSIT_TO_STORE: 'В пути в магазин',
  READY_FOR_PICKUP: 'Готов к выдаче',
  UNCLAIMED: 'Невостребовано',
  COMPLETED: 'Выдан',
  REFUSED: 'Отказ от оплаты',
  REFUSED_BEFORE_WORK: 'Отказ до начала работ',
  CANCELLED: 'Отменён',
  REWORK: 'Доработка',
};

/**
 * Тона, которыми можно закодировать статус (docs/08-ui-ux.md §6).
 *
 * Тип-объединение, а НЕ `string`, и это существенно. Каждый тон превращается
 * компонентом `Badge` в конкретный набор классов Tailwind
 * (`bg-blue-100 text-blue-800 …`), а неизвестный тон молча даёт серый бейдж:
 * `TONES[tone]` вернёт `undefined`, склейка классов не изменится. С `string`
 * опечатка (`'gren'` вместо `'green'`) компилировалась бы без единой ошибки, и
 * готовый к выдаче заказ выглядел бы так же, как черновик — без всякого сигнала
 * о поломке. С объединением такая опечатка не собирается.
 *
 * Список обязан совпадать с ключами `TONES` в `apps/web/src/components/ui/badge.tsx`.
 * Совпадение проверяется тестом (`packages/shared/src/domain/order-status.spec.ts`).
 */
export type StatusTone =
  'gray' | 'amber' | 'blue' | 'violet' | 'cyan' | 'green' | 'orange' | 'emerald' | 'red' | 'slate';

/**
 * Цветовая кодировка статусов для UI. Единый словарь, чтобы бейдж в списке
 * и в карточке заказа выглядели одинаково (docs/08-ui-ux.md §6).
 */
export const STATUS_COLORS: Record<OrderStatus, StatusTone> = {
  DRAFT: 'gray',
  AWAITING_APPROVAL: 'amber',
  AWAITING_PREPAYMENT: 'amber',
  ACCEPTED: 'blue',
  QUEUED_FOR_DISPATCH: 'blue',
  IN_TRANSIT_TO_PRODUCTION: 'violet',
  IN_PRODUCTION: 'cyan',
  ACCEPTED_BY_WORKSHOP: 'cyan',
  IN_WORK: 'cyan',
  WORK_COMPLETED: 'cyan',
  IN_TRANSIT_TO_STORE: 'violet',
  READY_FOR_PICKUP: 'green',
  UNCLAIMED: 'orange',
  COMPLETED: 'emerald',
  REFUSED: 'red',
  REFUSED_BEFORE_WORK: 'red',
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

/**
 * Этапы, для которых задаются нормативы сроков (ТЗ п. 2.7).
 *
 * Набор шире `OrderStage`: сюда входят этапы, которым соответствует не статус
 * заказа, а отдельный процесс — рассмотрение рекламации (`CLAIM`, ТЗ п. 2.9).
 * Рекламация живёт в своей таблице `WarrantyClaim` и статуса заказа не имеет,
 * поэтому её норматив нельзя выразить через `STATUS_STAGE`, но он нужен
 * справочнику `StageNorm` и должен проверяться теми же правилами.
 */
export const NORM_STAGE = {
  APPROVAL: 'APPROVAL',
  PREPAYMENT: 'PREPAYMENT',
  QUEUE: 'QUEUE',
  LOGISTICS_OUT: 'LOGISTICS_OUT',
  PRODUCTION: 'PRODUCTION',
  LOGISTICS_IN: 'LOGISTICS_IN',
  PICKUP: 'PICKUP',
  CLAIM: 'CLAIM',
} as const;
export type NormStage = (typeof NORM_STAGE)[keyof typeof NORM_STAGE];
/**
 * Допустимые значения `StageNorm.stage` — единственный источник истины.
 *
 * ЗАЧЕМ ЭТА КОНСТАНТА. До неё существовали ТРИ несогласованных словаря этапов:
 * справочник заполнялся именами `DISPATCH`/`DELIVERY_OUT`/`DELIVERY_IN`/`STORAGE`,
 * домен объявлял `QUEUE`/`LOGISTICS_OUT`/`LOGISTICS_IN`/`PICKUP`, а расчёт
 * сроков искал норматив по имени СТАТУСА (`QUEUED_FOR_DISPATCH`,
 * `IN_PRODUCTION`). Ни одно из 13 значений не совпадало, поэтому норматив не
 * находился никогда и `dueAt` не устанавливался — при том что справочник был
 * заполнен, а тесты «проходили», потому что дублировали логику сервиса, а не
 * вызывали её.
 *
 * Проверка принадлежности набору превращает это в ошибку на входе: неизвестный
 * этап нельзя ни записать в справочник, ни молча не найти при расчёте.
 */
export const ALL_NORM_STAGES: readonly NormStage[] = Object.values(NORM_STAGE);
/**
 * Этап заказа по статусу — для расчёта нормативного срока.
 *
 * Терминальные статусы и `ACCEPTED` возвращают этап, у которого норматива нет
 * намеренно: закрытым заказам срок не считают, а «принят в работу» означает
 * готовность к передаче в производство, и его срок задаётся следующим этапом
 * (`QUEUE`). Возврат `null` здесь — это осознанное «срок не меняем», а не
 * потеря данных; расчёт обязан отличать его от «норматив не найден».
 */
export function stageForStatus(status: OrderStatus): OrderStage | null {
  const stage = STATUS_STAGE[status];
  return stage === ORDER_STAGE.CLOSED || stage === ORDER_STAGE.INTAKE ? null : stage;
}
/** Норматив этапа так, как он хранится в справочнике `StageNorm`. */
export interface StageNormLike {
  stage: string;
  workType: string;
  value: number;
  unit: string;
}
/**
 * Выбор норматива для этапа и типа работ.
 *
 * Вынесено в домен, чтобы у правила был ОДИН владелец. Раньше эту логику
 * дублировал тест `stage-norms.spec.ts`: он проверял собственную копию, а не
 * код сервиса, и потому «проходил» в то время, как сервис искал норматив по
 * имени статуса и не находил ничего. Тест, проверяющий копию, не защищает от
 * расхождения копии с оригиналом — он его и создаёт.
 *
 * Конкретный тип работ приоритетнее общего (`ANY`): для сложного ремонта
 * должен применяться его норматив, а не общий срок этапа.
 */
export function pickStageNorm<T extends StageNormLike>(
  norms: readonly T[],
  stage: string,
  workType: string | null,
): T | null {
  const candidates = norms.filter(
    (norm) =>
      norm.stage === stage &&
      (workType === null
        ? norm.workType === 'ANY'
        : norm.workType === workType || norm.workType === 'ANY'),
  );
  if (candidates.length === 0) return null;
  return candidates.find((norm) => norm.workType === workType) ?? candidates[0] ?? null;
}
