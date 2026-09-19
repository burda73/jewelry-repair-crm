/**
 * Проверка распознавания металла по свободному тексту.
 *
 * Функция влияет на деньги: если серебряное изделие распознать как золотое,
 * клиенту выставят примерно вдвое большую цену по прейскуранту. Поэтому
 * проверяются не только очевидные случаи, но и ловушки подстрок.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_METAL_KINDS,
  METAL_KIND,
  METAL_OPTIONS,
  PRICED_METAL_KINDS,
  detectMetalKind,
  isMetalKind,
  metalOptionValue,
} from './metal-kind.js';

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

describe('Выпадающий список металла (замечание заказчика)', () => {
  it('список содержит только металлы со ставками', () => {
    /*
     * Платина в прейскуранте цен не имеет. Предложить её значило бы дать выбор,
     * который всё равно приведёт к цене по умолчанию, — приёмщик решил бы, что
     * выбрал тариф, а расчёт пошёл бы по другой колонке.
     */
    expect(METAL_OPTIONS.map((option) => option.value)).toEqual([...PRICED_METAL_KINDS]);
    expect(METAL_OPTIONS.map((option) => option.value)).not.toContain(METAL_KIND.PLATINUM);
  });

  it('у каждого пункта есть подпись', () => {
    // Пункт без подписи выглядел бы пустой строкой в списке.
    for (const option of METAL_OPTIONS) {
      expect(option.label.trim(), option.value).not.toBe('');
    }
  });

  it('значением пункта служит код, а не подпись', () => {
    /*
     * В базу пишется код: `resolveItemPrice` сравнивает металл со ставкой
     * прейскуранта напрямую. Запись подписи потребовала бы обратного разбора при
     * каждом расчёте — и он же стал бы местом, где цена считается неверно.
     */
    expect(METAL_OPTIONS.map((option) => option.value)).toContain(METAL_KIND.GOLD);
    expect(METAL_OPTIONS.map((option) => option.value)).not.toContain('Золото');
  });
});

describe('Сопоставление сохранённого металла со списком', () => {
  it('код возвращается как есть', () => {
    expect(metalOptionValue('GOLD')).toBe(METAL_KIND.GOLD);
    expect(metalOptionValue('SILVER')).toBe(METAL_KIND.SILVER);
  });

  it('старый свободный текст распознаётся', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА. До появления списка металл хранился текстом. Без
     * сопоставления `<select>` не нашёл бы подходящий пункт и показал ПУСТОЙ
     * выбор, а сохранение затёрло бы исходное значение: изделие потеряло бы
     * металл, и цена посчиталась бы по умолчанию — молча.
     */
    expect(metalOptionValue('Золото 585')).toBe(METAL_KIND.GOLD);
    expect(metalOptionValue('золото')).toBe(METAL_KIND.GOLD);
    expect(metalOptionValue('Ag925')).toBe(METAL_KIND.SILVER);
    expect(metalOptionValue('Серебро 925')).toBe(METAL_KIND.SILVER);
  });

  it('пустое значение означает «не выбрано»', () => {
    expect(metalOptionValue('')).toBe('');
    expect(metalOptionValue('   ')).toBe('');
    expect(metalOptionValue(null)).toBe('');
    expect(metalOptionValue(undefined)).toBe('');
  });

  it('нераспознанный текст не превращается в догадку', () => {
    /*
     * Угадывать нельзя: ошибка здесь — это ошибка в деньгах клиента. Возвращается
     * «не выбрано», а исходный текст вызывающий код обязан сохранить отдельно.
     */
    expect(metalOptionValue('биметалл')).toBe('');
    expect(metalOptionValue('неизвестный сплав')).toBe('');
  });

  it('платина не попадает в выбор, хотя и распознаётся', () => {
    /*
     * Распознавание шире списка: старый заказ мог быть на платину, и терять её
     * нельзя. Но в списке пункта нет — ставок по ней в прейскуранте не задано.
     */
    expect(detectMetalKind('Платина')).toBe(METAL_KIND.PLATINUM);
    expect(METAL_OPTIONS.map((option) => option.value)).not.toContain(METAL_KIND.PLATINUM);
  });
});
