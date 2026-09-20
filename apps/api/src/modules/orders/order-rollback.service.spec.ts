/**
 * Откат заказа до состояния из истории (инструмент администратора).
 *
 * ПОЧЕМУ ЗДЕСЬ ТАК МНОГО ПРОВЕРОК. Откат ОБХОДИТ таблицу переходов: он не
 * проходит через `OrderWorkflowService.transition`, а значит, не получает ни
 * одной из её гарантий — ни проверки роли по таблице, ни условий перехода, ни
 * проверки версии. Всё это приходится обеспечивать заново, и ошибка не
 * проявляется отказом: она проявляется заказом в состоянии, из которого нет
 * выхода.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { OrderRollbackService } from './order-rollback.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

function admin(): AuthenticatedUser {
  return {
    id: 'u-admin',
    email: 'admin@remixgold.ru',
    roles: ['ADMIN'],
    primaryRole: 'ADMIN',
    scope: 'ALL_STORES',
    scopes: ['ALL_STORES'],
    storeIds: [],
  } as unknown as AuthenticatedUser;
}

interface Options {
  status?: string;
  version?: number;
  history?: Array<{ toStatus: string; createdAt: Date }>;
  updateCount?: number;
}

function makeService(options: Options = {}) {
  const history = options.history ?? [
    { toStatus: 'DRAFT', createdAt: new Date('2026-09-01T10:00:00Z') },
    { toStatus: 'ACCEPTED', createdAt: new Date('2026-09-02T10:00:00Z') },
    { toStatus: 'IN_PRODUCTION', createdAt: new Date('2026-09-03T10:00:00Z') },
  ];

  const historyCreate = vi.fn(async () => ({ id: 'h-new' }));
  const auditCreate = vi.fn(async () => ({ id: 'a-1' }));
  const orderUpdateMany = vi.fn(async () => ({ count: options.updateCount ?? 1 }));

  const tx = {
    order: {
      findFirst: async () => ({
        id: 'o-1',
        orderNo: 'MSK1-2609-000001',
        status: options.status ?? 'IN_PRODUCTION',
        dueAt: new Date('2026-09-20T10:00:00Z'),
        version: options.version ?? 3,
      }),
      updateMany: orderUpdateMany,
    },
    orderStatusHistory: {
      findMany: async () => history,
      create: historyCreate,
    },
    auditLog: { create: auditCreate },
  };

  const prisma = {
    buildOrderScopeFilter: () => ({}),
    runInTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };

  const service = new OrderRollbackService(prisma as never);
  return { service, historyCreate, auditCreate, orderUpdateMany };
}

describe('Откат заказа: успешный путь', () => {
  it('меняет статус на пройденный', async () => {
    const { service, orderUpdateMany } = makeService();

    await service.rollback('o-1', 'ACCEPTED', 'Ошибочно переведён в работу', admin());

    const args = orderUpdateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.status).toBe('ACCEPTED');
  });

  it('записывает НОВУЮ строку истории, а не удаляет прежние', async () => {
    /*
     * Историю нельзя переписывать: она документ о том, что происходило с
     * заказом. «Как будто этого не было» лишило бы разбора оснований — в истории
     * остаётся и ошибочное состояние, и откат из него.
     */
    const { service, historyCreate } = makeService();

    await service.rollback('o-1', 'ACCEPTED', 'Ошибочно переведён в работу', admin());

    expect(historyCreate).toHaveBeenCalledTimes(1);
    const args = historyCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data).toMatchObject({ fromStatus: 'IN_PRODUCTION', toStatus: 'ACCEPTED' });
    expect(String(args.data.reason)).toContain('Откат');
  });

  it('причина отката попадает в аудит', async () => {
    // След в документах: кто, когда и зачем обошёл правила переходов.
    const { service, auditCreate } = makeService();

    await service.rollback('o-1', 'ACCEPTED', 'Ошибочно переведён в работу', admin());

    const args = auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data).toMatchObject({
      action: 'ORDER_ROLLBACK',
      before: { status: 'IN_PRODUCTION' },
      after: { status: 'ACCEPTED' },
    });
  });

  it('срок сбрасывается, а не пересчитывается от сегодняшнего дня', async () => {
    /*
     * Норматив целевого этапа отсчитывался бы от СЕГОДНЯШНЕГО дня, и заказ,
     * откаченный через месяц, получил бы свежий дедлайн вместо давно истёкшего.
     * Пустой срок честнее: его назначит следующий штатный переход.
     */
    const { service, orderUpdateMany } = makeService();

    await service.rollback('o-1', 'ACCEPTED', 'Ошибочно переведён в работу', admin());

    const args = orderUpdateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.dueAt).toBeNull();
  });

  it('версия увеличивается', async () => {
    // Иначе карточка у другого сотрудника затрёт откат своим устаревшим состоянием.
    const { service, orderUpdateMany } = makeService();

    await service.rollback('o-1', 'ACCEPTED', 'Ошибочно переведён в работу', admin());

    const args = orderUpdateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.version).toEqual({ increment: 1 });
  });

  it('статус меняется ТОЛЬКО при совпадении версии', () => {
    /*
     * Проверяется сам УСЛОВИЕ запроса, а не только реакция на нулевой результат:
     * откат обходит штатный переход, а тот сверяет версию. Без условия в `where`
     * откат затрёт правку другого сотрудника, и узнают об этом только по
     * потерянным данным — тест на «count = 0» такое не поймает, потому что
     * двойник возвращает ноль независимо от условий.
     */
    const { service, orderUpdateMany } = makeService({ version: 7 });

    return service.rollback('o-1', 'ACCEPTED', 'Ошибочно переведён в работу', admin()).then(() => {
      const args = orderUpdateMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
      expect(args.where).toEqual({ id: 'o-1', version: 7 });
    });
  });
});

describe('Откат заказа: отказы', () => {
  it('причина короче трёх символов не принимается', async () => {
    const { service } = makeService();

    await expect(service.rollback('o-1', 'ACCEPTED', 'ок', admin())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('состояние не из истории — отказ', async () => {
    /*
     * Без этой проверки опечатка или подделанный запрос перевели бы заказ в
     * состояние, которого у него никогда не было, и «откат» превратился бы в
     * произвольную смену статуса в обход таблицы переходов.
     */
    const { service } = makeService();

    await expect(
      service.rollback('o-1', 'READY_FOR_PICKUP', 'Проверка', admin()),
    ).rejects.toMatchObject({ response: { code: 'ROLLBACK_REJECTED' } });
  });

  it('откат в текущее состояние — отказ', async () => {
    const { service } = makeService({ status: 'ACCEPTED' });

    await expect(service.rollback('o-1', 'ACCEPTED', 'Проверка', admin())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('закрытый заказ откатить нельзя', async () => {
    for (const status of ['COMPLETED', 'REFUSED', 'CANCELLED', 'REFUSED_BEFORE_WORK']) {
      const { service, historyCreate } = makeService({ status });

      await expect(
        service.rollback('o-1', 'ACCEPTED', 'Проверка', admin()),
        `статус ${status}`,
      ).rejects.toMatchObject({ response: { code: 'ROLLBACK_REJECTED' } });
      // История не тронута: отказ произошёл до записи.
      expect(historyCreate, `статус ${status}`).not.toHaveBeenCalled();
    }
  });

  it('чужой заказ не виден — 404, а не 403', async () => {
    // 403 раскрыл бы существование чужого заказа (защита от IDOR).
    const prisma = {
      buildOrderScopeFilter: () => ({ storeId: 'чужой' }),
      runInTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({ order: { findFirst: async () => null } }),
    };
    const service = new OrderRollbackService(prisma as never);

    await expect(service.rollback('o-1', 'ACCEPTED', 'Проверка', admin())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('одновременная правка отклоняется по версии', async () => {
    /*
     * Откат обходит штатный переход, а тот проверяет версию. Без этой проверки
     * откат затрёт правку другого сотрудника молча.
     */
    const { service } = makeService({ updateCount: 0 });

    await expect(
      service.rollback('o-1', 'ACCEPTED', 'Ошибочно переведён в работу', admin()),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
  });

  it('при отказе по версии история НЕ пишется', async () => {
    // Иначе в истории появился бы откат, которого не было.
    const { service, historyCreate } = makeService({ updateCount: 0 });

    await expect(
      service.rollback('o-1', 'ACCEPTED', 'Ошибочно переведён в работу', admin()),
    ).rejects.toThrow();
    expect(historyCreate).not.toHaveBeenCalled();
  });
});

describe('Откат заказа: список доступных состояний', () => {
  function makeListService(status: string, states: Array<{ toStatus: string }>) {
    const prisma = {
      buildOrderScopeFilter: () => ({}),
      order: { findFirst: async () => ({ status }) },
      orderStatusHistory: { findMany: async () => states },
    };
    return new OrderRollbackService(prisma as never);
  }

  it('возвращает пройденные состояния без текущего и без повторов', async () => {
    const service = makeListService('WORK_COMPLETED', [
      { toStatus: 'IN_PRODUCTION' },
      { toStatus: 'REWORK' },
      { toStatus: 'IN_PRODUCTION' },
      { toStatus: 'WORK_COMPLETED' },
    ]);

    const result = await service.availableStates('o-1', admin());

    expect(result.states).toEqual(['IN_PRODUCTION', 'REWORK']);
    expect(result.currentStatus).toBe('WORK_COMPLETED');
  });

  it('сообщает, что заказ закрыт', async () => {
    // Интерфейс по этому признаку объясняет отказ вместо пустого списка.
    const service = makeListService('COMPLETED', [{ toStatus: 'ACCEPTED' }]);

    const result = await service.availableStates('o-1', admin());

    expect(result.isFinal).toBe(true);
  });

  it('чужой заказ не виден — 404', async () => {
    const prisma = {
      buildOrderScopeFilter: () => ({}),
      order: { findFirst: async () => null },
    };
    const service = new OrderRollbackService(prisma as never);

    await expect(service.availableStates('o-1', admin())).rejects.toBeInstanceOf(NotFoundException);
  });
});
