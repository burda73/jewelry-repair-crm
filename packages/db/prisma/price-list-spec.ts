/**
 * Утверждённый прейскурант заказчика — единственный источник этих данных.
 *
 * Источник: «Прейскурант Ремонт.docx», 24 позиции, две колонки цен
 * («Золото» / «Серебро»). Файл прислан заказчиком как утверждённый, поэтому
 * данные не выдуманы и не округлены: цены перенесены посимвольно.
 *
 * Почему отдельный файл, а не массив внутри `seed.ts`:
 *   1. Это юридически значимые цены. Их нужно сверять глазами с документом,
 *      а не выискивать среди кода создания демо-заказа.
 *   2. У прейскуранта есть `spec.test.ts` — тест сверяет число позиций, наличие
 *      двух цен у каждой и признаки «от»/«металл отдельно» с тем, что
 *      реально в документе. Без отдельного модуля такой тест не написать.
 *
 * ВАЖНО про «от» и «металл отдельно»:
 *   - Признак `isFrom` определяется по ЯЧЕЙКЕ ЦЕНЫ, а не по названию.
 *     В названии «Пайка протеров в серьгах» слова «от» нет, но в названии
 *     «Уменьшение/увеличение классического кольца от 0,5 размера» оно есть —
 *     и относится к РАЗМЕРУ, а цена фиксированная (1425/825). Если бы признак
 *     брался из названия, эта позиция ошибочно стала бы «от».
 *   - Позиция 24 («Переделка серьги в кольцо») одновременно «от» и требует
 *     отдельного расчёта металла — оба признака независимы и могут стоять
 *     на одной позиции.
 */

import { METAL_KIND, type MetalKind } from '@app/shared';

export interface PriceListRateSpec {
  metal: MetalKind;
  /** Цена в копейках (в документе — рубли). */
  priceMinor: number;
  /** В колонке этого металла стоит «от». */
  isFrom: boolean;
}

/** Категории работ. Названия — из документа, сгруппированы по смыслу. */
export const PRICE_LIST_CATEGORIES = [
  { code: 'SOLDER', name: 'Пайка', sortOrder: 1 },
  { code: 'SETTING', name: 'Закрепка камней', sortOrder: 2 },
  { code: 'RESIZE', name: 'Изменение размера', sortOrder: 3 },
  { code: 'LOCK', name: 'Замки и механизмы', sortOrder: 4 },
  { code: 'POLISH', name: 'Полировка и чистка', sortOrder: 5 },
  { code: 'COATING', name: 'Покрытие (родирование, золочение)', sortOrder: 6 },
  { code: 'RESTORE', name: 'Переделка и реставрация', sortOrder: 7 },
] as const;

/**
 * Код категории — объединение фактически объявленных кодов.
 *
 * Тип, а не `string`: опечатка в категории позиции («POLISh», «SETTINGS»)
 * становится ошибкой компиляции, а не пустой категорией в интерфейсе,
 * которую замечают только на приёме. Дополнительно это гарантирует, что
 * каждая позиция ссылается на существующую категорию.
 */
export type PriceListCategoryCode = (typeof PRICE_LIST_CATEGORIES)[number]['code'];

export interface PriceListPositionSpec {
  /**
   * Артикул. Соответствует номеру позиции в документе, чтобы сверка была
   * однозначной: строка 15 документа ↔ `PRICE-15`. Придумывать смысловые
   * коды здесь опаснее, чем нумерацию: она не разойдётся с документом.
   */
  code: string;
  /** Номер позиции в прейскуранте (для сверки и для теста). */
  position: number;
  name: string;
  category: PriceListCategoryCode;
  /** Единица измерения: почти везде «шт», обработка покрытия — «грамм». */
  unit: string;
  rates: PriceListRateSpec[];
  /** Стоимость металла в цену не входит и считается отдельно. */
  metalCostSeparate: boolean;
  durationHours: number;
  warrantyMonths: number;
  requiresPrepayment: boolean;
}

/** Сокращение: ставка «Золото / Серебро» без «от». */
function fixed(gold: number, silver: number): PriceListRateSpec[] {
  return [
    { metal: METAL_KIND.GOLD, priceMinor: gold, isFrom: false },
    { metal: METAL_KIND.SILVER, priceMinor: silver, isFrom: false },
  ];
}

/** Ставка, где у обоих металлов указано «от». */
function from(gold: number, silver: number): PriceListRateSpec[] {
  return [
    { metal: METAL_KIND.GOLD, priceMinor: gold, isFrom: true },
    { metal: METAL_KIND.SILVER, priceMinor: silver, isFrom: true },
  ];
}

/**
 * 24 позиции прейскуранта.
 *
 * Нормативы трудоёмкости (`durationHours`) и необходимость предоплаты в
 * документе НЕ указаны — по ответу A3 утверждённых нормативов сроков нет.
 * Значения проставлены как стартовые и подлежат корректировке руководителем
 * (см. `docs/00-decisions.md` §6.11). Предоплата выставлена там, где работа
 * дорогая или требует закупки металла: замок коробка, замена штифта,
 * переделка серьги, пайка протеров, изготовление крапана.
 *
 * `warrantyMonths`: по ТЗ п. 2.9 — 3 месяца для закрепки, иначе 6.
 * Позиции 10–12 (раскрепка/закрепка) поэтому имеют гарантию 3 месяца.
 */
export const PRICE_LIST_POSITIONS: readonly PriceListPositionSpec[] = [
  {
    code: 'PRICE-1',
    position: 1,
    name: 'Запаять одно место излома цепи, браслета',
    category: 'SOLDER',
    unit: 'шт',
    rates: fixed(90000, 45000),
    metalCostSeparate: false,
    durationHours: 1,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-2',
    position: 2,
    name: 'Запаять одно место излома цепи, браслета (лазер)',
    category: 'SOLDER',
    unit: 'шт',
    rates: fixed(270000, 150000),
    metalCostSeparate: false,
    durationHours: 1,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-3',
    position: 3,
    name: 'Запаять одно место в кольце, броши, серьге',
    category: 'SOLDER',
    unit: 'шт',
    rates: fixed(112500, 75000),
    metalCostSeparate: false,
    durationHours: 2,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-4',
    position: 4,
    name: 'Пайка протеров в серьгах',
    category: 'SOLDER',
    unit: 'шт',
    rates: fixed(450000, 270000),
    metalCostSeparate: false,
    durationHours: 3,
    warrantyMonths: 6,
    requiresPrepayment: true,
  },
  {
    code: 'PRICE-5',
    position: 5,
    name: 'Пайка протеров в кулоне',
    category: 'SOLDER',
    unit: 'шт',
    rates: fixed(270000, 135000),
    metalCostSeparate: false,
    durationHours: 3,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-6',
    position: 6,
    // В названии есть «от 0,5 размера», но это про РАЗМЕР, а не про цену:
    // в колонках цен стоят фиксированные 1425/825.
    name: 'Уменьшение/увеличение классического кольца от 0,5 размера путем растяжения/сжатия',
    category: 'RESIZE',
    unit: 'шт',
    rates: fixed(142500, 82500),
    metalCostSeparate: false,
    durationHours: 2,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-7',
    position: 7,
    name: 'Увеличение кольца со вставкой (с добавлением вставки из золота на один размер)',
    category: 'RESIZE',
    unit: 'шт',
    rates: fixed(360000, 165000),
    metalCostSeparate: false,
    durationHours: 4,
    warrantyMonths: 6,
    requiresPrepayment: true,
  },
  {
    code: 'PRICE-8',
    position: 8,
    name: 'Уменьшение кольца путем вырезки',
    category: 'RESIZE',
    unit: 'шт',
    rates: fixed(210000, 105000),
    metalCostSeparate: false,
    durationHours: 3,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-9',
    position: 9,
    name: 'Изготовление крапана 1 шт.',
    category: 'SETTING',
    unit: 'шт',
    rates: fixed(180000, 90000),
    metalCostSeparate: false,
    durationHours: 4,
    warrantyMonths: 3,
    requiresPrepayment: true,
  },
  {
    code: 'PRICE-10',
    position: 10,
    name: 'Раскрепка камней без сохранения',
    category: 'SETTING',
    unit: 'шт',
    rates: from(7500, 7500),
    metalCostSeparate: false,
    durationHours: 1,
    warrantyMonths: 3,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-11',
    position: 11,
    name: 'Закрепка фианитов круг до 3мм',
    category: 'SETTING',
    unit: 'шт',
    rates: fixed(37500, 37500),
    metalCostSeparate: false,
    durationHours: 1,
    warrantyMonths: 3,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-12',
    position: 12,
    name: 'Закрепка бриллиантов до 1,5 мм (простая)',
    category: 'SETTING',
    unit: 'шт',
    rates: fixed(52500, 52500),
    metalCostSeparate: false,
    durationHours: 1,
    warrantyMonths: 3,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-13',
    position: 13,
    name: 'Мойка изделия в ультразвуке 1 шт.',
    category: 'POLISH',
    unit: 'шт',
    // Цена одинакова для обоих металлов: мойка не зависит от металла.
    rates: fixed(30000, 30000),
    metalCostSeparate: false,
    durationHours: 1,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-14',
    position: 14,
    name: 'Ремонт замка, карабин',
    category: 'LOCK',
    unit: 'шт',
    rates: fixed(180000, 90000),
    metalCostSeparate: false,
    durationHours: 3,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-15',
    position: 15,
    name: 'Изготовление и установка замка коробка (стоимость металла считается отдельно)',
    category: 'LOCK',
    unit: 'шт',
    rates: fixed(450000, 300000),
    metalCostSeparate: true,
    durationHours: 6,
    warrantyMonths: 6,
    requiresPrepayment: true,
  },
  {
    code: 'PRICE-16',
    position: 16,
    name: 'Изготовление замка, карабин (до 0,35 гр.)',
    category: 'LOCK',
    unit: 'шт',
    rates: fixed(540000, 112500),
    metalCostSeparate: false,
    durationHours: 5,
    warrantyMonths: 6,
    requiresPrepayment: true,
  },
  {
    code: 'PRICE-17',
    position: 17,
    name: 'Замена изношенного штифта 1 шт. (стоимость разницы металла считается отдельно)',
    category: 'LOCK',
    unit: 'шт',
    rates: fixed(360000, 165000),
    metalCostSeparate: true,
    durationHours: 4,
    warrantyMonths: 6,
    requiresPrepayment: true,
  },
  {
    code: 'PRICE-18',
    position: 18,
    name: 'Правка кольца без обработки и полировки',
    category: 'RESIZE',
    unit: 'шт',
    rates: from(52500, 30000),
    metalCostSeparate: false,
    durationHours: 1,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-19',
    position: 19,
    name: 'Полировка кольца, кулона, броши',
    category: 'POLISH',
    unit: 'шт',
    rates: from(112500, 75000),
    metalCostSeparate: false,
    durationHours: 2,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-20',
    position: 20,
    name: 'Полировка браслета',
    category: 'POLISH',
    unit: 'шт',
    rates: from(180000, 75000),
    metalCostSeparate: false,
    durationHours: 3,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-21',
    position: 21,
    name: 'Родирование путем погружения, за гр.',
    category: 'COATING',
    // Тарифицируется за грамм — важно для расчёта: приёмщик указывает вес.
    unit: 'грамм',
    rates: fixed(50000, 50000),
    metalCostSeparate: false,
    durationHours: 2,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-22',
    position: 22,
    name: 'Родирование карандашом (отдельных деталей), за гр.',
    category: 'COATING',
    unit: 'грамм',
    rates: fixed(50000, 50000),
    metalCostSeparate: false,
    durationHours: 2,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-23',
    position: 23,
    name: 'Золочение, за гр.',
    category: 'COATING',
    unit: 'грамм',
    rates: fixed(35000, 35000),
    metalCostSeparate: false,
    durationHours: 2,
    warrantyMonths: 6,
    requiresPrepayment: false,
  },
  {
    code: 'PRICE-24',
    position: 24,
    name: 'Переделка серьги в кольцо (стоимость металла считается отдельно)',
    category: 'RESTORE',
    unit: 'шт',
    // Единственная позиция, где одновременно «от» и отдельный металл.
    rates: from(300000, 225000),
    metalCostSeparate: true,
    durationHours: 8,
    warrantyMonths: 6,
    requiresPrepayment: true,
  },
] as const;

/** Число позиций в документе — используется тестом сверки. */
export const PRICE_LIST_POSITION_COUNT = 24;
