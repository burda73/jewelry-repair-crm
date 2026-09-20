/**
 * Тесты сводки заказов (дефект, найденный в задаче 5.8).
 *
 * РЕАЛЬНЫЙ ДЕФЕКТ. `GET /orders/summary` считал просрочку как `dueAt < now` БЕЗ
 * фильтра по статусу. Выданный заказ с истёкшим сроком изготовления попадал в
 * «просрочено» НАВСЕГДА: чем дольше работает сеть, тем больше счётчик, и
 * руководитель видел растущую просрочку, которую невозможно закрыть —
 * выполненные заказы из неё не уходили.
 *
 * Спецификация (docs/06 §3, «Просрочено сейчас») требует исключать терминальные
 * статусы, и отчёт `overdue` их уже исключал. Дашборд и отчёт об одном и том же
 * обязаны показывать одно число: расхождение подрывает доверие к обоим.
 *
 * ПОЧЕМУ ДЕФЕКТ НЕ БЫЛ ВИДЕН. На пустой базе он не проявляется: пока нет
 * выданных заказов с прошедшим сроком, оба определения дают одно число. Ошибка
 * накапливается месяцами работы и выглядит как «просрочка растёт».
 */

import { describe, expect, it, vi } from 'vitest';
import { ORDER_STATUS, OVERDUE_EXCLUDED_STATUSES } from '@app/shared';
import { OrdersService } from './orders.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

function user(): AuthenticatedUser {
  return {
    id: 'u-1',
    email: 'user@remixgold.ru',
    roles: [],
    primaryRole: 'RECEIVER',
    scope: 'ALL_STORES',
    scopes: ['ALL_STORES'],
    storeIds: [],
  } as unknown as AuthenticatedUser;
}

function makeService() {
  const orderCount = vi.fn(async () => 0);
  const orderFindMany = vi.fn(async () => []);
  const prisma = {
    buildOrderScopeFilter: vi.fn(() => ({ storeId: 's-1' })),
    order: {
      count: orderCount,
      findMany: orderFindMany,
      aggregate: vi.fn(async () => ({ _count: { _all: 0 } })),
      groupBy: vi.fn(async () => []),
    },
  };
  const workflow = {};
  const config = { get: vi.fn(() => undefined) };
  const service = new OrdersService(prisma as never, workflow as never, config as never);
  return { service, orderCount, orderFindMany };
}

/** `where`, с которым список заказов обратился к базе. */
function listWhere(orderFindMany: ReturnType<typeof vi.fn>): string {
  const call = orderFindMany.mock.calls[0];
  return JSON.stringify((call?.[0] as { where?: unknown })?.where ?? {});
}

/** Тело запроса, в котором считалась просрочка. */
function overdueWhere(orderCount: ReturnType<typeof vi.fn>): unknown {
  const call = orderCount.mock.calls.find((args) =>
    JSON.stringify(args[0]?.where ?? {}).includes('dueAt'),
  );
  return call?.[0]?.where;
}

describe('Просрочка в сводке заказов (дефект, задача 5.8)', () => {
  it('исключает ЗАКРЫТЫЕ заказы', async () => {
    /*
     * Главная проверка исправления. Без неё выданный заказ с прошедшим сроком
     * остаётся в счётчике навсегда, и просрочка растёт с каждым выполненным
     * заказом.
     */
    const { service, orderCount } = makeService();
    await service.getSummary(user());

    const where = JSON.stringify(overdueWhere(orderCount));
    for (const status of [ORDER_STATUS.COMPLETED, ORDER_STATUS.REFUSED, ORDER_STATUS.CANCELLED]) {
      expect(where, `статус ${status} должен исключаться`).toContain(status);
    }
  });

  it('исключает заказы, которые ещё не в производстве', async () => {
    /*
     * `DRAFT` и `ACCEPTED` — срок изготовления по ним не начал идти.
     * `AWAITING_PREPAYMENT` ждёт клиента, а не сотрудника.
     * `UNCLAIMED` — заказ лежит готовым, и «просрочка» по нему уже не имеет
     * смысла: он ждёт клиента.
     */
    const { service, orderCount } = makeService();
    await service.getSummary(user());

    const where = JSON.stringify(overdueWhere(orderCount));
    for (const status of [
      ORDER_STATUS.DRAFT,
      ORDER_STATUS.ACCEPTED,
      ORDER_STATUS.AWAITING_PREPAYMENT,
      ORDER_STATUS.UNCLAIMED,
    ]) {
      expect(where, `статус ${status}`).toContain(status);
    }
  });

  it('условие по сроку сохраняется', async () => {
    // Исправление не должно было убрать само условие: без `dueAt < now`
    // «просрочкой» стали бы все заказы срока вообще.
    const { service, orderCount } = makeService();
    await service.getSummary(user());

    const where = JSON.stringify(overdueWhere(orderCount));
    expect(where).toContain('dueAt');
    expect(where).toContain('lt');
  });

  it('область видимости сохраняется', async () => {
    /*
     * Просрочка считается по магазинам сотрудника. Потеря этого условия
     * показала бы приёмщику чужую просрочку — а это уже утечка, а не неточность.
     */
    const { service, orderCount } = makeService();
    await service.getSummary(user());

    const where = JSON.stringify(overdueWhere(orderCount));
    expect(where).toContain('s-1');
  });

  it('набор исключённых статусов совпадает с отчётом просрочек', async () => {
    /*
     * Дашборд и отчёт об одном и том же обязаны считать одинаково. Расхождение
     * означало бы два разных числа на соседних экранах, и доверия не было бы ни
     * к одному.
     */
    const { service, orderCount } = makeService();
    await service.getSummary(user());

    const where = JSON.stringify(overdueWhere(orderCount));
    const terminal = [
      ORDER_STATUS.COMPLETED,
      ORDER_STATUS.REFUSED,
      ORDER_STATUS.CANCELLED,
      ORDER_STATUS.UNCLAIMED,
    ];
    for (const status of terminal) {
      expect(where, `статус ${status} из набора отчёта`).toContain(status);
    }
  });
});

/**
 * Дефект 68: ссылка с карточки «Просрочено» открывала НЕ то число.
 *
 * Счётчик дашборда исключал закрытые заказы, а список по `?overdue=true`
 * фильтровал только по сроку. Карточка показывала 5, а ссылка открывала 12:
 * выданные и отменённые заказы с истёкшим сроком в число не входили, но в список
 * попадали. Расхождение числа и списка читается как ошибка системы, и доверия
 * после него не будет ни к карточке, ни к списку.
 *
 * ПОЧЕМУ ДЕФЕКТ НЕ БЫЛ ВИДЕН. На пустой базе и на базе без закрытых заказов с
 * прошедшим сроком оба правила дают одно число. Ошибка накапливается месяцами
 * работы — как и в дефекте задачи 5.8, найденном в этом же счётчике.
 */
describe('Фильтр просрочки в списке совпадает со счётчиком (дефект 68)', () => {
  it('список исключает тот же набор статусов, что и счётчик', async () => {
    /*
     * Главная проверка исправления: правило берётся из домена
     * (`OVERDUE_EXCLUDED_STATUSES`), поэтому оба запроса обязаны нести один и
     * тот же набор. Тест сравнивает ДВА места между собой, а не сверяет
     * выписанный список руками, — иначе он повторил бы ошибку и прошёл бы на
     * расхождении.
     */
    const forSummary = makeService();
    await forSummary.service.getSummary(user());
    const summaryWhere = JSON.stringify(overdueWhere(forSummary.orderCount));

    const forList = makeService();
    await forList.service.findAll({ overdue: true }, user());
    const list = listWhere(forList.orderFindMany);

    for (const status of OVERDUE_EXCLUDED_STATUSES) {
      expect(summaryWhere, `счётчик должен исключать ${status}`).toContain(status);
      expect(list, `список должен исключать ${status}`).toContain(status);
    }
  });

  it('список без фильтра просрочки закрытые заказы НЕ исключает', async () => {
    /*
     * Обратная сторона: исключение относится только к просрочке. Обычный список
     * обязан показывать и выданные заказы, иначе их нельзя было бы найти.
     */
    const { service, orderFindMany } = makeService();
    await service.findAll({}, user());

    const where = listWhere(orderFindMany);
    for (const status of OVERDUE_EXCLUDED_STATUSES) {
      expect(where, `без overdue статус ${status} не исключается`).not.toContain(status);
    }
  });

  it('условие по сроку в списке сохраняется', async () => {
    // Исправление не должно было убрать `dueAt < now`: без него «просрочкой»
    // стали бы все заказы вообще.
    const { service, orderFindMany } = makeService();
    await service.findAll({ overdue: true }, user());

    const where = listWhere(orderFindMany);
    expect(where).toContain('dueAt');
    expect(where).toContain('lt');
  });

  it('область видимости в списке сохраняется', async () => {
    // Просрочка в списке считается по магазинам сотрудника; потеря условия
    // показала бы приёмщику чужую просрочку.
    const { service, orderFindMany } = makeService();
    await service.findAll({ overdue: true }, user());

    expect(listWhere(orderFindMany)).toContain('s-1');
  });
});
