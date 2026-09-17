/**
 * Сверка прейскуранта в коде с утверждённым документом заказчика.
 *
 * Зачем этот тест: цены — юридически значимые данные. При переносе 24 позиций
 * из «Прейскурант Ремонт.docx» легко ошибиться на порядок (900 против 9000)
 * или потерять признак «от». Такая ошибка не ломает сборку и не видна в
 * интерфейсе — она просто выставляет клиенту неверную сумму.
 *
 * Базис (`docs/reference/price-list-baseline.json`) извлечён из самого файла
 * .docx, а не набран вручную: документ лежит рядом
 * (`docs/reference/Прейскурант-Ремонт-утверждённый.docx`), так что проверку
 * можно повторить и убедиться, что базис не подогнан под код.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METAL_KIND } from '@app/shared';
import {
  PRICE_LIST_CATEGORIES,
  PRICE_LIST_POSITION_COUNT,
  PRICE_LIST_POSITIONS,
} from './price-list-spec.js';

const here = dirname(fileURLToPath(import.meta.url));
// Файл лежит в `packages/db/prisma/`, поэтому до корня репозитория — три уровня.
const repoRoot = resolve(here, '../../..');
const baselinePath = resolve(repoRoot, 'docs/reference/price-list-baseline.json');

interface BaselinePosition {
  position: number;
  name: string;
  goldMinor: number | null;
  silverMinor: number | null;
  goldFrom: boolean;
  silverFrom: boolean;
  metalCostSeparate: boolean;
}

interface Baseline {
  positions: BaselinePosition[];
}

const baseline: Baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;

describe('Прейскурант: сверка с утверждённым документом', () => {
  it('число позиций совпадает с документом', () => {
    expect(PRICE_LIST_POSITIONS).toHaveLength(PRICE_LIST_POSITION_COUNT);
    expect(baseline.positions).toHaveLength(PRICE_LIST_POSITION_COUNT);
  });

  it('каждой позиции документа соответствует позиция в коде (по номеру)', () => {
    const byPosition = new Map(PRICE_LIST_POSITIONS.map((p) => [p.position, p]));
    for (const doc of baseline.positions) {
      expect(byPosition.has(doc.position), `нет позиции ${doc.position} (${doc.name})`).toBe(true);
    }
    // Обратная проверка: в коде нет позиции, которой нет в документе.
    const docPositions = new Set(baseline.positions.map((p) => p.position));
    for (const item of PRICE_LIST_POSITIONS) {
      expect(docPositions.has(item.position), `лишняя позиция ${item.position}`).toBe(true);
    }
  });

  it('названия совпадают посимвольно', () => {
    // Название печатается в квитанции, поэтому расхождение с документом —
    // это расхождение в юридическом тексте, а не косметика.
    const byPosition = new Map(PRICE_LIST_POSITIONS.map((p) => [p.position, p]));
    for (const doc of baseline.positions) {
      const item = byPosition.get(doc.position);
      expect(item?.name, `позиция ${doc.position}`).toBe(doc.name);
    }
  });

  it('цены по золоту и серебру совпадают с документом', () => {
    for (const doc of baseline.positions) {
      const item = PRICE_LIST_POSITIONS.find((p) => p.position === doc.position);
      expect(item, `позиция ${doc.position}`).toBeDefined();

      const gold = item?.rates.find((r) => r.metal === METAL_KIND.GOLD);
      const silver = item?.rates.find((r) => r.metal === METAL_KIND.SILVER);

      expect(gold, `нет цены по золоту, позиция ${doc.position}`).toBeDefined();
      expect(silver, `нет цены по серебру, позиция ${doc.position}`).toBeDefined();
      expect(gold?.priceMinor, `золото, позиция ${doc.position} (${doc.name})`).toBe(doc.goldMinor);
      expect(silver?.priceMinor, `серебро, позиция ${doc.position} (${doc.name})`).toBe(doc.silverMinor);
    }
  });

  it('признак «от» определяется по колонке цены, а не по названию', () => {
    /*
     * Ключевая проверка. В документе есть позиция 6, у которой слово «от»
     * стоит в НАЗВАНИИ («от 0,5 размера»), но цена фиксированная. Если бы
     * признак брался из названия, позиция ошибочно стала бы «от».
     * И наоборот, позиция 18 «Правка кольца без обработки и полировки»
     * названия с «от» не содержит, но цена — «от 525».
     */
    for (const doc of baseline.positions) {
      const item = PRICE_LIST_POSITIONS.find((p) => p.position === doc.position);
      const gold = item?.rates.find((r) => r.metal === METAL_KIND.GOLD);
      const silver = item?.rates.find((r) => r.metal === METAL_KIND.SILVER);

      expect(gold?.isFrom, `«от» по золоту, позиция ${doc.position} (${doc.name})`).toBe(doc.goldFrom);
      expect(silver?.isFrom, `«от» по серебру, позиция ${doc.position} (${doc.name})`).toBe(doc.silverFrom);
    }
  });

  it('позиция 6 не помечена как «от», хотя слово «от» есть в названии', () => {
    // Явная фиксация ловушки: тест должен падать, если кто-то «поправит»
    // признак, ориентируясь на название.
    const pos6 = PRICE_LIST_POSITIONS.find((p) => p.position === 6);
    expect(pos6?.name).toContain('от 0,5 размера');
    expect(pos6?.rates.every((r) => r.isFrom)).toBe(false);
  });

  it('признак «стоимость металла отдельно» совпадает с документом', () => {
    for (const doc of baseline.positions) {
      const item = PRICE_LIST_POSITIONS.find((p) => p.position === doc.position);
      expect(item?.metalCostSeparate, `металл отдельно, позиция ${doc.position} (${doc.name})`).toBe(
        doc.metalCostSeparate,
      );
    }
  });

  it('позиция 24 — и «от», и отдельный металл одновременно', () => {
    // Признаки независимы; позиция, где они встречаются вместе, легко
    // потерять при рефакторинге, если считать их взаимоисключающими.
    const pos24 = PRICE_LIST_POSITIONS.find((p) => p.position === 24);
    expect(pos24?.rates.every((r) => r.isFrom)).toBe(true);
    expect(pos24?.metalCostSeparate).toBe(true);
  });

  it('в документе ровно 5 позиций «от» и 3 с отдельным металлом', () => {
    // Контрольные числа, чтобы базис не «поехал» незаметно.
    const fromCount = baseline.positions.filter((p) => p.goldFrom || p.silverFrom).length;
    const metalCount = baseline.positions.filter((p) => p.metalCostSeparate).length;
    expect(fromCount).toBe(5);
    expect(metalCount).toBe(3);
  });

  it('у каждой позиции цена по золоту не ниже цены по серебру', () => {
    /*
     * Не косметика: золото дороже серебра в каждой строке документа. Если
     * цены перепутаны местами при переносе, это свойство нарушится — а глазами
     * такую ошибку в 24 строках почти невозможно заметить.
     */
    for (const item of PRICE_LIST_POSITIONS) {
      const gold = item.rates.find((r) => r.metal === METAL_KIND.GOLD);
      const silver = item.rates.find((r) => r.metal === METAL_KIND.SILVER);
      expect(
        (gold?.priceMinor ?? 0) >= (silver?.priceMinor ?? 0),
        `позиция ${item.position}: золото ${gold?.priceMinor} < серебро ${silver?.priceMinor}`,
      ).toBe(true);
    }
  });

  it('артикулы уникальны и у каждой позиции есть ставки по металлам', () => {
    const codes = PRICE_LIST_POSITIONS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const item of PRICE_LIST_POSITIONS) {
      expect(item.rates.length, `позиция ${item.position}`).toBeGreaterThan(0);
      // Дубль металла сделал бы цену недетерминированной.
      const metals = item.rates.map((r) => r.metal);
      expect(new Set(metals).size).toBe(metals.length);
    }
  });

  it('цены указаны в копейках (целые, не дробные)', () => {
    for (const item of PRICE_LIST_POSITIONS) {
      for (const rate of item.rates) {
        expect(Number.isSafeInteger(rate.priceMinor), `позиция ${item.position}`).toBe(true);
        expect(rate.priceMinor).toBeGreaterThan(0);
      }
    }
  });

  it('нет пустых категорий и все ссылки на категории существуют', () => {
    /*
     * Пустая категория — это лишняя строка в фильтре мастера приёма: приёмщик
     * выбирает её и видит пустой список. Такое появляется при перегруппировке
     * позиций и глазами не заметно, поэтому проверяем автоматически.
     */
    const used = new Set(PRICE_LIST_POSITIONS.map((p) => p.category));
    const declared = new Set(PRICE_LIST_CATEGORIES.map((c) => c.code));

    for (const code of used) {
      expect(declared.has(code), `позиция ссылается на неизвестную категорию ${code}`).toBe(true);
    }
    for (const category of PRICE_LIST_CATEGORIES) {
      expect(used.has(category.code), `категория ${category.code} не содержит ни одной позиции`).toBe(true);
    }
  });

  it('единица «грамм» только у работ, тарифицируемых по весу', () => {
    // Тарификация по граммам — исключение (покрытие). Если «грамм» появится
    // у обычной работы, приёмщик введёт вес вместо количества штук, и сумма
    // окажется неверной на порядки.
    const gramPositions = PRICE_LIST_POSITIONS.filter((p) => p.unit === 'грамм');
    expect(gramPositions.map((p) => p.position).sort((a, b) => a - b)).toEqual([21, 22, 23]);
    for (const item of PRICE_LIST_POSITIONS) {
      if (item.unit === 'грамм') {
        expect(item.name).toContain('за гр');
      }
    }
  });
});
