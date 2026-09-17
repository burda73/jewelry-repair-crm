/**
 * Тесты генерации номеров и QR-кодов (ответ A4, docs/00-decisions.md §6.12, §6.14).
 *
 * Критично для бизнеса: сканирование QR-кода — основной способ найти заказ
 * при приёме оплаты, поэтому разбор ввода сканера должен быть устойчивым
 * к реальным особенностям оборудования.
 */

import { describe, expect, it } from 'vitest';
import {
  buildOrderNo,
  buildOrderQrPayload,
  buildBatchNo,
  buildBatchActNo,
  buildRefusalActNo,
  buildClaimNo,
  isValidOrderNo,
  parseOrderNoFromScan,
  normalizeScanInput,
  orderCounterScope,
  QR_ORDER_PREFIX,
} from './order-number.js';

describe('Номер заказа', () => {
  it('формирует номер в оговорённом формате', () => {
    const date = new Date('2025-09-16T10:00:00Z');
    expect(buildOrderNo('MSK1', date, 142)).toBe('MSK1-2509-000142');
  });

  it('дополняет порядковый номер нулями до шести цифр', () => {
    const date = new Date('2025-09-16T10:00:00Z');
    expect(buildOrderNo('MSK1', date, 1)).toBe('MSK1-2509-000001');
    expect(buildOrderNo('MSK1', date, 999999)).toBe('MSK1-2509-999999');
  });

  it('нормализует код магазина: верхний регистр, без спецсимволов', () => {
    const date = new Date('2025-09-16T10:00:00Z');
    expect(buildOrderNo('msk-1', date, 5)).toBe('MSK1-2509-000005');
    expect(buildOrderNo(' spb 2 ', date, 5)).toBe('SPB2-2509-000005');
  });

  it('меняет префикс месяца при переходе на новый месяц', () => {
    expect(buildOrderNo('MSK1', new Date('2025-01-31T10:00:00Z'), 1)).toBe('MSK1-2501-000001');
    expect(buildOrderNo('MSK1', new Date('2025-02-01T10:00:00Z'), 1)).toBe('MSK1-2502-000001');
  });

  it('отклоняет пустой код магазина и неположительный номер', () => {
    const date = new Date('2025-09-16T10:00:00Z');
    expect(() => buildOrderNo('', date, 1)).toThrow(RangeError);
    expect(() => buildOrderNo('-', date, 1)).toThrow(RangeError);
    expect(() => buildOrderNo('MSK1', date, 0)).toThrow(RangeError);
    expect(() => buildOrderNo('MSK1', date, -5)).toThrow(RangeError);
    expect(() => buildOrderNo('MSK1', date, 1.5)).toThrow(RangeError);
  });

  it('распознаёт корректные номера и отвергает мусор', () => {
    expect(isValidOrderNo('MSK1-2509-000142')).toBe(true);
    expect(isValidOrderNo('msk1-2509-000142')).toBe(true);
    expect(isValidOrderNo('MSK1-250-000142')).toBe(false); // не 4 цифры года-месяца
    expect(isValidOrderNo('MSK1-2509-142')).toBe(false); // не 6 цифр
    expect(isValidOrderNo('МСК1-2509-000142')).toBe(false); // кириллица
    expect(isValidOrderNo('')).toBe(false);
  });

  it('область счётчика уникальна для магазина и месяца', () => {
    const september = orderCounterScope('MSK1', new Date('2025-09-16T10:00:00Z'));
    const october = orderCounterScope('MSK1', new Date('2025-10-01T10:00:00Z'));
    const otherStore = orderCounterScope('MSK2', new Date('2025-09-16T10:00:00Z'));

    expect(september).not.toBe(october);
    expect(september).not.toBe(otherStore);
    // Один и тот же магазин и месяц в разные дни — тот же счётчик.
    expect(orderCounterScope('MSK1', new Date('2025-09-01T00:00:00Z'))).toBe(september);
  });
});

/*
 * Приведение ввода сканера к поисковому запросу.
 *
 * Дефект, ради которого написаны тесты: экран приёма оплаты отправлял в поиск
 * строку `repair://order/MSK1-…` целиком и получал НОЛЬ результатов — то есть
 * основной сценарий ТЗ п. 2.5 («оплата по отсканированному номеру») не работал.
 */
describe('Ввод сканера → поисковый запрос', () => {
  it('извлекает номер из URI QR-кода', () => {
    expect(normalizeScanInput('repair://order/MSK1-2509-000142')).toBe('MSK1-2509-000142');
  });

  it('убирает перевод строки, который добавляет сканер', () => {
    expect(normalizeScanInput('repair://order/MSK1-2509-000142\n')).toBe('MSK1-2509-000142');
    expect(normalizeScanInput('  MSK1-2509-000142  \n')).toBe('MSK1-2509-000142');
  });

  it('принимает номер без URI и приводит к верхнему регистру', () => {
    expect(normalizeScanInput('msk1-2509-000142')).toBe('MSK1-2509-000142');
  });

  it('НЕ ломает поиск по телефону и фамилии', () => {
    // Приёмщик вводит не только номер: телефон и фамилия должны дойти до API
    // в неизменном виде, иначе поиск перестанет работать.
    expect(normalizeScanInput('+7 916 123-45-67')).toBe('+7 916 123-45-67');
    expect(normalizeScanInput('Клиентов')).toBe('Клиентов');
  });

  it('схлопывает лишние пробелы в обычном запросе', () => {
    expect(normalizeScanInput('  Иван   Петрович  ')).toBe('Иван Петрович');
  });
});

describe('QR-код квитанции (ответ A4)', () => {
  it('формирует содержимое QR из номера заказа', () => {
    expect(buildOrderQrPayload('MSK1-2509-000142')).toBe('repair://order/MSK1-2509-000142');
  });

  it('отклоняет некорректный номер — иначе клиент получит неработающий код', () => {
    expect(() => buildOrderQrPayload('мусор')).toThrow(RangeError);
    expect(() => buildOrderQrPayload('')).toThrow(RangeError);
  });

  it('QR не содержит персональных данных — только ссылку на заказ', () => {
    const payload = buildOrderQrPayload('MSK1-2509-000142');
    // Квитанция остаётся у клиента; телефон, ФИО и суммы в код не попадают.
    expect(payload).not.toMatch(/\d{7,}/); // никаких длинных чисел, кроме номера
    expect(payload).toBe(`${QR_ORDER_PREFIX}MSK1-2509-000142`);
  });
});

describe('Разбор ввода сканера штрих-кода', () => {
  it('принимает полный URI из QR-кода', () => {
    expect(parseOrderNoFromScan('repair://order/MSK1-2509-000142')).toBe('MSK1-2509-000142');
  });

  it('принимает просто номер — сканер может быть настроен без префикса', () => {
    expect(parseOrderNoFromScan('MSK1-2509-000142')).toBe('MSK1-2509-000142');
    expect(parseOrderNoFromScan('msk1-2509-000142')).toBe('MSK1-2509-000142');
  });

  it('устойчив к мусору, который добавляют сканеры', () => {
    // Сканеры часто добавляют перевод строки в конце (суффикс Enter).
    expect(parseOrderNoFromScan('repair://order/MSK1-2509-000142\n')).toBe('MSK1-2509-000142');
    // ...или табуляцию, или пробелы.
    expect(parseOrderNoFromScan('\tMSK1-2509-000142\t')).toBe('MSK1-2509-000142');
    expect(parseOrderNoFromScan('  MSK1-2509-000142  ')).toBe('MSK1-2509-000142');
    expect(parseOrderNoFromScan('MSK1-2509-000142\r\n')).toBe('MSK1-2509-000142');
  });

  it('возвращает null для нераспознанного ввода, не бросая исключение', () => {
    // Пользователь может просто печатать в поле поиска — это не ошибка.
    expect(parseOrderNoFromScan('')).toBeNull();
    expect(parseOrderNoFromScan('Иванов')).toBeNull();
    expect(parseOrderNoFromScan('+79161234567')).toBeNull();
    expect(parseOrderNoFromScan('abc-def')).toBeNull();
  });

  it('цикл «сформировали QR → отсканировали» восстанавливает исходный номер', () => {
    const orderNo = buildOrderNo('SPB2', new Date('2025-12-31T10:00:00Z'), 42);
    const qr = buildOrderQrPayload(orderNo);
    expect(parseOrderNoFromScan(qr)).toBe(orderNo);
  });
});

describe('Номера прочих документов', () => {
  const date = new Date('2025-09-16T10:00:00Z');

  it('номер партии содержит дату', () => {
    expect(buildBatchNo(date, 4)).toBe('П-250916-004');
  });

  it('номер акта приёма-передачи', () => {
    expect(buildBatchActNo(date, 118)).toBe('АПП-25-000118');
  });

  it('номер акта отказа', () => {
    expect(buildRefusalActNo(date, 7)).toBe('АО-25-000007');
  });

  it('номер рекламации', () => {
    expect(buildClaimNo(date, 31)).toBe('РЕК-25-00031');
  });
});