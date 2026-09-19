import { describe, expect, it, vi } from 'vitest';
import { AssignmentsService } from './assignments.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Тесты распределения работы (задача 7.2, дефекты 59 и 60).
 *
 * Почему это отдельный набор, а не пара случаев в тестах заказов. Здесь
 * закрывается дефект, из-за которого заказ ФИЗИЧЕСКИ не мог уехать из цеха:
 * `OrderAssignment` не создавал никто, поэтому guard `PERFORMER_ASSIGNED` был
 * всегда ложен. Проверять это надо на уровне «запись появилась + статус
 * сменился», иначе дефект вернётся незамеченным: обе половины по отдельности
 * выглядят рабочими.
 */

const ORDER_ID = 'cmu4cpwbg000bdl0ubltmh700';
const PERFORMER_ID = 'cmu4cpwbg000bdl0ubltmh701';
const ASSIGNMENT_ID = 'cmu4cpwbg000bdl0ubltmh702';
const USER_ID = 'cmu4cpwbg000bdl0ubltmh703';

const MANAGER: AuthenticatedUser = {
  id: USER_ID,
  fullName: 'Менеджер Производства',
  primaryRole: 'PRODUCTION_MANAGER',
  roles: ['PRODUCTION_MANAGER'],
  scope: 'PRODUCTION',
  storeIds: [],
  mustChangePassword: false,
} as unknown as AuthenticatedUser;

/** Заказ в цехе, готовый к распределению работы. */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNo: 'MSK1-2609-000001',
    status: 'ACCEPTED_BY_WORKSHOP',
    version: 5,
    workshopId: 'workshop-1',
    ...overrides,
  };
}

function assignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSIGNMENT_ID,
    orderId: ORDER_ID,
    performerId: PERFORMER_ID,
    assignedById: USER_ID,
    plannedHours: 4,
    status: 'ASSIGNED',
    comment: null,
    startedAt: new Date('2026-09-20T08:00:00Z'),
    finishedAt: null,
    createdAt: new Date('2026-09-20T08:00:00Z'),
    performer: {
      id: PERFORMER_ID,
      fullName: 'Иванов Иван',
      specialization: 'закрепка',
    },
    assignedBy: { id: USER_ID, fullName: 'Менеджер Производства' },
    ...overrides,
  };
}

/**
 * Двойник Prisma с записью вызовов.
 *
 * `runInTransaction` выполняет колбэк с тем же объектом: транзакция здесь не
 * проверяется (её проверяет отдельный тест), но без неё код сервиса не дойдёт
 * до записи.
 */
function createPrismaMock() {
  const tx = {
    orderAssignment: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({ id: ASSIGNMENT_ID })),
      update: vi.fn(async () => ({ id: ASSIGNMENT_ID })),
      findFirst: vi.fn(async () => assignmentRow()),
      findUnique: vi.fn(async () => assignmentRow()),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
    order: {
      findFirst: vi.fn(async () => orderRow()),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({ id: ORDER_ID })),
      findUniqueOrThrow: vi.fn(async () => orderRow()),
    },
    orderStatusHistory: {
      create: vi.fn(async () => ({ id: 'hist-1' })),
      findFirst: vi.fn(async () => null),
    },
  };

  return {
    _tx: tx,
    order: {
      findFirst: vi.fn(async () => orderRow()),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    performer: {
      findFirst: vi.fn(async () => ({
        id: PERFORMER_ID,
        fullName: 'Иванов Иван',
        workshopId: 'workshop-1',
      })),
    },
    orderAssignment: {
      findUnique: vi.fn(async () => assignmentRow()),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    workingCalendar: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    stageNorm: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    runInTransaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    buildOrderScopeFilter: vi.fn(() => ({})),
  };
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  const workflow = { transition: vi.fn(async () => ({})) };
  const service = new AssignmentsService(prisma as never, workflow as never);
  return { service, workflow };
}

describe('Назначение исполнителя (задача 7.2)', () => {
  it('создаёт назначение и переводит заказ в «Выдано в работу»', async () => {
    /*
     * Главная проверка дефекта 59. Обе половины обязательны: без записи
     * назначения guard `PERFORMER_ASSIGNED` остаётся ложным и заказ не уедет из
     * цеха, а без перехода работа считается нераспределённой.
     */
    const prisma = createPrismaMock();
    const { service, workflow } = makeService(prisma);

    await service.assign(ORDER_ID, { performerId: PERFORMER_ID, plannedHours: 4 }, MANAGER);

    expect(prisma._tx.orderAssignment.create).toHaveBeenCalledTimes(1);
    const created = prisma._tx.orderAssignment.create.mock.calls[0]?.[0] as {
      data: { orderId: string; performerId: string; status: string };
    };
    expect(created.data.orderId).toBe(ORDER_ID);
    expect(created.data.performerId).toBe(PERFORMER_ID);
    expect(created.data.status).toBe('ASSIGNED');

    expect(workflow.transition).toHaveBeenCalledTimes(1);
    const transition = workflow.transition.mock.calls[0]?.[0] as { to: string };
    expect(transition.to).toBe('IN_WORK');
  });

  it('переход идёт в ТОЙ ЖЕ транзакции, что и запись назначения', async () => {
    /*
     * Иначе при сбое между операциями получился бы заказ «в работе» без
     * исполнителя: статус утверждал бы, что работа идёт, а выдавать её некому.
     */
    const prisma = createPrismaMock();
    const { service, workflow } = makeService(prisma);

    await service.assign(ORDER_ID, { performerId: PERFORMER_ID }, MANAGER);

    const transition = workflow.transition.mock.calls[0]?.[0] as { tx?: unknown };
    expect(transition.tx).toBe(prisma._tx);
  });

  it('пишет в аудит ФИО исполнителя — заказчик требует видеть ювелира в истории', async () => {
    /*
     * `OrderStatusHistory` хранит статусы, и записать туда ФИО значило бы
     * сломать отчётность по статусам. Поэтому событие идёт в аудит с действием
     * `ASSIGNMENT`, а лента заказа собирает из него строку «Работа выдана».
     */
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await service.assign(ORDER_ID, { performerId: PERFORMER_ID }, MANAGER);

    expect(prisma._tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = prisma._tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { action: string; after: { performerName: string } };
    };
    expect(audit.data.action).toBe('ASSIGNMENT');
    expect(audit.data.after.performerName).toBe('Иванов Иван');
  });

  it('закрывает прошлые активные назначения перед созданием нового', async () => {
    /*
     * Иначе в заказе оказались бы два активных исполнителя, а `workFinished`
     * смотрит на любой из них: заказ мог считаться готовым, пока второй ювелир
     * ещё работает.
     */
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await service.assign(ORDER_ID, { performerId: PERFORMER_ID }, MANAGER);

    expect(prisma._tx.orderAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: ORDER_ID, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
        data: expect.objectContaining({ status: 'RETURNED' }),
      }),
    );
  });

  it('отклоняет назначение из статуса, где работа не выдаётся', async () => {
    // «Принят в работу» — изделие ещё в магазине: выдавать работу нечему.
    const prisma = createPrismaMock();
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: 'ACCEPTED' }) as never);
    const { service, workflow } = makeService(prisma);

    await expect(
      service.assign(ORDER_ID, { performerId: PERFORMER_ID }, MANAGER),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_RULE_VIOLATION' } });
    expect(workflow.transition).not.toHaveBeenCalled();
  });

  it('отклоняет несуществующего исполнителя', async () => {
    const prisma = createPrismaMock();
    prisma.performer.findFirst.mockResolvedValue(null as never);
    const { service } = makeService(prisma);

    await expect(
      service.assign(ORDER_ID, { performerId: PERFORMER_ID }, MANAGER),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
  });

  it('отклоняет пустое тело запроса', async () => {
    const prisma = createPrismaMock();
    const { service } = makeService(prisma);

    await expect(service.assign(ORDER_ID, {}, MANAGER)).rejects.toMatchObject({
      response: { code: 'VALIDATION_ERROR' },
    });
  });

  it('не найденный заказ даёт 404, а не 403 (защита от IDOR)', async () => {
    const prisma = createPrismaMock();
    prisma.order.findFirst.mockResolvedValue(null as never);
    const { service } = makeService(prisma);

    await expect(
      service.assign(ORDER_ID, { performerId: PERFORMER_ID }, MANAGER),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });
});

describe('Приёмка работы (задача 7.2)', () => {
  it('закрывает назначение и переводит заказ в «Работы завершены»', async () => {
    const prisma = createPrismaMock();
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: 'IN_WORK' }) as never);
    const { service, workflow } = makeService(prisma);

    await service.finish(ORDER_ID, ASSIGNMENT_ID, {}, MANAGER);

    const update = prisma._tx.orderAssignment.update.mock.calls[0]?.[0] as {
      data: { status: string; finishedAt: Date };
    };
    expect(update.data.status).toBe('DONE');
    expect(update.data.finishedAt).toBeInstanceOf(Date);

    const transition = workflow.transition.mock.calls[0]?.[0] as { to: string };
    expect(transition.to).toBe('WORK_COMPLETED');
  });

  it('отклоняет повторную приёмку той же работы', async () => {
    const prisma = createPrismaMock();
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: 'IN_WORK' }) as never);
    prisma._tx.orderAssignment.findFirst.mockResolvedValue(
      assignmentRow({ status: 'DONE' }) as never,
    );
    const { service, workflow } = makeService(prisma);

    await expect(service.finish(ORDER_ID, ASSIGNMENT_ID, {}, MANAGER)).rejects.toMatchObject({
      response: { code: 'BUSINESS_RULE_VIOLATION' },
    });
    expect(workflow.transition).not.toHaveBeenCalled();
  });

  it('отклоняет приёмку отменённого назначения', async () => {
    // Работу по отменённому назначению принимать не за что.
    const prisma = createPrismaMock();
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: 'IN_WORK' }) as never);
    prisma._tx.orderAssignment.findFirst.mockResolvedValue(
      assignmentRow({ status: 'RETURNED' }) as never,
    );
    const { service } = makeService(prisma);

    await expect(service.finish(ORDER_ID, ASSIGNMENT_ID, {}, MANAGER)).rejects.toMatchObject({
      response: { code: 'BUSINESS_RULE_VIOLATION' },
    });
  });

  it('не даёт принять назначение чужого заказа', async () => {
    /*
     * Назначение ищется вместе с `orderId`: иначе менеджер, зная только
     * идентификатор назначения, закрыл бы работу по чужому заказу.
     */
    const prisma = createPrismaMock();
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: 'IN_WORK' }) as never);
    prisma._tx.orderAssignment.findFirst.mockResolvedValue(null as never);
    const { service } = makeService(prisma);

    await expect(service.finish(ORDER_ID, ASSIGNMENT_ID, {}, MANAGER)).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
  });
});
