/**
 * Тесты сброса кэша отчётов при приёме денег (задача 5.7).
 *
 * ЗАЧЕМ ЭТОТ ТЕСТ ОТДЕЛЬНО. Выручка и предоплаты считаются из платежей. Если
 * после приёма оплаты кэш не сбросить, кассир примет деньги, откроет отчёт и НЕ
 * УВИДИТ свою операцию: отчёт покажет картину, посчитанную до оплаты, и будет
 * выглядеть при этом совершенно обычным. Ошибку заметят не сразу и не свяжут с
 * кэшем — поэтому проверка нужна отдельная.
 *
 * Проверяется именно УСПЕШНЫЙ платёж: отклонённый (не найдено, закрытый заказ,
 * переплата) ничего не изменил, и сбрасывать по нему кэш значило бы заставлять
 * следующий запрос считать отчёты заново без причины.
 */

import { describe, expect, it } from 'vitest';
import { DATA_SCOPE, REPORT_NAME } from '@app/shared';
import { PaymentsService } from './payments.service';
import { ReportsCacheService } from '../../common/cache/reports-cache.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

const STORE = 'cmu5p70yu0002bm7pzqlcawsw';

function reportStub() {
  return {
    meta: {
      from: '2025-09-01',
      to: '2025-09-30',
      generatedAt: '2025-09-30T12:00:00.000Z',
      cached: false,
      rowCount: 0,
    },
    columns: [],
    rows: [],
    totals: {},
  };
}

function user(): AuthenticatedUser {
  return {
    id: 'u-1',
    email: 'cashier@remixgold.ru',
    roles: [],
    primaryRole: 'CASHIER',
    scope: DATA_SCOPE.ALL_STORES,
    scopes: [DATA_SCOPE.ALL_STORES],
    storeIds: [STORE],
  } as unknown as AuthenticatedUser;
}

/**
 * Двойник Prisma, доводящий приём платежа до успеха.
 *
 * Возвращает `runInTransaction` тем же объектом, что и обычный клиент: сервис
 * читает заказ внутри транзакции, и разделять их здесь незачем.
 */
function prismaDouble(overrides: Record<string, unknown> = {}) {
  const created = { id: 'p-1' };
  const tx = {
    order: {
      findFirst: async () => ({
        id: 'o-1',
        status: 'ACCEPTED',
        totalAmountMinor: 100000,
        paidAmountMinor: 0,
      }),
      update: async () => ({ id: 'o-1' }),
    },
    payment: {
      findUnique: async () => null,
      findMany: async () => [{ amountMinor: 50000, kind: 'FINAL' }],
      create: async () => created,
    },
    auditLog: { create: async () => ({ id: 'a-1' }) },
  };

  const prisma = {
    payment: {
      findUnique: async () => null,
      findUniqueOrThrow: async () => ({
        id: 'p-1',
        orderId: 'o-1',
        kind: 'PAYMENT',
        method: 'CARD',
        status: 'CONFIRMED',
        amountMinor: 50000,
        storeId: STORE,
        paidAt: new Date('2025-09-30T12:00:00.000Z'),
        receiptNo: null,
        comment: null,
        createdAt: new Date('2025-09-30T12:00:00.000Z'),
        cashier: { id: 'u-1', fullName: 'Кассир' },
      }),
    },
    order: {
      findUniqueOrThrow: async () => ({
        id: 'o-1',
        orderNo: 'MSK1-2509-000001',
        totalAmountMinor: 100000,
        paidAmountMinor: 50000,
        prepaymentRequiredMinor: 0,
        requiresPrepayment: false,
      }),
    },
    buildOrderScopeFilter: () => ({}),
    runInTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    ...overrides,
  };

  return { prisma, tx };
}

const validPayment = {
  kind: 'FINAL',
  method: 'CARD',
  amountMinor: 50000,
  storeId: STORE,
  paidAt: '2025-09-30T12:00:00.000Z',
};

describe('Сброс кэша отчётов при приёме платежа (задача 5.7)', () => {
  it('успешный платёж сбрасывает выручку и предоплаты', async () => {
    /*
     * Кассир принял деньги и сразу открыл отчёт — он обязан увидеть свою
     * операцию. Без сброса отчёт показывал бы сумму до оплаты и выглядел бы
     * обычным: ошибку не связали бы с кэшем.
     */
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.REVENUE}|x`, reportStub(), 60_000);
    cache.set(`${REPORT_NAME.PREPAYMENTS}|x`, reportStub(), 60_000);

    const { prisma } = prismaDouble();
    const service = new PaymentsService(prisma as never, cache);

    await service.createPayment('o-1', validPayment, 'key-1', user());

    expect(cache.size()).toBe(0);
  });

  it('платёж НЕ сбрасывает отчёты, не связанные с деньгами', async () => {
    /*
     * Сроки этапов и загрузка цеха от платежа не меняются. Сбросить их значило бы
     * заставить следующий запрос считать эти отчёты заново без причины — а они
     * самые тяжёлые.
     */
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.STAGE_DURATIONS}|x`, reportStub(), 60_000);
    cache.set(`${REPORT_NAME.WORKSHOP_LOAD}|x`, reportStub(), 60_000);

    const { prisma } = prismaDouble();
    const service = new PaymentsService(prisma as never, cache);

    await service.createPayment('o-1', validPayment, 'key-1', user());

    expect(cache.size()).toBe(2);
  });

  it('отклонённый платёж кэш не сбрасывает', async () => {
    /*
     * Заказ не найден (или вне области видимости) — данных не изменилось.
     * Сброс по неудачной операции заставлял бы считать отчёты заново без причины.
     */
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.REVENUE}|x`, reportStub(), 60_000);

    const { prisma, tx } = prismaDouble();
    tx.order.findFirst = async () => null;
    const service = new PaymentsService(prisma as never, cache);

    await service.createPayment('o-1', validPayment, 'key-1', user()).catch(() => undefined);

    expect(cache.size()).toBe(1);
  });

  it('повторный платёж по тому же ключу кэш не сбрасывает', async () => {
    /*
     * Идемпотентность: второй запрос ничего не создаёт. Первый уже сбросил кэш,
     * и повторять сброс незачем — иначе двойной клик кассира стоил бы двух
     * пересчётов отчётов.
     */
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.REVENUE}|x`, reportStub(), 60_000);

    const { prisma } = prismaDouble({
      payment: {
        findUnique: async () => ({ id: 'p-1', orderId: 'o-1' }),
        findUniqueOrThrow: async () => ({
          id: 'p-1',
          orderId: 'o-1',
          kind: 'FINAL',
          method: 'CARD',
          status: 'CONFIRMED',
          amountMinor: 50000,
          storeId: STORE,
          paidAt: new Date('2025-09-30T12:00:00.000Z'),
          receiptNo: null,
          comment: null,
          createdAt: new Date('2025-09-30T12:00:00.000Z'),
          cashier: { id: 'u-1', fullName: 'Кассир' },
        }),
      },
    });
    const service = new PaymentsService(prisma as never, cache);

    await service.createPayment('o-1', validPayment, 'key-1', user());

    expect(cache.size()).toBe(1);
  });

  it('без ключа идемпотентности платёж отклоняется и кэш не сбрасывается', async () => {
    // Ключ обязателен для операций с деньгами: без него повтор создал бы второй
    // платёж. Отклонение означает, что данных не изменилось.
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.REVENUE}|x`, reportStub(), 60_000);

    const { prisma } = prismaDouble();
    const service = new PaymentsService(prisma as never, cache);

    await expect(
      service.createPayment('o-1', validPayment, undefined, user()),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    expect(cache.size()).toBe(1);
  });
});
