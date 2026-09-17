/**
 * Тесты состава квитанции (ответ A4, docs/08-ui-ux.md §4.1).
 *
 * Квитанция уходит клиенту на бумаге, поэтому проверяется не вёрстка, а
 * содержимое: сумма, срок, телефон и то, что в QR-коде нет персональных
 * данных. Ошибка здесь означает документ, по которому нельзя получить заказ.
 */

import { describe, expect, it } from 'vitest';
/*
 * В денежных литералах ниже пробел между разрядами — НЕРАЗРЫВНЫЙ (U+00A0):
 * именно его ставит `Intl.NumberFormat('ru-RU')` внутри `formatMoney`.
 * Обычный пробел здесь выглядит так же, но тест не пройдёт.
 */
import {
  buildReceiptRows,
  buildReceiptQr,
  buildReceiptBarcode,
  receiptNotice,
  formatReceiptDate,
  type ReceiptData,
} from './receipt.js';

function sample(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    orderNo: 'MSK1-2509-000142',
    createdAt: new Date('2025-09-16T10:00:00Z'),
    dueAt: new Date('2025-09-23T00:00:00Z'),
    status: 'ACCEPTED',
    statusLabel: 'Принят',
    storeName: 'Магазин МСК1',
    customerName: 'Клиентов Иван Петрович',
    customerPhone: '+7 916 123-45-67',
    items: [{ name: 'Кольцо', metal: 'Au585' }],
    works: [{ name: 'Пайка разрыва шинки', amountMinor: 250_000 }],
    stones: [],
    worksTotalMinor: 250_000,
    stonesTotalMinor: 0,
    discountMinor: 0,
    totalAmountMinor: 250_000,
    paidAmountMinor: 100_000,
    prepaymentRequiredMinor: 100_000,
    requiresPrepayment: true,
    isWarranty: false,
    description: null,
    ...overrides,
  };
}

/** Найти строку по подписи — читаемость важнее индексов. */
function row(data: ReceiptData, label: string): string | undefined {
  return buildReceiptRows(data).find((r) => r.label === label)?.value;
}

describe('Квитанция: состав', () => {
  it('печатает изделие, работу, сумму, срок и телефон', () => {
    const d = sample();
    expect(row(d, 'Изделие')).toBe('Кольцо');
    expect(row(d, 'Работы')).toContain('Пайка разрыва шинки');
    expect(row(d, 'Сумма')).toBe('2 500,00 ₽');
    expect(row(d, 'Срок готовности')).toBe('23.09.2025');
    expect(row(d, 'Телефон')).toBe('+7 916 123-45-67');
  });

  it('печатает металл изделия', () => {
    expect(row(sample(), 'Металл')).toBe('Au585');
  });

  it('не печатает строку металла, если он не указан', () => {
    const d = sample({ items: [{ name: 'Кольцо', metal: null }] });
    expect(row(d, 'Металл')).toBeUndefined();
  });

  it('сворачивает повторяющийся металл в одно значение', () => {
    const d = sample({
      items: [
        { name: 'Кольцо', metal: 'Au585' },
        { name: 'Серьга', metal: 'Au585' },
      ],
    });
    expect(row(d, 'Металл')).toBe('Au585');
    // Изделия перечисляются все: клиент сдал два предмета.
    expect(row(d, 'Изделие')).toBe('Кольцо; Серьга');
  });

  it('показывает скидку со знаком минус', () => {
    const d = sample({ discountMinor: 50_000, totalAmountMinor: 200_000 });
    expect(row(d, 'Скидка')).toBe('−500,00 ₽');
    expect(row(d, 'Надбавка')).toBeUndefined();
  });

  it('показывает надбавку со знаком плюс, а не отрицательную скидку', () => {
    // Инвариант: discountMinor < 0 — это согласованная сумма выше суммы строк.
    const d = sample({ discountMinor: -50_000, totalAmountMinor: 300_000 });
    expect(row(d, 'Надбавка')).toBe('+500,00 ₽');
    expect(row(d, 'Скидка')).toBeUndefined();
  });

  it('печатает предоплату только когда она требуется', () => {
    expect(row(sample(), 'Предоплата к внесению')).toBe('1 000,00 ₽');
    expect(
      row(
        sample({ requiresPrepayment: false, prepaymentRequiredMinor: 0 }),
        'Предоплата к внесению',
      ),
    ).toBeUndefined();
  });

  it('печатает камни, если они есть', () => {
    const d = sample({ stones: [{ name: 'Фианит', amountMinor: 30_000 }] });
    expect(row(d, 'Камни')).toContain('Фианит');
  });

  it('печатает описание, если приёмщик его записал', () => {
    expect(row(sample({ description: 'Скол на шинке' }), 'Описание')).toBe('Скол на шинке');
    expect(row(sample({ description: '   ' }), 'Описание')).toBeUndefined();
  });

  it('не печатает пустые работы прочерком, а не пустой строкой', () => {
    expect(row(sample({ works: [] }), 'Работы')).toBe('—');
  });
});

describe('Квитанция: QR-код и штрих-код', () => {
  it('QR содержит URI со номером заказа', () => {
    expect(buildReceiptQr({ orderNo: 'MSK1-2509-000142' })).toBe('repair://order/MSK1-2509-000142');
  });

  it('в QR-коде нет персональных данных', () => {
    // 152-ФЗ: код печатается на бумаге, которая остаётся у клиента.
    const qr = buildReceiptQr({ orderNo: 'MSK1-2509-000142' });
    expect(qr).not.toContain('+7');
    expect(qr).not.toContain('Клиентов');
    expect(qr).not.toMatch(/\d{4,}\s*₽/);
  });

  it('линейный код содержит чистый номер заказа', () => {
    expect(buildReceiptBarcode({ orderNo: 'MSK1-2509-000142' })).toBe('MSK1-2509-000142');
    expect(buildReceiptBarcode({ orderNo: ' msk1-2509-000142 ' })).toBe('MSK1-2509-000142');
  });
});

describe('Квитанция: дата и предупреждение', () => {
  it('форматирует дату как ДД.ММ.ГГГГ', () => {
    expect(formatReceiptDate(new Date('2025-09-23T00:00:00Z'))).toBe('23.09.2025');
    expect(formatReceiptDate(new Date('2025-01-05T00:00:00Z'))).toBe('05.01.2025');
  });

  it('печатает прочерк вместо отсутствующего срока', () => {
    expect(formatReceiptDate(null)).toBe('—');
  });

  it('гарантийный ремонт печатается без оплаты', () => {
    expect(receiptNotice({ isWarranty: true, requiresPrepayment: true })).toContain('без оплаты');
  });

  it('предупреждение говорит о предоплате, когда она нужна', () => {
    expect(receiptNotice({ isWarranty: false, requiresPrepayment: true })).toContain('предоплаты');
  });
});
