/**
 * Проверка распознавания металла по свободному тексту.
 *
 * Функция влияет на деньги: если серебряное изделие распознать как золотое,
 * клиенту выставят примерно вдвое большую цену по прейскуранту. Поэтому
 * проверяются не только очевидные случаи, но и ловушки подстрок.
 */

import { describe, expect, it } from 'vitest';
import { ALL_METAL_KINDS, METAL_KIND, detectMetalKind, isMetalKind } from './metal-kind.js';

describe('Распознавание металла', () => {
  it('распознаёт золото по названию и пробе', () => {
    expect(detectMetalKind('Золото')).toBe(METAL_KIND.GOLD);
    expect(detectMetalKind('золото 585')).toBe(METAL_KIND.GOLD);
    expect(detectMetalKind('Au585')).toBe(METAL_KIND.GOLD);
    expect(detectMetalKind('Au 585')).toBe(METAL_KIND.GOLD);
    expect(detectMetalKind('Gold 750')).toBe(METAL_KIND.GOLD);
    expect(detectMetalKind('750')).toBe(METAL_KIND.GOLD);
  });

  it('распознаёт серебро по названию и пробе', () => {
    expect(detectMetalKind('Серебро')).toBe(METAL_KIND.SILVER);
    expect(detectMetalKind('серебро 925')).toBe(METAL_KIND.SILVER);
    expect(detectMetalKind('Ag925')).toBe(METAL_KIND.SILVER);
    expect(detectMetalKind('Ag 925')).toBe(METAL_KIND.SILVER);
    expect(detectMetalKind('Silver')).toBe(METAL_KIND.SILVER);
    expect(detectMetalKind('925')).toBe(METAL_KIND.SILVER);
  });

  it('распознаёт платину и палладий', () => {
    expect(detectMetalKind('Платина')).toBe(METAL_KIND.PLATINUM);
    expect(detectMetalKind('Pt 950')).toBe(METAL_KIND.PLATINUM);
    expect(detectMetalKind('Палладий')).toBe(METAL_KIND.PLATINUM);
  });

  it('НЕ путает золото с серебром на словах с буквами au/ag', () => {
    /*
     * Главная ловушка: поиск «au» подстрокой находил бы его в слове «Paul»,
     * а «ag» — в «Agnus». Тогда серебряное изделие посчиталось бы по
     * золотому тарифу. Химический символ обязан быть отдельным словом.
     */
    expect(detectMetalKind('Paul')).toBeNull();
    expect(detectMetalKind('Agnus')).toBeNull();
    expect(detectMetalKind('Agreement')).toBeNull();
    // Проба — отдельное число, а не часть другого: «1585» не золото.
    expect(detectMetalKind('1585')).toBeNull();
    expect(detectMetalKind('1925')).toBeNull();
  });

  it('возвращает null, когда металл не распознан', () => {
    // Угадывать нельзя: цена по умолчанию может быть вдвое выше.
    expect(detectMetalKind('')).toBeNull();
    expect(detectMetalKind('   ')).toBeNull();
    expect(detectMetalKind(null)).toBeNull();
    expect(detectMetalKind(undefined)).toBeNull();
    expect(detectMetalKind('биметалл')).toBeNull();
    expect(detectMetalKind('нержавеющая сталь')).toBeNull();
  });

  it('проверяет принадлежность к известным металлам', () => {
    expect(isMetalKind('GOLD')).toBe(true);
    expect(isMetalKind('SILVER')).toBe(true);
    expect(isMetalKind('Золото')).toBe(false);
    expect(isMetalKind(null)).toBe(false);
    // Перечисление не должно незаметно расширяться.
    expect(ALL_METAL_KINDS).toHaveLength(3);
  });
});
