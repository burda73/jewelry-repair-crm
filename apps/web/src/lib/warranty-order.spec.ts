/**
 * Тесты правил гарантийного заказа (этап 6, ТЗ п. 2.9).
 *
 * ЧТО ЗДЕСЬ ОХРАНЯЕТСЯ. Гарантийный заказ отличается от обычного тем, что за
 * него не берут денег, и это отличие необратимо: если работа ушла в отчётность
 * как обычная, выручка окажется завышенной, а связь с исходным заказом —
 * потерянной. Поэтому проверяются:
 *
 *  * исходным может быть только выданный заказ: гарантия отсчитывается от
 *    выдачи, и случай по неготовому изделию не возникает;
 *  * гарантия без исходного заказа не отправляется — иначе в отчёте появилась бы
 *    бесплатная работа без причины;
 *  * обычный заказ не отправляет `isWarranty: false` лишним полем: значение по
 *    умолчанию — дело сервера, и дублировать его в теле значит создать второе
 *    место, где оно задано.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_WARRANTY_DRAFT,
  canBeWarrantySource,
  describeWarrantySource,
  formatDate,
  warrantyDraftError,
  warrantyPayloadFields,
  warrantySourceCandidates,
} from './warranty-order';
import type { OrderListItem } from './api-types';

/** Заказ с настраиваемыми полями. */
function order(overrides: Partial<OrderListItem> = {}): OrderListItem {
  return {
    id: 'o-1',
    orderNo: 'MSK1-2509-000001',
    status: 'COMPLETED',
    statusLabel: 'Выдан',
    priority: 'NORMAL',
    totalAmountMinor: 1500000,
    paidAmountMinor: 1500000,
    remainingMinor: 0,
    dueAt: null,
    promisedAt: null,
    readyAt: '2025-09-20T12:00:00.000Z',
    createdAt: '2025-09-10T12:00:00.000Z',
    isWarranty: false,
    isOverdue: false,
    customer: { fullName: 'Иванова А.', phoneNormalized: '+79001234567' },
    createdStore: { id: 's-1', name: 'Тверская' },
    ...overrides,
  } as OrderListItem;
}

describe('Выбор исходного заказа', () => {
  it('разрешает выданный заказ', () => {
    expect(canBeWarrantySource(order({ status: 'COMPLETED' }))).toBe(true);
  });

  it('разрешает невостребованный заказ', () => {
    // Изделие изготовлено, но клиент за ним не пришёл: гарантия уже действует.
    expect(canBeWarrantySource(order({ status: 'UNCLAIMED' }))).toBe(true);
  });

  it('запрещает заказ в работе', () => {
    // Гарантия отсчитывается от выдачи; по неготовому изделию случая нет.
    expect(canBeWarrantySource(order({ status: 'IN_PRODUCTION' }))).toBe(false);
  });

  it('запрещает отменённый заказ', () => {
    expect(canBeWarrantySource(order({ status: 'CANCELLED' }))).toBe(false);
  });

  it('запрещает отклонённый заказ', () => {
    // Изделие не было принято в работу, гарантировать нечего.
    expect(canBeWarrantySource(order({ status: 'REFUSED' }))).toBe(false);
  });

  it('отбрасывает непригодные заказы из списка', () => {
    const candidates = warrantySourceCandidates([
      order({ id: 'a', status: 'IN_PRODUCTION' }),
      order({ id: 'b', status: 'COMPLETED' }),
      order({ id: 'c', status: 'CANCELLED' }),
    ]);

    expect(candidates.map((item) => item.id)).toEqual(['b']);
  });

  it('ставит свежие заказы первыми', () => {
    const candidates = warrantySourceCandidates([
      order({ id: 'old', readyAt: '2025-01-01T12:00:00.000Z' }),
      order({ id: 'new', readyAt: '2025-09-20T12:00:00.000Z' }),
      order({ id: 'mid', readyAt: '2025-05-01T12:00:00.000Z' }),
    ]);

    expect(candidates.map((item) => item.id)).toEqual(['new', 'mid', 'old']);
  });

  it('использует дату создания, когда даты готовности нет', () => {
    // У старых записей `readyAt` мог не заполняться; без отката заказ уехал бы в
    // конец списка как «самый старый» и потерялся бы.
    const candidates = warrantySourceCandidates([
      order({ id: 'no-ready', readyAt: null, createdAt: '2025-09-25T12:00:00.000Z' }),
      order({ id: 'ready', readyAt: '2025-09-20T12:00:00.000Z' }),
    ]);

    expect(candidates.map((item) => item.id)).toEqual(['no-ready', 'ready']);
  });

  it('не ломается на некорректной дате', () => {
    const candidates = warrantySourceCandidates([
      order({ id: 'broken', readyAt: 'не-дата', createdAt: 'не-дата' }),
      order({ id: 'good', readyAt: '2025-09-20T12:00:00.000Z' }),
    ]);

    // Сломанная дата не должна выбрасывать заказ из списка или ронять сортировку.
    expect(candidates.map((item) => item.id)).toEqual(['good', 'broken']);
  });

  it('не изменяет исходный массив', () => {
    const source = [
      order({ id: 'a', readyAt: '2025-01-01T12:00:00.000Z' }),
      order({ id: 'b', readyAt: '2025-09-20T12:00:00.000Z' }),
    ];
    const before = source.map((item) => item.id);

    warrantySourceCandidates(source);

    // Сортировка на месте мутировала бы состояние React-компонента.
    expect(source.map((item) => item.id)).toEqual(before);
  });
});

describe('Проверка формы гарантии', () => {
  it('не требует ничего для обычного заказа', () => {
    expect(warrantyDraftError(EMPTY_WARRANTY_DRAFT)).toBeNull();
  });

  it('требует исходный заказ для гарантийного', () => {
    expect(warrantyDraftError({ isWarranty: true, parentOrderId: '' })).toBe(
      'Выберите заказ, по которому возник случай',
    );
  });

  it('не считает выбранным заказ из пробелов', () => {
    expect(warrantyDraftError({ isWarranty: true, parentOrderId: '   ' })).not.toBeNull();
  });

  it('пропускает заполненную форму', () => {
    expect(warrantyDraftError({ isWarranty: true, parentOrderId: 'o-1' })).toBeNull();
  });
});

describe('Поля гарантии в теле запроса', () => {
  it('не отправляет поля для обычного заказа', () => {
    // `isWarranty: false` здесь был бы вторым местом, где задано умолчание.
    expect(warrantyPayloadFields(EMPTY_WARRANTY_DRAFT)).toEqual({});
  });

  it('отправляет признак и ссылку для гарантийного заказа', () => {
    expect(warrantyPayloadFields({ isWarranty: true, parentOrderId: 'o-1' })).toEqual({
      isWarranty: true,
      parentOrderId: 'o-1',
    });
  });

  it('обрезает пробелы вокруг идентификатора', () => {
    expect(warrantyPayloadFields({ isWarranty: true, parentOrderId: '  o-1  ' })).toEqual({
      isWarranty: true,
      parentOrderId: 'o-1',
    });
  });

  it('отправляет признак без ссылки, если она не выбрана', () => {
    // Признак важен сам по себе: заказ всё равно гарантийный, и его нельзя
    // записать как обычный из-за незаполненной ссылки. Ошибку формы ловит
    // `warrantyDraftError` до отправки.
    expect(warrantyPayloadFields({ isWarranty: true, parentOrderId: '' })).toEqual({
      isWarranty: true,
    });
  });
});

describe('Подпись выбранного заказа', () => {
  it('показывает номер и дату выдачи', () => {
    const orders = [order({ id: 'o-1', orderNo: 'MSK1-2509-000001' })];

    const text = describeWarrantySource(orders, 'o-1');

    // 20.09.2025 по московскому времени.
    expect(text).toContain('MSK1-2509-000001');
    expect(text).toContain('20.09.2025');
  });

  it('возвращает null, если заказ не выбран', () => {
    expect(describeWarrantySource([order()], '')).toBeNull();
  });

  it('возвращает null для заказа вне списка', () => {
    // Ссылка на заказ, которого нет в загруженном списке, ничего не объясняет.
    expect(describeWarrantySource([order({ id: 'a' })], 'b')).toBeNull();
  });
});

describe('Формат даты', () => {
  it('показывает дату московского дня', () => {
    // 21:00 UTC — уже следующие сутки в Москве (UTC+3).
    expect(formatDate('2025-09-20T21:00:00.000Z')).toBe('21.09.2025');
  });

  it('ставит прочерк на некорректной дате', () => {
    expect(formatDate('не-дата')).toBe('—');
  });
});
