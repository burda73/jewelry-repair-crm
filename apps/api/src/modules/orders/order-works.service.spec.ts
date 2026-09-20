/**
 * Состав работ заказа: добавление, изменение, удаление (требование заказчика).
 *
 * ПОЧЕМУ ТЕСТЫ СМОТРЯТ НА ЗАПРОСЫ К БАЗЕ. Сервис — это не только «что вернул»,
 * но и «что записал». Здесь важны три вещи, которые не видны в ответе API:
 *
 *  * ИТОГ ПЕРЕСЧИТАН. Правка состава без пересчёта оставила бы в заказе старую
 *    сумму, и клиент получил бы квитанцию на одну сумму, а платил бы другую.
 *    Такой дефект не проявляется ошибкой — он проявляется деньгами.
 *  * СОСТАВ ЗАФИКСИРОВАН ПОСЛЕ ВЫДАЧИ. Работы правятся только до выдачи
 *    исполнителю; после — объём уже выполняется.
 *  * ЦЕНА ВЗЯТА ИЗ ПРЕЙСКУРАНТА. Позиция прейскуранта не может приехать в заказ
 *    с ценой из тела запроса: иначе прейскурант обходится одной строкой JSON.
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { OrderWorksService } from './order-works.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/** Валидный cuid: схема `addOrderWorkSchema` проверяет формат идентификатора. */
const PRICE_ITEM_ID = 'clx0000000000000000000pl1';

function manager(): AuthenticatedUser {
  return {
    id: 'u-1',
    email: 'manager@remixgold.ru',
    roles: ['MANAGER'],
    primaryRole: 'MANAGER',
    scope: 'ALL_STORES',
    scopes: ['ALL_STORES'],
    storeIds: [],
  } as unknown as AuthenticatedUser;
}

interface TxOptions {
  status?: string;
  worksCount?: number;
  item?: { id: string; metal: string | null } | null;
  priceItem?: Record<string, unknown> | null;
  version?: number;
}

/**
 * Транзакция-заглушка.
 *
 * Возвращает перехваченные вызовы, чтобы проверять не только ответ, но и
 * записанные данные: сумма строки и итог заказа считаются здесь, а не в
 * контроллере, и увидеть их можно только так.
 */
function makeService(options: TxOptions = {}) {
  // Этап приёма: правка состава здесь разрешена (это и проверяем).
  const status = options.status ?? 'ACCEPTED';
  const workCreate = vi.fn(async () => ({ id: 'w-new' }));
  const workUpdate = vi.fn(async () => ({ id: 'w-1' }));
  const workDelete = vi.fn(async () => ({ id: 'w-1' }));
  const orderUpdate = vi.fn(async () => ({ id: 'o-1' }));

  const tx = {
    order: {
      findFirst: async () => ({ id: 'o-1', orderNo: 'MSK1-2609-000001', status }),
      findUnique: async () => ({ version: options.version ?? 3 }),
      findUniqueOrThrow: async () => ({ discountMinor: 0 }),
      update: orderUpdate,
    },
    item: {
      findFirst: async () =>
        options.item === undefined ? { id: 'i-1', metal: 'SILVER' } : options.item,
    },
    priceListItem: {
      findFirst: async () =>
        options.priceItem === undefined
          ? {
              code: 'POL',
              name: 'Полировка',
              unit: 'шт',
              priceMinor: 50_000,
              priceFrom: false,
              metalCostSeparate: false,
              rates: [{ metal: 'SILVER', priceMinor: 30_000, isFrom: false }],
            }
          : options.priceItem,
    },
    orderWork: {
      create: workCreate,
      update: workUpdate,
      delete: workDelete,
      findFirst: async () => ({
        id: 'w-1',
        code: 'POL',
        name: 'Полировка',
        quantity: 1,
        unitPriceMinor: 50_000,
        amountMinor: 50_000,
      }),
      count: async () => options.worksCount ?? 2,
      aggregate: async () => ({ _sum: { amountMinor: 50_000 } }),
    },
    orderStone: { aggregate: async () => ({ _sum: { amountMinor: 20_000 } }) },
    auditLog: { create: vi.fn(async () => ({ id: 'a-1' })) },
  };

  const prisma = {
    buildOrderScopeFilter: () => ({}),
    runInTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };

  const service = new OrderWorksService(prisma as never);
  return { service, tx, workCreate, workUpdate, workDelete, orderUpdate };
}

/** Тело `data` из вызова `order.update`. */
function totalsOf(orderUpdate: ReturnType<typeof vi.fn>): Record<string, number> {
  const call = orderUpdate.mock.calls[0] as unknown as [unknown] | undefined;
  const args = call?.[0] as { data?: Record<string, number> } | undefined;
  return args?.data ?? {};
}

describe('Состав работ: пересчёт итога заказа', () => {
  it('итог считается как работы + камни − скидка', () => {
    /*
     * Главная проверка денег. Считает общая функция `calcOrderTotal`, а не
     * сложение в сервисе: `discountMinor` бывает отрицательным (надбавка), и
     * ручное «минус скидка» в одном месте из двух уже давало расхождение.
     */
    const { service, orderUpdate } = makeService();

    return service.add('o-1', { name: 'Полировка', unitPriceMinor: 50_000 }, manager()).then(() => {
      const totals = totalsOf(orderUpdate);
      // 50 000 работ + 20 000 камней − 0 скидки
      expect(totals.totalAmountMinor).toBe(70_000);
      expect(totals.worksTotalMinor).toBe(50_000);
      expect(totals.stonesTotalMinor).toBe(20_000);
    });
  });

  it('суммы строк берутся из базы, а не из тела запроса', () => {
    /*
     * Если бы итог считался по присланным числам, клиент мог бы прислать одну
     * сумму, а в заказ записалась бы другая строка — и итог описывал бы не то,
     * что лежит в заказе.
     */
    const { service, orderUpdate } = makeService();

    return service
      .add('o-1', { name: 'Полировка', unitPriceMinor: 999_999 }, manager())
      .then(() => {
        // Агрегат заглушки возвращает 50 000 независимо от тела запроса.
        expect(totalsOf(orderUpdate).worksTotalMinor).toBe(50_000);
      });
  });

  it('версия заказа увеличивается, чтобы чужая правка не затёрла состав', () => {
    const { service, orderUpdate } = makeService();

    return service.add('o-1', { name: 'Полировка', unitPriceMinor: 100 }, manager()).then(() => {
      const args = orderUpdate.mock.calls[0]?.[0] as { data?: { version?: unknown } };
      expect(args.data?.version).toEqual({ increment: 1 });
    });
  });
});

describe('Состав работ: цена из прейскуранта', () => {
  it('цена позиции прейскуранта берётся по металлу изделия', async () => {
    /*
     * Металл изделия — серебро, у позиции есть серебряная ставка 30 000.
     * Применить цену по умолчанию (50 000) значило бы посчитать серебряный
     * заказ по золотому тарифу. Такой дефект в проекте уже случался.
     */
    const { service, workCreate } = makeService({
      item: { id: 'i-1', metal: 'SILVER' },
    });

    await service.add('o-1', { priceListItemId: PRICE_ITEM_ID, quantity: 2 }, manager());

    const args = workCreate.mock.calls[0]?.[0] as { data: Record<string, number> };
    expect(args.data.unitPriceMinor).toBe(30_000);
    // Сумма строки = цена × количество, а не цена.
    expect(args.data.amountMinor).toBe(60_000);
  });

  it('название и код берутся из прейскуранта, а не из тела запроса', async () => {
    /*
     * Иначе «Полировка» из прейскуранта уехала бы в квитанцию под названием,
     * которое прислал клиент, — а клиент увидел бы не то, что заказывал.
     */
    const { service, workCreate } = makeService();

    await service.add(
      'o-1',
      { priceListItemId: PRICE_ITEM_ID, name: 'Что-то другое', code: 'XXX' },
      manager(),
    );

    const args = workCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.name).toBe('Полировка');
    expect(args.data.code).toBe('POL');
  });

  it('НЕ берёт цену из тела для позиции прейскуранта', async () => {
    // Прейскурант существует ровно для того, чтобы цены не назначались на месте.
    const { service, workCreate } = makeService();

    await service.add('o-1', { priceListItemId: PRICE_ITEM_ID, unitPriceMinor: 1 }, manager());

    const args = workCreate.mock.calls[0]?.[0] as { data: Record<string, number> };
    expect(args.data.unitPriceMinor).not.toBe(1);
    expect(args.data.unitPriceMinor).toBe(30_000);
  });

  it('несуществующая позиция прейскуранта — ошибка, а не работа с нулевой ценой', async () => {
    // Молча создать строку с ценой 0 значило бы отдать работу бесплатно.
    const { service } = makeService({ priceItem: null });

    await expect(
      service.add('o-1', { priceListItemId: PRICE_ITEM_ID }, manager()),
    ).rejects.toThrow();
  });
});

describe('Состав работ: когда менять нельзя', () => {
  it('закрытый заказ — состав не меняется', async () => {
    const { service } = makeService({ status: 'COMPLETED' });

    await expect(
      service.add('o-1', { name: 'Полировка', unitPriceMinor: 100 }, manager()),
    ).rejects.toMatchObject({ response: { code: 'ORDER_FINAL' } });
  });

  it('работы уже выданы исполнителю — состав зафиксирован', () => {
    /*
     * После выдачи ювелир работает по определённому объёму. Правка задним
     * числом означала бы, что заказ описывает не то, что выполняли, — а
     * проверить это по докуменам уже нельзя.
     */
    const { service } = makeService({ status: 'IN_WORK' });

    return service.add('o-1', { name: 'Полировка', unitPriceMinor: 100 }, manager()).then(
      () => expect.unreachable('должно было отклонить'),
      (error: ConflictException) => {
        expect(error.getResponse()).toMatchObject({ code: 'WORKS_LOCKED' });
      },
    );
  });

  it('работы в доработке тоже не правятся', async () => {
    const { service } = makeService({ status: 'REWORK' });

    await expect(
      service.add('o-1', { name: 'Полировка', unitPriceMinor: 100 }, manager()),
    ).rejects.toMatchObject({ response: { code: 'WORKS_LOCKED' } });
  });

  it('приём заказа: работы правятся', async () => {
    // Обратная сторона: на этапах приёма и согласования состав менять можно,
    // иначе функцию нельзя было бы использовать по назначению.
    for (const status of ['DRAFT', 'AWAITING_APPROVAL', 'AWAITING_PREPAYMENT', 'ACCEPTED']) {
      const { service, workCreate } = makeService({ status });
      await service.add('o-1', { name: 'Полировка', unitPriceMinor: 100 }, manager());
      expect(workCreate, `статус ${status}`).toHaveBeenCalled();
    }
  });

  it('чужой заказ не виден — 404, а не 403', async () => {
    // 403 раскрыл бы существование чужого заказа (защита от IDOR).
    const { service } = makeService();
    const prisma = (service as unknown as { prisma: { runInTransaction: unknown } }).prisma;
    void prisma;

    const scoped = new OrderWorksService({
      buildOrderScopeFilter: () => ({ storeId: 'чужой' }),
      runInTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          order: { findFirst: async () => null },
        }),
    } as never);

    await expect(
      scoped.add('o-1', { name: 'Полировка', unitPriceMinor: 100 }, manager()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Состав работ: удаление', () => {
  it('последнюю работу удалить нельзя', () => {
    /*
     * Заказ без работ — это заказ без согласованной суммы: итог станет нулём,
     * и в работу он уже не пойдёт. Оставлять такое состояние незачем: сотрудник
     * всё равно упрётся в следующем шаге, только непонятно почему.
     */
    const { service } = makeService({ worksCount: 1 });

    return service.remove('o-1', 'w-1', { version: 3, reason: 'Не нужна' }, manager()).then(
      () => expect.unreachable('должно было отклонить'),
      (error: ConflictException) => {
        expect(error.getResponse()).toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      },
    );
  });

  it('причина удаления обязательна', async () => {
    // Удаление строки меняет сумму, за которую платит клиент: без причины в
    // аудите осталось бы «работу убрали», но не почему.
    const { service, workDelete } = makeService({ worksCount: 3 });

    await expect(service.remove('o-1', 'w-1', { version: 3 }, manager())).rejects.toThrow();
    expect(workDelete).not.toHaveBeenCalled();
  });

  it('удаление пересчитывает итог', async () => {
    const { service, orderUpdate, workDelete } = makeService({ worksCount: 3 });

    await service.remove('o-1', 'w-1', { version: 3, reason: 'Клиент отказался' }, manager());

    expect(workDelete).toHaveBeenCalled();
    expect(totalsOf(orderUpdate).totalAmountMinor).toBe(70_000);
  });
});

describe('Состав работ: одновременная правка', () => {
  it('устаревшая версия отклоняется', () => {
    /*
     * Без проверки версии двое сотрудников затрут правки друг друга молча:
     * второй сохранит состав, не зная, что первый его уже изменил.
     */
    const { service } = makeService({ version: 5 });

    return service.update('o-1', 'w-1', { version: 3, quantity: 2 }, manager()).then(
      () => expect.unreachable('должно было отклонить'),
      (error: ConflictException) => {
        expect(error.getResponse()).toMatchObject({ code: 'VERSION_CONFLICT' });
      },
    );
  });

  it('совпадающая версия пропускается', async () => {
    const { service, workUpdate } = makeService({ version: 3 });

    await service.update('o-1', 'w-1', { version: 3, quantity: 2 }, manager());

    expect(workUpdate).toHaveBeenCalled();
  });
});

describe('Состав работ: изменение строки', () => {
  it('сумма строки пересчитывается при изменении количества', async () => {
    const { service, workUpdate } = makeService();

    await service.update('o-1', 'w-1', { version: 3, quantity: 3 }, manager());

    const args = workUpdate.mock.calls[0]?.[0] as { data: Record<string, number> };
    // Цена строки 50 000 (из findFirst), количество 3.
    expect(args.data.amountMinor).toBe(150_000);
  });

  it('сумма строки пересчитывается и при изменении ТОЛЬКО количества', async () => {
    /*
     * Сумму пересчитывает сервер, а не тот, кто прислал запрос. Если бы она
     * приходила из тела, клиент мог бы рассинхронизировать её с количеством и
     * ценой — и итог заказа перестал бы соответствовать строкам.
     */
    const { service, workUpdate } = makeService();

    await service.update('o-1', 'w-1', { version: 3, unitPriceMinor: 10_000 }, manager());

    const args = workUpdate.mock.calls[0]?.[0] as { data: Record<string, number> };
    expect(args.data.amountMinor).toBe(10_000);
  });
});
