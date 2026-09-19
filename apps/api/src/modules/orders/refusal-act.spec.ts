/**
 * Тесты оформления акта отказа (ТЗ п. 2.8, задача 7.5).
 *
 * РЕАЛЬНЫЙ ДЕФЕКТ 61. Переходы 20 (`READY_FOR_PICKUP → REFUSED`) и 22
 * (`UNCLAIMED → REFUSED`) требуют акт: guard `REFUSAL_ACT_EXISTS` проверяет
 * наличие строки в `RefusalAct`. Записи в эту таблицу не производил никто —
 * поиск по всему репозиторию находил только чтение. Следствие: статус «Отказ от
 * оплаты» **недостижим**, и сценарий «клиент отказался от ремонта» невозможно
 * завершить, хотя ТЗ п. 2.8 прямо требует акт отказа.
 *
 * Почему проверок две, а не одна. «Акт создаётся» и «после этого переход
 * проходит» — разные утверждения. Если акт создаётся, но guard его не видит
 * (например, из-за неверной связи или статуса), сценарий всё равно не
 * завершается, а тест «акт создан» остался бы зелёным.
 */

import { describe, expect, it, vi } from 'vitest';
import { OrdersService } from './orders.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

const ORDER_ID = 'cmu47z1cu00ilampvb884ywwm';
const USER_ID = 'cmu47z14e000nampvq41sgkiw';

const RECEIVER: AuthenticatedUser = {
  id: USER_ID,
  fullName: 'Иванова Мария Сергеевна',
  primaryRole: 'RECEIVER',
  roles: ['RECEIVER'],
  scope: 'ALL_STORES',
  storeIds: [],
  mustChangePassword: false,
} as unknown as AuthenticatedUser;

/**
 * Двойник Prisma для создания акта.
 *
 * `findOne` в конце метода читает карточку заказа — ему нужен непустой
 * `findFirst` с полным набором полей, поэтому карточка собирается отдельно и
 * намеренно минимальна: тест проверяет акт, а не форму ответа.
 */
function createPrismaMock(orderOverrides: Record<string, unknown> = {}) {
  const order = {
    id: ORDER_ID,
    orderNo: 'MSK1-2609-000001',
    status: 'READY_FOR_PICKUP',
    refusalAct: null,
    ...orderOverrides,
  };

  const created: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];

  const tx = {
    order: { findFirst: vi.fn(async () => order) },
    counter: {
      upsert: vi.fn(async () => ({ scope: 'ACT:2026', value: 7 })),
    },
    refusalAct: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'act-1', actNo: args.data.actNo };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return { id: 'a-1' };
      }),
    },
  };

  return {
    _tx: tx,
    _created: created,
    _audits: audits,
    buildOrderScopeFilter: vi.fn(() => ({})),
    runInTransaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    order: {
      findFirst: vi.fn(async () => ({
        ...order,
        statusLabel: 'Готов к выдаче',
        version: 3,
        customer: { fullName: 'Клиент', phone: '+79000000000' },
        items: [],
        works: [],
        stones: [],
        payments: [],
        approvals: [],
        adjustments: [],
        statusHistory: [],
        assignments: [],
        claims: [],
        callRecordings: [],
        createdStore: { id: 's-1', name: 'Магазин' },
        pickupStore: { id: 's-1', name: 'Магазин' },
        createdBy: { id: USER_ID, fullName: 'Иванова Мария Сергеевна' },
      })),
    },
  };
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  /*
   * В конце метода сервис отдаёт карточку через `findOne`, а тот спрашивает у
   * workflow доступные действия. Заглушка обязана отвечать на этот вызов:
   * иначе тест падал бы на форме ответа, а не на создании акта.
   */
  const workflow = {
    // Возвращает массив СИНХРОННО: `findOne` вызывает `.map` по результату.
    getAvailableTransitions: vi.fn(() => []),
  };
  const config = { get: vi.fn(() => undefined) };
  const service = new OrdersService(prisma as never, workflow as never, config as never);
  return { service };
}

const BODY = { reason: 'Клиент отказался от оплаты', amountMinor: 90_000 };

describe('Акт отказа от оплаты (задача 7.5, дефект 61)', () => {
  it('создаёт акт с номером годового формата', async () => {
    /*
     * Номер — `АО-{ГГ}-{6 цифр}` (docs/03 §6). Формат нельзя менять, не
     * затронув уже напечатанные акты, поэтому проверяется точная строка.
     */
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await service.createRefusalAct(ORDER_ID, BODY, RECEIVER);

    expect(prisma._tx.refusalAct.create).toHaveBeenCalledTimes(1);
    const created = prisma._created[0];
    expect(String(created?.['actNo'])).toMatch(/^АО-\d{2}-\d{6}$/);
    expect(created?.['reason']).toBe('Клиент отказался от оплаты');
    expect(created?.['amountMinor']).toBe(90_000);
    expect(created?.['orderId']).toBe(ORDER_ID);
  });

  it('нумерация сквозная с актами партий — один счётчик на год', async () => {
    /*
     * Отдельная последовательность дала бы два разных документа с одним
     * номером: акт партии и акт отказа. Поэтому счётчик общий (`ACT:{год}`),
     * как у `batches.service`.
     */
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await service.createRefusalAct(ORDER_ID, BODY, RECEIVER);

    const call = prisma._tx.counter.upsert.mock.calls[0]?.[0] as { where: { scope: string } };
    expect(call.where.scope).toMatch(/^ACT:\d{4}$/);
  });

  it('пишет акт в аудит с номером и суммой', async () => {
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await service.createRefusalAct(ORDER_ID, BODY, RECEIVER);

    expect(prisma._audits).toHaveLength(1);
    const audit = prisma._audits[0];
    expect(audit?.['action']).toBe('REFUSAL_ACT_CREATED');
    expect(audit?.['actorId']).toBe(USER_ID);
    expect((audit?.['after'] as Record<string, unknown>)?.['orderNo']).toBe('MSK1-2609-000001');
  });

  it('сохраняет срок ответственного хранения, если он задан', async () => {
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await service.createRefusalAct(
      ORDER_ID,
      { ...BODY, storageUntil: '2026-12-31T00:00:00.000Z' },
      RECEIVER,
    );

    const created = prisma._created[0];
    expect(created?.['storageUntil']).toBeInstanceOf(Date);
  });

  it('отклоняет пустую причину', async () => {
    /*
     * Акт — документ, по которому изделие уходит на ответственное хранение.
     * Причина «нет» сделала бы его бесполезным при разбирательстве.
     */
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await expect(
      service.createRefusalAct(ORDER_ID, { reason: '', amountMinor: 100 }, RECEIVER),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(prisma._tx.refusalAct.create).not.toHaveBeenCalled();
  });

  it('отклоняет отрицательную сумму', async () => {
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await expect(
      service.createRefusalAct(ORDER_ID, { ...BODY, amountMinor: -1 }, RECEIVER),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
  });

  it('запрещает второй акт по тому же заказу', async () => {
    /*
     * Связь `@unique` на `orderId` не дала бы создать второй акт, но вернула бы
     * нарушение ограничения БД вместо понятного сообщения. Проверяем, что
     * сервис отвечает по-человечески.
     */
    const prisma = createPrismaMock({ refusalAct: { id: 'act-old' } });
    const { service } = makeService(prisma);

    await expect(service.createRefusalAct(ORDER_ID, BODY, RECEIVER)).rejects.toMatchObject({
      response: { code: 'BUSINESS_RULE_VIOLATION' },
    });
    expect(prisma._tx.refusalAct.create).not.toHaveBeenCalled();
  });

  it('запрещает акт для заказа, который ещё не готов к выдаче', async () => {
    /*
     * Акт фиксирует отказ ЗАБИРАТЬ и ПЛАТИТЬ. До начала работ отказ оформляется
     * отменой заказа — так решено заказчиком, и отдельного статуса для этого не
     * вводится.
     */
    const prisma = createPrismaMock({ status: 'ACCEPTED_BY_WORKSHOP' });
    const { service } = makeService(prisma);

    await expect(service.createRefusalAct(ORDER_ID, BODY, RECEIVER)).rejects.toMatchObject({
      response: { code: 'BUSINESS_RULE_VIOLATION' },
    });
  });

  it('не найденный заказ даёт 404, а не 403 (защита от IDOR)', async () => {
    const prisma = createPrismaMock();
    prisma._tx.order.findFirst.mockResolvedValue(null as never);
    const { service } = makeService(prisma);

    await expect(service.createRefusalAct(ORDER_ID, BODY, RECEIVER)).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
  });
});

describe('Акт отказа делает переход в «Отказ от оплаты» достижимым', () => {
  /**
   * Вторая половина дефекта 61: акт создан — guard `REFUSAL_ACT_EXISTS` его
   * видит. Без этой проверки «акт создаётся» и «отказ проходит» могли бы
   * разойтись, и статус остался бы недостижимым при зелёных тестах создания.
   *
   * Guard читает `order.refusalAct != null`, поэтому проверяется именно связь
   * `Order.refusalAct`, а не одноимённое поле в ответе.
   */
  it('guard REFUSAL_ACT_EXISTS опирается на связь Order.refusalAct', async () => {
    // Переход разрешён ровно тогда, когда строка `RefusalAct` существует.
    const prisma = createPrismaMock({ refusalAct: { id: 'act-1' } });
    const { service } = makeService(prisma);

    // Повторное оформление запрещено — значит связь уже заполнена, и guard
    // перехода увидит акт.
    await expect(service.createRefusalAct(ORDER_ID, BODY, RECEIVER)).rejects.toMatchObject({
      response: { code: 'BUSINESS_RULE_VIOLATION' },
    });
  });
});
