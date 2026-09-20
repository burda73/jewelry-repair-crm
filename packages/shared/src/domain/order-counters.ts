import { ORDER_STATUS, IN_PRODUCTION_STATUSES, type OrderStatus } from './order-status.js';

/**
 * Статусы, которые в счётчик «просрочено» не попадают.
 *
 * `DRAFT` и `ACCEPTED` — заказ ещё не в производстве, срок по нему не начал
 * идти. `AWAITING_PREPAYMENT` ждёт клиента, а не сотрудника: напоминать
 * некому. Терминальные закрыты, и просрочки у них быть не может.
 *
 * Константа живёт в домене, а не в каждом сервисе отдельно, именно из-за
 * требования «одна просрочка — одно число»: дашборд, отчёт, воркер эскалаций и
 * список заказов обязаны исключать один и тот же набор. Когда эти списки были
 * скопированы по файлам, счётчик и список расходились: карточка «Просрочено: 5»
 * вела в список из 12 заказов, потому что список не исключал закрытые.
 */
export const OVERDUE_EXCLUDED_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.DRAFT,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.AWAITING_PREPAYMENT,
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.REFUSED,
  ORDER_STATUS.REFUSED_BEFORE_WORK,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.UNCLAIMED,
];

/**
 * Статусы «заказ в пути»: изделие едет между магазином и цехом.
 *
 * `QUEUED_FOR_DISPATCH` включён намеренно: заказ уже ждёт рейса, и менеджер
 * производства видит его в той же очереди, что и фактически уехавшие.
 */
export const IN_TRANSIT_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.QUEUED_FOR_DISPATCH,
  ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
  ORDER_STATUS.IN_TRANSIT_TO_STORE,
];

/**
 * Фильтр списка заказов, соответствующий счётчику дашборда.
 *
 * Ровно те поля, которые понимает `GET /orders` и адрес страницы `/orders`.
 */
export interface CounterFilter {
  readonly status?: readonly OrderStatus[];
  readonly overdue?: boolean;
}

/** Ключи счётчиков сводки — совпадают с полями ответа `GET /orders/summary`. */
export type DashboardCounterKey =
  | 'total'
  | 'inProduction'
  | 'readyForPickup'
  | 'overdue'
  | 'awaitingPrepayment'
  | 'unclaimed'
  | 'awaitingApproval'
  | 'inTransit';

/** Описание одного блока «Обзор»: ключ счётчика и фильтр списка за ним. */
export interface DashboardCounter {
  readonly key: DashboardCounterKey;
  /**
   * Фильтр, которым этот показатель открывается в списке заказов.
   *
   * ОДНО описание на сервер и на интерфейс: сервер по нему считает число,
   * клиент по нему строит ссылку. Разойтись они не могут — а расхождение здесь
   * означало бы, что клик по карточке открывает не то число, которое на ней
   * написано. Именно так и было до этой правки: счётчик «просрочено» исключал
   * закрытые заказы, а список по ссылке `?overdue=true` — нет.
   *
   * Подписи и цвета здесь НЕ лежат: это оформление, и его место в интерфейсе
   * рядом с переводами. Проверяет их TypeScript — карта подписей объявлена как
   * `Record<DashboardCounterKey, …>`, поэтому забытая подпись не соберётся.
   */
  readonly filter: CounterFilter;
}

/**
 * Блоки раздела «Обзор» в порядке отображения.
 *
 * Порядок — часть контракта: экран не должен переставляться от того, что числа
 * пришли в другом порядке.
 */
export const DASHBOARD_COUNTERS: readonly DashboardCounter[] = [
  { key: 'total', filter: {} },
  { key: 'inProduction', filter: { status: IN_PRODUCTION_STATUSES } },
  { key: 'readyForPickup', filter: { status: [ORDER_STATUS.READY_FOR_PICKUP] } },
  // Красный тон выставляется интерфейсом: только при ненулевой просрочке.
  { key: 'overdue', filter: { overdue: true } },
  { key: 'awaitingPrepayment', filter: { status: [ORDER_STATUS.AWAITING_PREPAYMENT] } },
  { key: 'unclaimed', filter: { status: [ORDER_STATUS.UNCLAIMED] } },
  { key: 'awaitingApproval', filter: { status: [ORDER_STATUS.AWAITING_APPROVAL] } },
  { key: 'inTransit', filter: { status: IN_TRANSIT_STATUSES } },
];

/**
 * Собрать адрес списка заказов по фильтру счётчика.
 *
 * Живёт в домене, а не в компоненте: адрес — это контракт между карточкой и
 * экраном списка, и его формат (`status=A,B`) разбирает `queryToFilters`.
 * Собранный здесь адрес обязан читаться тем же разбором.
 */
export function counterListHref(filter: CounterFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined && filter.status.length > 0) {
    params.set('status', filter.status.join(','));
  }
  if (filter.overdue === true) params.set('overdue', 'true');
  const query = params.toString();
  return query === '' ? '/orders' : `/orders?${query}`;
}
/** Значение счётчика «Просрочено» и полный набор по статусам. */
export interface SummarySource {
  /** Всего заказов в области видимости. */
  readonly total: number;
  /** Количество по каждому статусу; отсутствующий статус — ноль. */
  readonly byStatus: ReadonlyMap<OrderStatus, number>;
  /**
   * Число просроченных заказов.
   *
   * Считается отдельно, а не по статусам: «просрочено» — это пересечение
   * условия `dueAt < now` с набором `OVERDUE_EXCLUDED_STATUSES`, и из разбивки
   * по статусам его не вывести.
   */
  readonly overdue: number;
}

/** Ответ `GET /orders/summary` в форме, которую ждёт дашборд. */
export type OrderSummaryCounts = Record<DashboardCounterKey, number>;

/**
 * Собрать сводку из посчитанных чисел.
 *
 * Функция существует ради одного свойства: число на карточке и фильтр ссылки с
 * этой карточки берутся из ОДНОГО описания (`DASHBOARD_COUNTERS`), поэтому
 * «показано 5» и «открылось 5» — не совпадение, а следствие общей таблицы.
 * Раньше счётчик и список считались независимо, и на «просрочено» они
 * разошлись: карточка исключала закрытые заказы, а список — нет.
 *
 * Функция чистая: ни Prisma, ни дат. Поэтому она проверяется тестом на любых
 * числах, а сервису остаётся только посчитать `byStatus` и `overdue`.
 */
export function summaryFromCounts(source: SummarySource): OrderSummaryCounts {
  const countOf = (filter: CounterFilter): number => {
    if (filter.overdue === true) return source.overdue;
    if (filter.status === undefined || filter.status.length === 0) return source.total;
    return filter.status.reduce((sum, status) => sum + (source.byStatus.get(status) ?? 0), 0);
  };

  const result = {} as Record<string, number>;
  for (const counter of DASHBOARD_COUNTERS) {
    result[counter.key] = countOf(counter.filter);
  }
  return result as OrderSummaryCounts;
}
