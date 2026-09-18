/**
 * Единый формат отчётов (ТЗ п. 2.11, docs/06 §6.1).
 *
 * ЗАЧЕМ ОБЩИЙ ФОРМАТ. Пять отчётов отвечают на разные вопросы, но показываются
 * одинаково: таблица с колонками и итогами. Если каждый отчёт вернёт свою форму,
 * фронтенд получит пять разных таблиц, экспорт в XLSX — пять веток кода, а
 * добавление шестого отчёта потребует правок во всех трёх местах.
 *
 * Поэтому отчёт — это `columns` + `rows` + `totals`, а типы колонок описаны
 * здесь же. Клиент рендерит ЛЮБОЙ отчёт одной компонентой, а экспорт делает
 * универсально.
 *
 * ПОЧЕМУ ТИПЫ КОЛОНОК ОБЪЯВЛЕНЫ, А НЕ ПЕРЕДАЮТСЯ СТРОКОЙ. `type: 'duration'`
 * говорит интерфейсу, что 62.4 — это часы, и их надо показать как «62,4 ч», а не
 * «62.4». Без этого числа пришлось бы форматировать на сервере, и выгрузка в
 * XLSX получила бы уже отформатированные строки: в Excel они стали бы текстом,
 * и по ним нельзя было бы считать сумму.
 */

/**
 * Отчёт: «сроки по этапам», «загрузка производства», «просрочки», «выручка»,
 * «предоплаты».
 *
 * Реестр закрыт, потому что имя отчёта — часть URL (`/reports/{name}`), и
 * произвольная строка означала бы поиск «отчёта вообще», которого нет.
 *
 * Имена совпадают с контрактом docs/07 §12: `/reports/deadlines`,
 * `/reports/production-load`. Совпадение обязательно — иначе документация и
 * код разойдутся, и интеграция пойдёт по несуществующему адресу.
 */
export const REPORT_NAME = {
  STAGE_DURATIONS: 'deadlines',
  WORKSHOP_LOAD: 'production-load',
  OVERDUE: 'overdue',
  REVENUE: 'revenue',
  PREPAYMENTS: 'prepayments',
} as const;

export type ReportName = (typeof REPORT_NAME)[keyof typeof REPORT_NAME];

/** Все имена отчётов — для проверки входного параметра и обхода в тестах. */
export const ALL_REPORT_NAMES: readonly ReportName[] = Object.values(REPORT_NAME);

/**
 * Тип колонки. Определяет форматирование на клиенте и в выгрузке.
 *
 *  * `string`   — текст;
 *  * `number`   — число;
 *  * `money`    — копейки: клиент делит на 100 и добавляет знак валюты;
 *  * `duration` — ЧАСЫ (не минуты): 62.4 показывается как «62,4 ч»;
 *  * `percent`  — доля от 0 до 1: 0.87 показывается как «87 %»;
 *  * `date`     — дата или момент времени.
 */
export const REPORT_COLUMN_TYPE = {
  STRING: 'string',
  NUMBER: 'number',
  MONEY: 'money',
  DURATION: 'duration',
  PERCENT: 'percent',
  DATE: 'date',
} as const;

export type ReportColumnType = (typeof REPORT_COLUMN_TYPE)[keyof typeof REPORT_COLUMN_TYPE];

/** Описание колонки отчёта. */
export interface ReportColumn {
  /** Ключ в строке данных. */
  key: string;
  /** Заголовок для интерфейса и выгрузки. */
  title: string;
  /** Как форматировать значение. */
  type: ReportColumnType;
}

/** Значение ячейки: `null` означает «нет данных» и показывается прочерком. */
export type ReportCell = string | number | null;

/** Строка отчёта: значения по ключам колонок. */
export type ReportRow = Record<string, ReportCell>;

/** Сведения о выборке: за какой период построен отчёт и сколько в нём строк. */
export interface ReportMeta {
  /** Начало периода в формате `ГГГГ-ММ-ДД`. */
  from: string;
  /** Конец периода в формате `ГГГГ-ММ-ДД` (включительно). */
  to: string;
  /** Момент построения отчёта. */
  generatedAt: string;
  /** Отдан ли результат из кэша. */
  cached: boolean;
  /** Число строк в `rows`. */
  rowCount: number;
}

/** Готовый отчёт. */
export interface ReportResult {
  meta: ReportMeta;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Итоги по отчёту: ключ — имя показателя, значение — число или текст. */
  totals: Record<string, ReportCell>;
}

/**
 * Разрезы отчётов (docs/06 §1–§5).
 *
 * Список общий для всех отчётов: отчёт сам решает, какие разрезы поддерживает, и
 * отвергает остальные. Общий перечень нужен, чтобы параметр `groupBy` проверялся
 * одинаково и опечатка (`storeId` вместо `store`) давала понятную ошибку, а не
 * молча возвращала негруппированный отчёт.
 */
export const REPORT_GROUP_BY = {
  STAGE: 'stage',
  STORE: 'store',
  WORKSHOP: 'workshop',
  PERFORMER: 'performer',
  WORK_TYPE: 'workType',
  PAYMENT_METHOD: 'paymentMethod',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
} as const;

export type ReportGroupBy = (typeof REPORT_GROUP_BY)[keyof typeof REPORT_GROUP_BY];

/**
 * Перцентиль по выборке (docs/06 §1).
 *
 * ЗАЧЕМ СВОЯ РЕАЛИЗАЦИЯ. Перцентиль нужен в трёх отчётах, а `percentile_cont`
 * в PostgreSQL доступен только как оконная или агрегатная функция в запросе —
 * то есть расчёт ушёл бы в SQL и стал недоступен для проверки. Значения этапов
 * уже отобраны и ограничены объёмом отчёта, поэтому сортировка в памяти дешевле,
 * чем отдельный запрос ради одной функции. Формула — та же линейная
 * интерполяция, что и в `percentile_cont`: результат совпадает с SQL.
 *
 * @param values значения; пустой массив — `null`, а не ноль: «нет данных» и
 *               «нулевая длительность» — разные вещи
 * @param fraction доля от 0 до 1 (0.5 — медиана, 0.9 — девяностый перцентиль)
 */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;

  // Позиция в отсортированном массиве: (n − 1) · p. Совпадает с `percentile_cont`,
  // где крайние значения не выходят за пределы выборки.
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  if (lowerIndex === upperIndex) return lower;

  return lower + (upper - lower) * (position - lowerIndex);
}

/**
 * Среднее арифметическое; пустая выборка — `null`.
 *
 * Ноль здесь был бы неверен: «в норме 0 %» и «данных нет» руководитель прочитает
 * по-разному, и первый вывод подтолкнул бы к разбору несуществующей проблемы.
 */
export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Доля значений, не превышающих норматив (docs/06 §1, «Доля в норме»).
 *
 * Значения без норматива в расчёт не входят: считать их «в норме» значило бы
 * улучшать показатель за счёт этапов, для которых норматива нет.
 */
export function inNormShare(
  pairs: readonly { durationHours: number; normHours: number | null }[],
): number | null {
  const comparable = pairs.filter((pair) => pair.normHours !== null);
  if (comparable.length === 0) return null;
  const inNorm = comparable.filter(
    (pair) => pair.durationHours <= (pair.normHours as number),
  ).length;
  return inNorm / comparable.length;
}

/**
 * Округлить до указанного числа знаков.
 *
 * ЗАЧЕМ. Отчёт уходит в JSON и в XLSX. Полная точность `62.400000000000006`
 * выглядит как дефект, а «62,4» — как результат. Округление делается на
 * сервере, чтобы клиент, выгрузка и тесты видели одно и то же число.
 */
export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Перевести минуты в часы.
 *
 * В отчётах время показывается в часах (docs/06 §1: «Среднее, ч»), а в базе
 * `durationMinutes` хранится в минутах. Перевод в одном месте не даёт одному
 * отчёту показать минуты, а другому часы.
 */
export function minutesToHours(minutes: number | null): number | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  return minutes / 60;
}
