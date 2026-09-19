/**
 * Гарантийный заказ в мастере создания (этап 6, ТЗ п. 2.9).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Гарантийный ремонт — это работа, которую выполняют бесплатно
 * по ранее выданному заказу. Заводить её как обычный заказ нельзя: в отчётности
 * она выглядела бы как новая выручка, а связь с исходным заказом потерялась бы —
 * и доказать, что ремонт был гарантийным, стало бы нечем. Поэтому у заказа есть
 * признак `isWarranty` и ссылка `parentOrderId` на заказ, из-за которого возник
 * случай.
 *
 * ПОЧЕМУ ЛОГИКА ЗДЕСЬ, А НЕ В КОМПОНЕНТЕ. Компоненты в этом проекте не
 * рендерятся в тестах (в `apps/web` намеренно нет jsdom и testing-library —
 * см. комментарий в `vitest.config.ts`). Правила выбора исходного заказа и
 * запрета гарантии по незавершённому заказу — это то, что можно проверить
 * чистой функцией, поэтому они живут здесь.
 */

import type { OrderListItem } from './api-types';

/** Состояние признака гарантии в мастере создания. */
export interface WarrantyOrderDraft {
  /** Заказ заводится как гарантийный. */
  isWarranty: boolean;
  /** Исходный заказ, по которому возник гарантийный случай. */
  parentOrderId: string;
}

/** Сброшенное состояние: обычный заказ. */
export const EMPTY_WARRANTY_DRAFT: WarrantyOrderDraft = { isWarranty: false, parentOrderId: '' };

/**
 * Можно ли выдать изделие по гарантии из этого заказа.
 *
 * Гарантия отсчитывается от выдачи, поэтому исходным может быть только выданный
 * (`COMPLETED`) или невостребованный (`UNCLAIMED`) заказ: изделие изготовлено, но
 * клиент за ним не пришёл. Заказ в работе исходным быть не может — гарантийный
 * случай по неготовому изделию не возникает.
 */
export function canBeWarrantySource(order: Pick<OrderListItem, 'status'>): boolean {
  return order.status === 'COMPLETED' || order.status === 'UNCLAIMED';
}

/**
 * Заказы клиента, пригодные как исходные для гарантии.
 *
 * Порядок — от новых к старым: приёмщик почти всегда имеет дело со свежим
 * заказом, а гарантия отсчитывается от даты выдачи. Сортировка по `readyAt` с
 * откатом на `createdAt`: у невостребованного заказа `readyAt` заполнен (изделие
 * было готово), а у только что выданного может отсутствовать в старых записях.
 */
export function warrantySourceCandidates(orders: readonly OrderListItem[]): OrderListItem[] {
  return orders
    .filter(canBeWarrantySource)
    .slice()
    .sort((a, b) => sourceTime(b) - sourceTime(a));
}

/** Момент, по которому упорядочиваются исходные заказы. */
function sourceTime(order: OrderListItem): number {
  const raw = order.readyAt ?? order.createdAt;
  const time = new Date(raw).getTime();
  // Некорректируемая дата не должна ломать сортировку: такой заказ уходит вниз.
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Готова ли форма гарантии к отправке.
 *
 * `null` — замечаний нет. Признак гарантии без исходного заказа бессмысленен:
 * сервер связь не проверит (он принимает любой существующий `parentOrderId`), и
 * заказ оказался бы гарантийным «в никуда» — то есть в отчётности бесплатной
 * работой без причины.
 */
export function warrantyDraftError(draft: WarrantyOrderDraft): string | null {
  if (!draft.isWarranty) return null;
  return draft.parentOrderId.trim() === '' ? 'Выберите заказ, по которому возник случай' : null;
}

/**
 * Поля гарантии для тела запроса.
 *
 * Обычный заказ НЕ отправляет `isWarranty` вовсе, а не отправляет `false`:
 * сервер принимает отсутствие поля как `false` по умолчанию, и лишнее поле в
 * теле — это шум, который при смене значения по умолчанию на сервере дал бы
 * расхождение между тем, что показал интерфейс, и тем, что сохранилось.
 */
export function warrantyPayloadFields(draft: WarrantyOrderDraft): {
  isWarranty?: boolean;
  parentOrderId?: string;
} {
  if (!draft.isWarranty) return {};
  const parent = draft.parentOrderId.trim();
  return parent === '' ? { isWarranty: true } : { isWarranty: true, parentOrderId: parent };
}

/**
 * Описание выбранного исходного заказа для подписи под списком.
 *
 * Возвращает `null`, если заказ не выбран или его нет в списке — интерфейсу
 * тогда показывать нечего, и подпись не рисуется.
 */
export function describeWarrantySource(
  orders: readonly OrderListItem[],
  parentOrderId: string,
): string | null {
  const order = orders.find((candidate) => candidate.id === parentOrderId);
  if (order === undefined) return null;

  const date = order.readyAt ?? order.createdAt;
  return `${order.orderNo} от ${formatDate(date)}`;
}

/**
 * Дата в формате ДД.ММ.ГГГГ московского дня.
 *
 * Принимает `null`: у заказа не заполнена дата готовности или создания, и это не
 * ошибка данных, а отсутствие значения — прочерк объясняет это лучше, чем
 * исключение.
 */
export function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}
