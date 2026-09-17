/**
 * Выбор цены прейскуранта по металлу изделия.
 *
 * Утверждённый прейскурант заказчика задаёт для каждой услуги отдельную цену
 * по золоту и по серебру, поэтому цена — функция от (позиция, металл), а не
 * одно число. Логика выбора вынесена в общий пакет, потому что она нужна
 * в ДВУХ местах, и они обязаны совпадать:
 *   1. на сервере — при проверке цены, которую прислал клиент;
 *   2. в интерфейсе — при показе цены приёмщику.
 * Если бы правила разошлись, интерфейс показывал бы одну сумму, а сервер
 * принимал другую — расхождение в деньгах клиента.
 */

import { sumMinor, type Minor } from '../utils/money.js';
import { detectMetalKind } from '../domain/metal-kind.js';

/** Ставка позиции по конкретному металлу (как отдаёт API). */
export interface PriceRateLike {
  metal: string;
  priceMinor: Minor;
  isFrom?: boolean;
}

/** Позиция прейскуранта в объёме, достаточном для выбора цены. */
export interface PricedItemLike {
  priceMinor: Minor;
  priceFrom?: boolean;
  metalCostSeparate?: boolean;
  rates?: readonly PriceRateLike[] | null;
}

export interface ResolvedPrice {
  /** Цена в копейках: ставка по металлу либо цена по умолчанию. */
  priceMinor: Minor;
  /**
   * Цена минимальная («от»), итог уточняется.
   *
   * Важно: считается по ВЫБРАННОЙ ставке, а не по позиции целиком. Если у
   * позиции по золоту цена фиксированная, а по серебру «от», то для золотого
   * изделия результат — `false`.
   */
  isFrom: boolean;
  /** Цена взята из ставки по металлу, а не из значения по умолчанию. */
  fromMetalRate: boolean;
  /**
   * Металл не распознан или ставки по нему нет — применена цена по умолчанию.
   *
   * Признак нужен интерфейсу, чтобы показать предупреждение: молча подставить
   * цену по умолчанию опаснее, чем явно попросить уточнить металл.
   */
  usedFallback: boolean;
  /**
   * Стоимость металла в цену не входит и считается отдельно.
   */
  metalCostSeparate: boolean;
}

/**
 * Привести металл к коду (`GOLD`/`SILVER`/`PLATINUM`).
 *
 * Металл приходит из двух разных миров: в базе изделия он хранится свободным
 * текстом («Серебро 925», «Au585»), а ставки прейскуранта адресуются кодами.
 * Эта функция — единственное место, где они сводятся вместе.
 *
 * Почему нормализация внутри `resolveItemPrice`, а не у вызывающего кода:
 * сравнение свободного текста с кодом НИКОГДА не совпадает, но ошибка не
 * видна — просто незаметно применяется цена по умолчанию. Такой дефект уже
 * случался: сервер сравнивал «Серебро» с `SILVER`, поэтому серебряный заказ
 * считался по золотому тарифу, а проверка цены работала наоборот. Сводить
 * типы в одном месте надёжнее, чем полагаться на память вызывающих.
 */
function normalizeMetal(metal: string | null | undefined): string | null {
  if (metal === null || metal === undefined || metal === '') return null;
  // Точное совпадение с кодом проверяем первым: это быстрый путь и он же
  // защищает от того, что код случайно похож на другое слово.
  const upper = metal.toUpperCase();
  if (upper === 'GOLD' || upper === 'SILVER' || upper === 'PLATINUM') return upper;
  // Иначе — свободный текст: «Золото 585», «Ag925», «серебро».
  return detectMetalKind(metal);
}

/**
 * Подобрать цену позиции прейскуранта для указанного металла.
 *
 * Порядок выбора:
 *   1. ставка по указанному металлу — основной случай;
 *   2. цена по умолчанию (`priceMinor`) — если металл не указан, не распознан
 *      или ставки по нему нет. Так ведут себя позиции, у которых цена не
 *      зависит от металла (мойка в ультразвуке), и позиции без разбивки.
 *
 * `metal` принимает и код (`SILVER`), и свободный текст («Серебро 925») —
 * нормализация выполняется внутри, см. `normalizeMetal`.
 *
 * Возвращает не число, а объект: вызывающему коду почти всегда нужно знать
 * ещё и «от», и что цена взята по умолчанию, иначе он покажет неверную сумму
 * как окончательную.
 */
export function resolveItemPrice(
  item: PricedItemLike,
  metal: string | null | undefined,
): ResolvedPrice {
  const fallback: ResolvedPrice = {
    priceMinor: item.priceMinor,
    isFrom: item.priceFrom ?? false,
    fromMetalRate: false,
    usedFallback: true,
    metalCostSeparate: item.metalCostSeparate ?? false,
  };

  const normalized = normalizeMetal(metal);
  if (normalized === null) return fallback;

  const rate = item.rates?.find((candidate) => candidate.metal === normalized);
  if (rate === undefined) return fallback;

  return {
    priceMinor: rate.priceMinor,
    isFrom: rate.isFrom ?? false,
    fromMetalRate: true,
    // Ставка найдена — цена по умолчанию не использовалась, даже если
    // значения совпали: это разные причины, и предупреждать не о чем.
    usedFallback: false,
    metalCostSeparate: item.metalCostSeparate ?? false,
  };
}

/**
 * Стоимость работ по позициям прейскуранта с учётом металла.
 *
 * Нужна там, где работы выбираются из прейскуранта (мастер приёма), чтобы
 * итог считался по тем же правилам, что и на сервере.
 */
export function calcWorksTotalByMetal(
  works: readonly { item: PricedItemLike; metal?: string | null; quantity: number }[],
): Minor {
  return sumMinor(
    ...works.map(
      (work) => resolveItemPrice(work.item, work.metal).priceMinor * work.quantity,
    ),
  );
}