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
  metalDisplayName,
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

/**
 * Название металла для ПЕЧАТИ (требование заказчика).
 *
 * В базе металл хранится кодом (`Au585`, `GOLD`), потому что по нему считается
 * цена. Напечатать код в квитанции значит показать клиенту «Au585» —
 * обозначение, которым пользуются ювелиры, а не покупатели. В документе должно
 * стоять русское название.
 */
describe('Название металла для печати', () => {
  it('код золота печатается как «Золото»', () => {
    // Именно так хранится металл в базе: `item.metal = 'Au585'`.
    expect(metalDisplayName('Au585')).toBe('Золото');
    expect(metalDisplayName('GOLD')).toBe('Золото');
  });

  it('код серебра печатается как «Серебро»', () => {
    expect(metalDisplayName('Ag925')).toBe('Серебро');
    expect(metalDisplayName('SILVER')).toBe('Серебро');
  });

  it('свободный текст распознаётся и приводится к названию', () => {
    // Приёмщик мог вписать металл словами до появления списка.
    expect(metalDisplayName('Золото 585')).toBe('Золото');
    expect(metalDisplayName('серебро')).toBe('Серебро');
    expect(metalDisplayName('Au 585')).toBe('Золото');
  });

  it('платина печатается как «Платина»', () => {
    expect(metalDisplayName('PLATINUM')).toBe('Платина');
    expect(metalDisplayName('платина')).toBe('Платина');
  });

  it('ПАЛЛАДИЙ печатается как введён, а не как «Платина»', () => {
    /*
     * ГЛАВНАЯ проверка осторожности. В РАСЧЁТЕ палладий приравнен к платине — в
     * прейскуранте только три группы металлов. Но для документа это подмена:
     * клиент сдал палладий, а в квитанции, которая у него остаётся, написано
     * «Платина». Расхождение в бумаге с тем, что человек принёс.
     */
    expect(metalDisplayName('Палладий')).toBe('Палладий');
    expect(metalDisplayName('палладий')).toBe('палладий');
    expect(metalDisplayName('Pd950')).not.toBe('Платина');
  });

  it('незнакомый металл печатается как есть, а не скрывается', () => {
    /*
     * Вернуть пустую строку значило бы СКРЫТЬ металл из документа: клиент не
     * увидел бы, что сдал. Незнакомый текст неверен по форме, но правдив по
     * сути.
     */
    expect(metalDisplayName('Белое золото')).toBe('Золото');
    expect(metalDisplayName('Нейзильбер')).toBe('Нейзильбер');
  });

  it('пустое значение — это отсутствие металла, а не пустая строка', () => {
    // По `null` квитанция решает, печатать ли колонку вообще.
    expect(metalDisplayName(null)).toBeNull();
    expect(metalDisplayName(undefined)).toBeNull();
    expect(metalDisplayName('')).toBeNull();
    expect(metalDisplayName('   ')).toBeNull();
  });

  it('значение обрезается от пробелов', () => {
    // Пробелы по краям в документе выглядят как небрежность ввода.
    expect(metalDisplayName('  Au585  ')).toBe('Золото');
  });

  it('в результат не попадают коды металлов', () => {
    /*
     * Общая проверка на весь список кодов из прейскуранта: ни один не должен
     * просочиться в документ как есть — клиент не обязан понимать `Ag925`.
     */
    for (const kind of ['GOLD', 'SILVER', 'PLATINUM'] as const) {
      const printed = metalDisplayName(kind);
      expect(printed, kind).not.toBe(kind);
      expect(printed, kind).toMatch(/^[А-Яа-яЁё]+$/);
    }
  });
});
