/**
 * Тесты дашборда просрочек (задача 2.9, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Эскалация сообщает о просрочке адресно, но руководителю
 * нужно видеть картину: сколько просрочено, где и насколько. Без этого каждая
 * просрочка разбирается как отдельный случай, а общая причина (например, цех
 * перегружен) не видна.
 *
 * Проверяются правила, которые нельзя увидеть в схеме валидации:
 *
 *  * дашборд считается по `dueAt`, а НЕ по факту отправки уведомления: иначе он
 *    скрыл бы ровно те заказы, которые остались без оповещения;
 *  * набор заказов совпадает с набором воркера эскалаций: расхождение означало
 *    бы, что дашборд показывает просрочку, о которой никого не оповестили;
 *  * самые задержанные идут сверху: именно они требуют вмешательства первыми.
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverdueDashboardService } from './overdue-dashboard.service';

const STORE_A = 'cmu5p70yu0002bm7pzqlcawsw';
const STORE_B = 'cmu5p70yu0003bm7pzqlcawsw';

/** Понедельник, 15 сентября 2025 года, 12:00 МСК. */
const NOW = new Date('2025-09-15T09:00:00Z');
const msk = (iso: string): Date => new Date(`${iso}+03:00`);

/** Сроки с посчитанным числом рабочих часов до `NOW`. */
const DUE_11_HOURS = msk('2025-09-12T10:00:00');
const DUE_3_HOURS = msk('2025-09-12T18:00:00');
const DUE_1_HOUR = msk('2025-09-15T11:00:00');

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o-1',
    orderNo: 'MSK1-2509-000001',
    status: 'IN_PRODUCTION',
    dueAt: DUE_3_HOURS,
    escalationLevel: 0,
    totalAmountMinor: 100000,
    createdStoreId: STORE_A,
    createdStore: { name: 'Тверская' },
    customer: { fullName: 'Клиентов Иван Петрович' },
    ...overrides,
  };
}

function makeService(rows: unknown[] = []) {
  const client = { order: { findMany: vi.fn(async () => rows) } };
  const workflow = { loadCalendar: vi.fn(async () => ({ overrides: new Map(), defaultHours: 9 })) };
  const service = new OverdueDashboardService(client as never, workflow as never);
  return { service, client, workflow };
}

describe('Дашборд просрочек: выборка (задача 2.9)', () => {
  it('просрочка считается по dueAt, а не по факту уведомления', async () => {
    /*
     * Дашборд обязан показывать просрочку и тогда, когда уведомление не ушло:
     * недоступная почта не отменяет просроченный срок. Обратная зависимость
     * скрыла бы ровно те заказы, которые остались без оповещения.
     */
    const { service, client } = makeService();
    await service.build(NOW);

    const where = client.order.findMany.mock.calls[0][0].where;
    expect(where.dueAt).toEqual({ not: null, lt: NOW });
    // Условие по `escalatedAt` НЕ добавляется.
    expect(where.escalatedAt).toBeUndefined();
  });

  it('закрытые и ожидающие оплаты заказы исключены', async () => {
    // Набор обязан совпадать с воркером эскалаций: иначе дашборд показывал бы
    // просрочку, о которой никого не оповестили.
    const { service, client } = makeService();
    await service.build(NOW);

    const excluded = client.order.findMany.mock.calls[0][0].where.status.notIn as string[];
    expect(excluded).toContain('COMPLETED');
    expect(excluded).toContain('CANCELLED');
    expect(excluded).toContain('AWAITING_PREPAYMENT');
    expect(excluded).toContain('UNCLAIMED');
  });

  it('пустой список даёт пустой дашборд без обращения к календарю', async () => {
    const { service, workflow } = makeService([]);
    const result = await service.build(NOW);

    expect(result.total).toBe(0);
    expect(result.orders).toEqual([]);
    expect(workflow.loadCalendar).not.toHaveBeenCalled();
  });

  it('заказ в срок не попадает в дашборд', async () => {
    // `dueAt` в будущем — просрочки нет.
    const { service } = makeService([orderRow({ dueAt: msk('2025-09-15T18:00:00') })]);
    const result = await service.build(NOW);

    expect(result.total).toBe(0);
  });
});

describe('Дашборд просрочек: содержимое (задача 2.9)', () => {
  it('считаются всего, сумма и требующие руководителя', async () => {
    const { service } = makeService([
      orderRow({ id: 'o-1', totalAmountMinor: 100000, dueAt: DUE_3_HOURS }),
      orderRow({ id: 'o-2', totalAmountMinor: 250000, dueAt: DUE_11_HOURS }),
    ]);

    const result = await service.build(NOW);

    expect(result.total).toBe(2);
    expect(result.totalAmountMinor).toBe(350000);
    // 11 рабочих часов просрочки — это больше рабочего дня (9 часов).
    expect(result.needsManager).toBe(1);
  });

  it('самые задержанные идут первыми', async () => {
    /*
     * Дашборд существует, чтобы увидеть, за что взяться первым. Сортировка по
     * дате создания поставила бы пропавший на сутки заказ ниже вчерашнего.
     */
    const { service } = makeService([
      orderRow({ id: 'o-fresh', orderNo: 'П-1', dueAt: DUE_1_HOUR }),
      orderRow({ id: 'o-late', orderNo: 'П-2', dueAt: DUE_11_HOURS }),
      orderRow({ id: 'o-mid', orderNo: 'П-3', dueAt: DUE_3_HOURS }),
    ]);

    const result = await service.build(NOW);

    expect(result.orders.map((order) => order.orderNo)).toEqual(['П-2', 'П-3', 'П-1']);
    expect(result.orders[0]?.overdueWorkingHours).toBeGreaterThan(
      result.orders[1]?.overdueWorkingHours ?? 0,
    );
  });

  it('просрочка показывается в рабочих часах', async () => {
    // «Просрочено на 11 календарных часов» с пятницы — это 2 рабочих часа;
    // календарный счёт показал бы срок, которого не было.
    const { service } = makeService([orderRow({ dueAt: DUE_1_HOUR })]);

    const result = await service.build(NOW);

    expect(result.orders[0]?.overdueWorkingHours).toBeCloseTo(1, 5);
  });

  it('в строке есть магазин, клиент и сумма', async () => {
    // Без магазина непонятно, куда идти, без клиента — кого спрашивать.
    const { service } = makeService([orderRow()]);

    const result = await service.build(NOW);

    const order = result.orders[0];
    expect(order?.storeName).toBe('Тверская');
    expect(order?.customerName).toBe('Клиентов Иван Петрович');
    expect(order?.totalAmountMinor).toBe(100000);
    expect(order?.dueAt).toBe(DUE_3_HOURS.toISOString());
  });
});

describe('Дашборд просрочек: разрезы (задача 2.9)', () => {
  it('разрез по магазинам считает число и сумму', async () => {
    // Разрез нужен, чтобы увидеть, ГДЕ сосредоточены просрочки.
    const { service } = makeService([
      orderRow({ id: 'o-1', createdStoreId: STORE_A, totalAmountMinor: 100000 }),
      orderRow({ id: 'o-2', createdStoreId: STORE_A, totalAmountMinor: 50000 }),
      orderRow({
        id: 'o-3',
        createdStoreId: STORE_B,
        createdStore: { name: 'Арбат' },
        totalAmountMinor: 70000,
      }),
    ]);

    const result = await service.build(NOW);

    expect(result.byStore[0]).toEqual({
      key: STORE_A,
      label: 'Тверская',
      count: 2,
      totalAmountMinor: 150000,
    });
    expect(result.byStore[1]?.count).toBe(1);
  });

  it('разрез по этапам использует понятные названия', async () => {
    // Код `IN_PRODUCTION` в интерфейсе ничего не говорит приёмщику.
    const { service } = makeService([
      orderRow({ id: 'o-1', status: 'IN_PRODUCTION' }),
      orderRow({ id: 'o-2', status: 'QUEUED_FOR_DISPATCH' }),
      orderRow({ id: 'o-3', status: 'IN_PRODUCTION' }),
    ]);

    const result = await service.build(NOW);

    const production = result.byStage.find((group) => group.key === 'IN_PRODUCTION');
    expect(production?.label).toBe('Производство');
    expect(production?.count).toBe(2);
    expect(result.byStage.find((g) => g.key === 'QUEUED_FOR_DISPATCH')?.label).toBe(
      'Очередь на отправку',
    );
  });

  it('разрезы отсортированы по числу заказов', async () => {
    /*
     * Больные места сверху: разрез существует ради этого, а не ради перечисления
     * магазинов по алфавиту.
     *
     * Магазин с БОЛЬШИМ числом просрочек идёт ПЕРВЫМ во входных данных, поэтому
     * без сортировки порядок вставки случайно совпал бы с ожидаемым и тест
     * ничего не проверял. Проверяется порядок при обратном входе: единственная
     * просрочка приходит раньше двух, и правильный ответ требует перестановки.
     */
    const { service } = makeService([
      orderRow({ id: 'o-1', createdStoreId: STORE_B, createdStore: { name: 'Арбат' } }),
      orderRow({ id: 'o-2', createdStoreId: STORE_A }),
      orderRow({ id: 'o-3', createdStoreId: STORE_A }),
    ]);

    const result = await service.build(NOW);

    expect(result.byStore.map((group) => group.key)).toEqual([STORE_A, STORE_B]);
    expect(result.byStore.map((group) => group.count)).toEqual([2, 1]);
  });
});
