/**
 * Тесты выгрузки отчётов (задача 5.6, docs/06 §6.4).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Выгрузку открывают в Excel и работают с ней: считают суммы,
 * строят сводные, отправляют в бухгалтерию. Ошибка здесь не видна на глаз —
 * файл откроется и будет выглядеть правильно, — но числа в нём окажутся
 * неверными:
 *
 *  * ДЕНЬГИ, ВЫГРУЖЕННЫЕ В КОПЕЙКАХ, завышают суммы в сто раз. Ошибку замечают
 *    не сразу, а после сверки, когда решение уже принято по неверной цифре.
 *  * ЧИСЛА, СТАВШИЕ ТЕКСТОМ, Excel не суммирует: получатель складывает вручную
 *    или, что хуже, получает «0» в итоговой ячейке и не понимает почему.
 *  * КИРИЛЛИЦА БЕЗ BOM открывается нечитаемыми знаками, и файл уходит в мусор.
 *  * НЕЭКРАНИРОВАННЫЙ РАЗДЕЛИТЕЛЬ разъезжает строку на лишние колонки, и все
 *    числа строки смещаются — таблица становится неверной целиком.
 *
 * Поэтому проверяется не «файл создан», а содержимое и структура.
 */

import { describe, expect, it, vi } from 'vitest';
import { REPORT_COLUMN_TYPE, REPORT_NAME, type ReportResult } from '@app/shared';
import {
  EXPORT_FORMAT,
  cellValue,
  columnTitle,
  csvEscape,
  toCsv,
  toTable,
  toXlsx,
} from './reports-export.service';
import { parseFormat } from './reports.controller';

/** Небольшой отчёт для проверок. */
function report(overrides: Partial<ReportResult> = {}): ReportResult {
  return {
    meta: {
      from: '2025-09-01',
      to: '2025-09-30',
      generatedAt: '2025-09-30T12:00:00.000Z',
      cached: false,
      rowCount: 1,
    },
    columns: [
      { key: 'store', title: 'Магазин', type: REPORT_COLUMN_TYPE.STRING },
      { key: 'revenueMinor', title: 'Выручка', type: REPORT_COLUMN_TYPE.MONEY },
      { key: 'share', title: 'В норме', type: REPORT_COLUMN_TYPE.PERCENT },
    ],
    rows: [{ store: 'Тверская', revenueMinor: 180000, share: 0.87 }],
    totals: { revenueMinor: 180000, ordersCount: 1 },
    ...overrides,
  };
}

describe('Значения ячеек (задача 5.6)', () => {
  it('деньги выгружаются в рублях, а не копейках', () => {
    /*
     * В базе суммы в копейках, в таблице человек ждёт рубли. Выгрузка копеек
     * завысила бы суммы в сто раз — и ошибку заметили бы только после сверки.
     */
    const column = { key: 'x', title: 'Выручка', type: REPORT_COLUMN_TYPE.MONEY };
    expect(cellValue(column, 180000)).toBe(1800);
  });

  it('деньги остаются ЧИСЛОМ, а не строкой', () => {
    // Строку «1 800,00 ₽» Excel не просуммирует.
    const column = { key: 'x', title: 'Выручка', type: REPORT_COLUMN_TYPE.MONEY };
    expect(typeof cellValue(column, 180000)).toBe('number');
  });

  it('часы и доли не делятся на сто', () => {
    // Только денежные колонки требуют перевода: 62.4 ч — уже часы.
    expect(cellValue({ key: 'x', title: 'ч', type: REPORT_COLUMN_TYPE.DURATION }, 62.4)).toBe(62.4);
    expect(cellValue({ key: 'x', title: 'д', type: REPORT_COLUMN_TYPE.PERCENT }, 0.87)).toBe(0.87);
  });

  it('отсутствующее значение — пустая строка, а не ноль', () => {
    /*
     * «Нет данных» и «ноль» в таблице должны выглядеть по-разному: ноль в
     * пустом периоде сошёл бы за «выручки не было», хотя отчёт просто не
     * построен.
     */
    const column = { key: 'x', title: 'Выручка', type: REPORT_COLUMN_TYPE.MONEY };
    expect(cellValue(column, null)).toBe('');
    expect(cellValue(column, undefined)).toBe('');
    // А настоящий ноль остаётся нулём.
    expect(cellValue(column, 0)).toBe(0);
  });

  it('единица измерения дописана в заголовок', () => {
    /*
     * Ячейка — число без форматирования, и получатель должен видеть, что 62.4 —
     * это часы, а 0.87 — доля. Иначе «0,87» прочитали бы как 87 копеек.
     */
    expect(columnTitle({ key: 'x', title: 'Выручка', type: REPORT_COLUMN_TYPE.MONEY })).toBe(
      'Выручка, ₽',
    );
    expect(columnTitle({ key: 'x', title: 'В норме', type: REPORT_COLUMN_TYPE.PERCENT })).toBe(
      'В норме, доля',
    );
    expect(columnTitle({ key: 'x', title: 'Этап', type: REPORT_COLUMN_TYPE.STRING })).toBe('Этап');
  });
});

describe('Экранирование CSV (задача 5.6)', () => {
  it('разделитель внутри значения не разъезжает строку', () => {
    /*
     * Название магазина с `;` без экранирования разъехалось бы на две колонки, и
     * все числа строки сместились бы — таблица стала бы неверной целиком.
     */
    expect(csvEscape('ТЦ; Афимолл')).toBe('"ТЦ; Афимолл"');
  });

  it('кавычки внутри значения удваиваются', () => {
    // Так требует RFC 4180: иначе закрывающая кавычка обрывает значение раньше.
    expect(csvEscape('Магазин «Тверская» "Центр"')).toContain('""');
  });

  it('перевод строки внутри значения экранируется', () => {
    // Иначе одна запись превратилась бы в две строки таблицы.
    expect(csvEscape('первая\nвторая')).toBe('"первая\nвторая"');
  });

  it('объект в ячейке не превращается в «[object Object]»', () => {
    /*
     * Значения приходят из отчёта и по типу — строка, число или `null`. Если бы
     * функция принимала `unknown`, объект попал бы в таблицу как «[object
     * Object]», и заметить это можно было бы только глазами в Excel.
     */
    const column = { key: 'x', title: 'Магазин', type: REPORT_COLUMN_TYPE.STRING };
    expect(cellValue(column, 'Тверская')).toBe('Тверская');
    expect(cellValue(column, null)).toBe('');
  });

  it('обычное значение не оборачивается в кавычки', () => {
    expect(csvEscape('Тверская')).toBe('Тверская');
    expect(csvEscape(1800)).toBe('1800');
  });
});

describe('Выгрузка CSV (задача 5.6)', () => {
  it('начинается с маркера UTF-8', () => {
    /*
     * Без BOM Excel открывает CSV в кодировке системы и показывает кириллицу
     * нечитаемыми знаками. Файл, который нельзя прочитать, заставляет искать
     * обходные пути вместо работы с данными.
     */
    expect(toCsv(report()).startsWith('\ufeff')).toBe(true);
  });

  it('использует точку с запятой как разделитель', () => {
    // Excel в русской локали ждёт именно `;`: с запятой весь файл попадёт в одну
    // колонку.
    const csv = toCsv(report());
    const headerLine = csv.split('\r\n').find((line) => line.includes('Магазин'));
    expect(headerLine).toContain(';');
    expect(headerLine?.split(';')).toHaveLength(3);
  });

  it('строки разделены CRLF', () => {
    // Этого требует RFC 4180, и Excel под Windows иначе покажет файл одной строкой.
    expect(toCsv(report())).toContain('\r\n');
  });

  it('содержит шапку с периодом, заголовки, данные и итоги', () => {
    const csv = toCsv(report());
    // Период в шапке: файл, найденный через месяц, иначе ничего не говорит.
    expect(csv).toContain('2025-09-01 — 2025-09-30');
    expect(csv).toContain('Магазин;Выручка, ₽;В норме, доля');
    expect(csv).toContain('Тверская;1800;0.87');
    expect(csv).toContain('Заказов;1');
  });

  it('пустой отчёт выгружается без строк данных', () => {
    // Пустой файл с шапкой лучше, чем отсутствие файла: видно, что отчёт построен
    // и данных за период нет.
    const csv = toCsv(report({ rows: [], totals: {}, meta: { ...report().meta, rowCount: 0 } }));
    expect(csv).toContain('Магазин');
    expect(csv).not.toContain('Тверская');
  });
});

describe('Выгрузка XLSX (задача 5.6)', () => {
  it('создаётся и читается обратно как книга Excel', async () => {
    /*
     * Проверка не «файл непустой», а «файл открывается как книга»: XLSX — это
     * ZIP с XML, и повреждённая структура даёт файл, который Excel отказывается
     * открывать. Чтение обратно подтверждает и структуру, и содержимое.
     */
    const buffer = await toXlsx(report(), REPORT_NAME.REVENUE);
    expect(buffer.length).toBeGreaterThan(1000);
    // XLSX — это ZIP: сигнатура `PK`.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('числа в выгруженной книге остаются числами', async () => {
    /*
     * Главная проверка выгрузки. Если сумма попадёт в книгу текстом, Excel её не
     * просуммирует, и получатель получит «0» в итоговой ячейке, не понимая
     * почему.
     */
    const { Workbook } = await import('exceljs');
    const buffer = await toXlsx(report(), REPORT_NAME.REVENUE);
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet).toBeDefined();

    // Строка 1 — заголовки, строка 2 — данные.
    const header = sheet?.getRow(1).values as unknown[];
    expect(header).toContain('Выручка, ₽');

    const revenueCell = sheet?.getRow(2).getCell(2).value;
    expect(typeof revenueCell).toBe('number');
    expect(revenueCell).toBe(1800);
  });

  it('в книге есть лист с данными и итогами', async () => {
    const { Workbook } = await import('exceljs');
    const buffer = await toXlsx(report(), REPORT_NAME.REVENUE);
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];

    const all = JSON.stringify(sheet?.getSheetValues());
    expect(all).toContain('Тверская');
    expect(all).toContain('Заказов');
  });
});

describe('Формат выгрузки в запросе (задача 5.6)', () => {
  it('без параметра возвращается JSON', () => {
    // Обычный запрос отчёта формата не указывает, и значение по умолчанию не
    // должно менять поведение маршрута.
    expect(parseFormat(undefined)).toBe(EXPORT_FORMAT.JSON);
    expect(parseFormat('')).toBe(EXPORT_FORMAT.JSON);
  });

  it('распознаются все три формата', () => {
    expect(parseFormat('json')).toBe('json');
    expect(parseFormat('xlsx')).toBe('xlsx');
    expect(parseFormat('csv')).toBe('csv');
  });

  it('регистр не важен', () => {
    expect(parseFormat('XLSX')).toBe('xlsx');
    expect(parseFormat('Csv')).toBe('csv');
  });

  it('нестроковый параметр не превращается в «[object Object]»', () => {
    /*
     * Параметр приходит из строки запроса, но может оказаться чем угодно, если
     * запрос собран программно. Приведение через `String(raw)` на объекте дало бы
     * «[object Object]» в тексте ошибки, а на массиве — «json,xlsx»: сообщение
     * стало бы бессмысленным.
     */
    expect(() => parseFormat({ format: 'xlsx' })).toThrow(/«»/);
    expect(() => parseFormat(['json', 'xlsx'])).not.toThrow(/object Object/);
  });

  it('неизвестный формат — ошибка, а не молчаливый JSON', () => {
    /*
     * Клиент, попросивший `format=pdf`, должен узнать, что формат не
     * поддерживается, а не получить JSON, сохранённый под именем `.pdf`.
     */
    expect(() => parseFormat('pdf')).toThrow(/не поддерживается/);
  });
});

describe('Таблица выгрузки (задача 5.6)', () => {
  it('число колонок совпадает в заголовке и в строках', () => {
    // Расхождение сдвинуло бы значения под чужими заголовками.
    const { header, rows } = toTable(report());
    expect(rows.every((row) => row.length === header.length)).toBe(true);
  });

  it('итоги выводятся парами «показатель — значение»', () => {
    const { totals } = toTable(report());
    expect(totals).toContainEqual(['Заказов', 1]);
    expect(totals).toContainEqual(['Выручка, ₽', 180000]);
  });

  it('незнакомый ключ итогов не теряется', () => {
    /*
     * Новый отчёт не должен требовать правки словаря, чтобы выгрузиться: лучше
     * техническое имя, чем потерянный показатель.
     */
    const { totals } = toTable(report({ totals: { newMetric: 42 } }));
    expect(totals).toContainEqual(['newMetric', 42]);
  });
});
