/**
 * Состав квитанции приёма заказа (ответ A4, docs/08-ui-ux.md §4.1).
 *
 * Квитанция — документ, который остаётся у клиента, поэтому её состав
 * фиксирован и не зависит от того, кто и где печатает. Здесь описано
 * СОДЕРЖИМОЕ (что печатать), а не вёрстка: сборка PDF и предпросмотр в
 * интерфейсе пользуются одной и той же функцией, иначе бумага и экран
 * разошлись бы — клиент увидел бы на экране одно, а получил другое.
 *
 * Персональных данных в QR-коде нет: только номер заказа (см.
 * `buildOrderQrPayload`). Сама квитанция печатается для клиента и содержит
 * его телефон и ФИО — это документ приёма, без них он бесполезен.
 */

import { formatMoney } from '../utils/money.js';
import { buildOrderQrPayload } from './order-number.js';

/** Готовая строка квитанции: подпись и значение. */
export interface ReceiptRow {
  label: string;
  value: string;
}

/** Данные, необходимые для печати квитанции. Собирается сервером. */
export interface ReceiptData {
  orderNo: string;
  createdAt: Date;
  dueAt: Date | null;
  status: string;
  statusLabel: string;
  storeName: string;
  customerName: string;
  customerPhone: string;
  items: { name: string; metal: string | null }[];
  works: { name: string; amountMinor: number }[];
  stones: { name: string; amountMinor: number }[];
  worksTotalMinor: number;
  stonesTotalMinor: number;
  /** Скидка (положительная) или надбавка (отрицательная) — см. `describeDiscount`. */
  discountMinor: number;
  totalAmountMinor: number;
  paidAmountMinor: number;
  prepaymentRequiredMinor: number;
  requiresPrepayment: boolean;
  isWarranty: boolean;
  /** Причина ремонта / описание неисправности, если приёмщик её записал. */
  description: string | null;
}

/** Строка «металл» для перечня изделий. */
function metalLabel(metal: string | null): string {
  if (metal === null || metal.trim() === '') return '';
  // Значение приходит либо кодом (`Au585`, `Ag925`), либо свободным текстом.
  return metal.trim();
}

/** Дата в виде ДД.ММ.ГГГГ — формат, привычный для бумажных документов. */
export function formatReceiptDate(date: Date | null): string {
  if (date === null) return '—';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

/**
 * Строки квитанции в порядке печати.
 *
 * Возвращает именно список подписей и значений, а не готовый текст: так
 * вёрстка PDF и предпросмотр на экране расставляют их по-своему, но
 * подписи и порядок остаются едиными, и тест проверяет их один раз.
 */
export function buildReceiptRows(data: ReceiptData): ReceiptRow[] {
  const rows: ReceiptRow[] = [
    { label: 'Изделие', value: data.items.map((i) => i.name).join('; ') || '—' },
  ];

  const metals = data.items.map((i) => metalLabel(i.metal)).filter((m) => m !== '');
  if (metals.length > 0) {
    rows.push({ label: 'Металл', value: [...new Set(metals)].join(', ') });
  }

  rows.push({
    label: 'Работы',
    value:
      data.works.length > 0
        ? data.works.map((w) => `${w.name} — ${formatMoney(w.amountMinor)}`).join('; ')
        : '—',
  });

  if (data.stones.length > 0) {
    rows.push({
      label: 'Камни',
      value: data.stones.map((s) => `${s.name} — ${formatMoney(s.amountMinor)}`).join('; '),
    });
  }

  if (data.description !== null && data.description.trim() !== '') {
    rows.push({ label: 'Описание', value: data.description.trim() });
  }

  rows.push({ label: 'Сумма', value: formatMoney(data.totalAmountMinor) });

  if (data.discountMinor > 0) {
    rows.push({ label: 'Скидка', value: `−${formatMoney(data.discountMinor)}` });
  }
  if (data.discountMinor < 0) {
    // Надбавка: согласованная сумма больше суммы строк (срочность, сложность).
    rows.push({ label: 'Надбавка', value: `+${formatMoney(-data.discountMinor)}` });
  }

  if (data.requiresPrepayment && data.prepaymentRequiredMinor > 0) {
    rows.push({
      label: 'Предоплата к внесению',
      value: formatMoney(data.prepaymentRequiredMinor),
    });
  }

  rows.push({ label: 'Внесено', value: formatMoney(data.paidAmountMinor) });
  rows.push({ label: 'Срок готовности', value: formatReceiptDate(data.dueAt) });
  rows.push({ label: 'Телефон', value: data.customerPhone });
  rows.push({ label: 'Статус', value: data.statusLabel });

  return rows;
}

/**
 * Что печатать в QR-коде квитанции.
 *
 * Отдельная функция, потому что это единственное поле квитанции, которое
 * читает оборудование, и его формат зафиксирован ответом A4: сканер вводит
 * `repair://order/{номер}` в поле поиска.
 */
export function buildReceiptQr(data: { orderNo: string }): string {
  return buildOrderQrPayload(data.orderNo);
}

/**
 * Что печатать линейным кодом `Code128` — резерв для сканеров, читающих
 * только линейные коды. Только номер: URI в линейный код не влезает,
 * да и сканеру нужен именно номер.
 */
export function buildReceiptBarcode(data: { orderNo: string }): string {
  return data.orderNo.trim().toUpperCase();
}

/**
 * Текст-предупреждение под шапкой квитанции.
 *
 * Гарантийный заказ печатается без денег: клиент не платит за повторный
 * ремонт по гарантии, и приёмщик не должен вписывать сумму от руки.
 */
export function receiptNotice(data: { isWarranty: boolean; requiresPrepayment: boolean }): string {
  if (data.isWarranty) {
    return 'Гарантийный ремонт — выполняется без оплаты.';
  }
  if (data.requiresPrepayment) {
    return 'Работы начинаются после внесения предоплаты.';
  }
  return 'Работы начинаются после согласования стоимости.';
}
