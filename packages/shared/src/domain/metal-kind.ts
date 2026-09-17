/**
 * Металлы прейскуранта.
 *
 * Утверждённый прейскурант заказчика («Прейскурант Ремонт.docx») задаёт для
 * каждой услуги ДВЕ цены — в колонке «Золото» и в колонке «Серебро». Поэтому
 * металл — не атрибут позиции, а измерение цены: одна и та же работа стоит
 * по-разному в зависимости от металла изделия.
 *
 * Константы объявлены здесь, а не только в схеме БД, потому что металл нужен
 * и API (выбор ставки), и интерфейсу (подписи в списке цен), и валидации
 * (схема приёма заказа). Расхождение между ними недопустимо: приёмщик увидел
 * бы одну подпись, а расчёт шёл бы по другой.
 */

export const METAL_KIND = {
  GOLD: 'GOLD',
  SILVER: 'SILVER',
  PLATINUM: 'PLATINUM',
} as const;

export type MetalKind = (typeof METAL_KIND)[keyof typeof METAL_KIND];

export const ALL_METAL_KINDS: readonly MetalKind[] = Object.values(METAL_KIND);

/** Подписи металлов для интерфейса — как в колонках прейскуранта. */
export const METAL_LABELS: Record<MetalKind, string> = {
  GOLD: 'Золото',
  SILVER: 'Серебро',
  // В документе цен на платину нет; подпись нужна на случай добавления ставок.
  PLATINUM: 'Платина',
};

/** Краткие обозначения для узких колонок (список работ в заказе). */
export const METAL_SHORT_LABELS: Record<MetalKind, string> = {
  GOLD: 'Зл',
  SILVER: 'Ср',
  PLATINUM: 'Пл',
};

/**
 * Металлы, по которым в прейскуранте реально заданы цены.
 *
 * Используется в интерфейсе, чтобы не предлагать приёмщику выбор металла,
 * для которого ни у одной позиции нет ставки: такой выбор всё равно привёл бы
 * к цене по умолчанию и ввёл бы в заблуждение.
 */
export const PRICED_METAL_KINDS: readonly MetalKind[] = [METAL_KIND.GOLD, METAL_KIND.SILVER];

/** Проверка, что строка — известный металл (для валидации входящих данных). */
export function isMetalKind(value: unknown): value is MetalKind {
  return typeof value === 'string' && (ALL_METAL_KINDS as readonly string[]).includes(value);
}

/**
 * Определить металл по свободному тексту.
 *
 * Приёмщик вводит металл изделия вручную («Золото 585», «Ag925», «золото»),
 * а прейскурант оперирует строгими кодами `GOLD`/`SILVER`. Без сопоставления
 * цена подбиралась бы всегда по умолчанию, то есть серебряное изделие
 * считалось бы по золотому тарифу — примерно вдвое дороже.
 *
 * Возвращает `null`, если металл не распознан: угадывать нельзя, потому что
 * ошибка здесь — это ошибка в деньгах клиента. Вызывающий код в этом случае
 * обязан показать цену по умолчанию и дать выбрать металл вручную.
 */
export function detectMetalKind(text: string | null | undefined): MetalKind | null {
  if (text === null || text === undefined) return null;
  const value = text.toLowerCase().trim();
  if (value === '') return null;

  /*
   * Химические символы (Au, Ag, Pt) ищутся как отдельное слово ИЛИ сразу перед
   * пробой: на практике пишут и «Au 585», и «Au585». При этом `includes('au')`
   * использовать нельзя — он сработал бы внутри слова («Paul», «Agnus»),
   * и серебряное изделие посчиталось бы по золотому тарифу. Регулярное
   * выражение требует границу слева и цифру/пробел/конец справа, поэтому
   * «Agreement» не распознаётся как серебро.
   */
  const hasChemSymbol = (symbol: string): boolean =>
    new RegExp(`(^|[^a-z])${symbol}(?=\\d|\\s|$)`).test(value);

  /*
   * Проба ищется как отдельное число, а не часть строки: «1585» — это не
   * золото 585. Разбиение по нецифровым/небуквенным символам даёт токены,
   * которые можно сравнить целиком.
   */
  const tokens = value.split(/[^a-zа-я0-9]+/u).filter((token) => token !== '');
  const hasToken = (...candidates: string[]): boolean =>
    tokens.some((token) => candidates.includes(token));

  // Платина/палладий проверяются раньше остальных: явный порядок нужен, чтобы
  // добавление синонимов не меняло результат разбора.
  if (value.includes('платин') || value.includes('pallad') || value.includes('паллад')) {
    return METAL_KIND.PLATINUM;
  }
  if (hasChemSymbol('pt')) return METAL_KIND.PLATINUM;

  if (
    value.includes('золот') ||
    value.includes('gold') ||
    hasChemSymbol('au') ||
    hasToken('585', '583', '375', '750', '916')
  ) {
    return METAL_KIND.GOLD;
  }

  if (
    value.includes('серебр') ||
    value.includes('silver') ||
    hasChemSymbol('ag') ||
    hasToken('925', '875', '960')
  ) {
    return METAL_KIND.SILVER;
  }

  return null;
}
