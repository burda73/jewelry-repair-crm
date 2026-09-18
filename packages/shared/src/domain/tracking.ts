/**
 * Отслеживание партии «в пути» (задача 2.6, ТЗ п. 2.6).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Партия уехала — и до момента приёмки о ней ничего не
 * известно. Логист не видит, какая машина ещё не доехала, а получатель не знает,
 * когда ждать. Изделия клиентов при этом нигде не «находятся»: в системе они
 * «в пути», и это состояние может длиться сколько угодно.
 *
 * ПОЧЕМУ НОРМАТИВ, А НЕ ПРОСТО ВРЕМЯ. Само по себе «в пути 6 часов» ничего не
 * значит: городской рейс и междугородний имеют разную норму. Смысл появляется
 * только в сравнении с ожидаемым временем доставки, поэтому функция возвращает
 * не голую длительность, а уровень тревоги относительно норматива.
 *
 * ПОЧЕМУ УРОВНИ, А НЕ ФЛАГ. Флаг «просрочено» загорается сразу и перестаёт
 * различать «опаздывает на 20 минут» и «пропала сутки назад». Три уровня дают
 * интерфейсу возможность показать сначала то, что требует вмешательства.
 */

/** Норматив доставки по умолчанию — 8 рабочих часов (один рабочий день). */
export const DEFAULT_TRANSIT_NORM_HOURS = 8;

/** Уровни тревоги по партии в пути. */
export const TRANSIT_LEVEL = {
  /** В пределах норматива. */
  ON_TIME: 'ON_TIME',
  /** Норматив превышен, но меньше чем вдвое — «задерживается». */
  LATE: 'LATE',
  /** Норматив превышен вдвое и более — «тревога», требует вмешательства. */
  OVERDUE: 'OVERDUE',
} as const;

export type TransitLevel = (typeof TRANSIT_LEVEL)[keyof typeof TRANSIT_LEVEL];

/** Состояние партии в пути на момент проверки. */
export interface TransitState {
  /** Сколько часов партия в пути. `null`, если она ещё не отправлена. */
  elapsedHours: number | null;
  /** Норматив, с которым сравнивали. */
  normHours: number;
  level: TransitLevel;
  /** Просрочена ли доставка (уровень `LATE` или `OVERDUE`). */
  isOverdue: boolean;
  /** Готовый текст для интерфейса и уведомления. */
  message: string;
}

/**
 * Оценить состояние партии в пути.
 *
 * @param dispatchedAt момент отправки; `null` — партия ещё не отправлена
 * @param now          момент проверки (передаётся явно, чтобы правило было
 *                     проверяемым без подмены системных часов)
 * @param normHours    норматив доставки в часах
 */
export function assessTransit(params: {
  dispatchedAt: Date | null;
  now: Date;
  normHours?: number;
}): TransitState {
  /*
   * Некорректный норматив (ноль, отрицательное, NaN) заменяется значением по
   * умолчанию. Иначе деление на него дало бы `Infinity`, и партия навсегда
   * осталась бы «в норме» — то есть тревога не сработала бы никогда. Значение
   * приходит из настройки, а настройку заполняет человек.
   */
  const norm =
    params.normHours !== undefined && Number.isFinite(params.normHours) && params.normHours > 0
      ? params.normHours
      : DEFAULT_TRANSIT_NORM_HOURS;

  if (params.dispatchedAt === null) {
    return {
      elapsedHours: null,
      normHours: norm,
      level: TRANSIT_LEVEL.ON_TIME,
      isOverdue: false,
      message: 'Партия ещё не отправлена',
    };
  }

  const elapsedMs = params.now.getTime() - params.dispatchedAt.getTime();

  /*
   * Отрицательная длительность означает, что отправка помечена будущим
   * временем (сбитые часы или ручная правка). Показывать «в пути −3 часа»
   * бессмысленно, поэтому значение обнуляется: партия только что отправлена.
   */
  const elapsedHours = Math.max(0, elapsedMs / 3_600_000);

  if (elapsedHours <= norm) {
    return {
      elapsedHours,
      normHours: norm,
      level: TRANSIT_LEVEL.ON_TIME,
      isOverdue: false,
      message: `В пути ${formatHours(elapsedHours)} — в пределах норматива`,
    };
  }

  const overdue = elapsedHours >= norm * 2;
  return {
    elapsedHours,
    normHours: norm,
    level: overdue ? TRANSIT_LEVEL.OVERDUE : TRANSIT_LEVEL.LATE,
    isOverdue: true,
    message: overdue
      ? `В пути ${formatHours(elapsedHours)} при норме ${formatHours(norm)} — доставка не подтверждена`
      : `В пути ${formatHours(elapsedHours)} при норме ${formatHours(norm)} — задерживается`,
  };
}

/**
 * Отформатировать часы по-русски.
 *
 * Часы показываются целыми, пока их меньше суток: «в пути 5 ч» понятнее, чем
 * «в пути 5,3 ч». Дольше суток — дни и часы, иначе «в пути 74 ч» приходится
 * пересчитывать в уме.
 */
export function formatHours(hours: number): string {
  if (hours < 24) return `${Math.floor(hours)} ч`;
  const days = Math.floor(hours / 24);
  const rest = Math.floor(hours % 24);
  return rest === 0 ? `${days} сут` : `${days} сут ${rest} ч`;
}

/**
 * Заказ ещё не доехал, хотя партия уже уехала.
 *
 * Используется получателем: показывает, какие позиции он ждёт. Отдельная
 * функция, потому что то же условие нужно интерфейсу для группировки, и
 * дублировать его там не следует.
 */
export function isOrderInTransit(orderStatus: string): boolean {
  return orderStatus === 'IN_TRANSIT_TO_PRODUCTION' || orderStatus === 'IN_TRANSIT_TO_STORE';
}
