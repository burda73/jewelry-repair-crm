/**
 * Тесты автостатуса «Невостребовано» (задача 2.10, ТЗ п. 2.8).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Заказ готов к выдаче, клиент не приходит — и заказ остаётся
 * «готов к выдаче» навсегда. Через год таких заказов десятки, и понять, какие
 * изделия занимают место, можно только пересмотрев всё.
 *
 * Проверяются правила, которые нельзя увидеть в схеме валидации:
 *
 *  * перевод идёт ЧЕРЕЗ ТАБЛИЦУ ПЕРЕХОДОВ: она несёт проверку порога, историю
 *    статусов и роль `SYSTEM`. Прямой `UPDATE status` перевёл бы заказ раньше
 *    30 дней из-за сбоя в данных, и объяснить это было бы нечем;
 *  * сбой на одном заказе не останавливает прогон: остальные остались бы
 *    «готовыми к выдаче» навсегда;
 *  * бессмысленный порог заменяется значением по умолчанию: ноль перевёл бы в
 *    «невостребовано» заказ, готовый час назад.
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса, а не
 * поведение Postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnclaimedService, DEFAULT_UNCLAIMED_AFTER_DAYS } from './unclaimed.service';

const ORDER_ID = 'cmu5p70yu0001bm7pzqlcawsw';
const STORE_ID = 'cmu5p70yu0002bm7pzqlcawsw';

/** 15 сентября 2025 года, 12:00 МСК. */
const NOW = new Date('2025-09-15T09:00:00Z');

/** Момент готовности, отстоящий от `NOW` на указанное число дней. */
const readyDaysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNo: 'MSK1-2509-000001',
    status: 'READY_FOR_PICKUP',
    readyAt: readyDaysAgo(40),
    version: 5,
    createdStoreId: STORE_ID,
    ...overrides,
  };
}

function makeService(prisma: Record<string, unknown> = {}) {
  const client = {
    order: {
      findMany: vi.fn(async () => []),
      ...(prisma.order as object),
    },
    user: {
      findMany: vi.fn(async () => [{ id: 'receiver-1' }]),
      ...(prisma.user as object),
    },
    setting: {
      findUnique: vi.fn(async () => null),
      ...(prisma.setting as object),
    },
    ...prisma,
  };
  const workflow = { transition: vi.fn(async () => ({ id: ORDER_ID })) };
  // Уведомление уходит по двум каналам (задача 5.9): форма ответа — как у
  // настоящего метода, иначе тест проверял бы несуществующий контракт.
  const notifications = {
    notifyStaff: vi.fn(async () => ({ inApp: { id: 'n-1' }, email: { id: 'n-2' } })),
  };
  const service = new UnclaimedService(client as never, workflow as never, notifications as never);
  return { service, client, workflow, notifications };
}

describe('Невостребовано: выборка (задача 2.10)', () => {
  it('отбираются только готовые к выдаче заказы', async () => {
    // Заказ в производстве не может быть «невостребован»: он ещё не готов.
    const { service, client } = makeService();
    await service.run(NOW);

    const where = client.order.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('READY_FOR_PICKUP');
  });

  it('верхняя граница порога отсекается в запросе', async () => {
    /*
     * Заказ, готовый меньше 30 дней назад, переводить не нужно, и отбирать его в
     * память незачем: на большом магазине это тысячи лишних строк.
     */
    const { service, client } = makeService();
    await service.run(NOW);

    const cutoff = client.order.findMany.mock.calls[0][0].where.readyAt.lt as Date;
    const expected = new Date(NOW.getTime() - DEFAULT_UNCLAIMED_AFTER_DAYS * 86_400_000);
    expect(cutoff.getTime()).toBe(expected.getTime());
  });

  it('пустая выборка не порождает переходов', async () => {
    const { service, workflow } = makeService();
    const result = await service.run(NOW);

    expect(result.scanned).toBe(0);
    expect(workflow.transition).not.toHaveBeenCalled();
  });
});

describe('Невостребовано: перевод (задача 2.10)', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    ctx.client.order.findMany.mockResolvedValue([orderRow()]);
  });

  it('перевод идёт через таблицу переходов, а не UPDATE status', async () => {
    /*
     * Переход 19 несёт проверку порога (`UNCLAIMED_THRESHOLD`), запись в историю
     * и роль `SYSTEM`. Прямая запись обошла бы проверку: заказ перешёл бы в
     * «невостребовано» раньше 30 дней из-за сбоя в данных или ручной правки.
     */
    await ctx.service.run(NOW);

    expect(ctx.workflow.transition).toHaveBeenCalledTimes(1);
    const call = ctx.workflow.transition.mock.calls[0][0] as {
      orderId: string;
      to: string;
      actorId: string | null;
      actorRole: string;
      version: number;
    };
    expect(call.orderId).toBe(ORDER_ID);
    expect(call.to).toBe('UNCLAIMED');
    expect(call.actorRole).toBe('SYSTEM');
    /*
     * ДЕФЕКТ 33: `actorId` — внешний ключ на `User`, и системный переход обязан
     * передавать `null`, а не строку `'system'`. Со строкой вставка нарушала
     * `order_status_history_changedById_fkey`: переход падал, заказ оставался
     * «готов к выдаче» навсегда, и в журнале была лишь строка «не переведён».
     * Двойник Prisma такой идентификатор принимает, поэтому поймать это можно
     * только проверкой значения.
     */
    expect(call.actorId).toBeNull();
    // Версия передаётся: без неё оптимистичная блокировка не сработала бы, и
    // параллельная правка заказа была бы перезаписана.
    expect(call.version).toBe(5);
  });

  it('приёмщику магазина отправляется уведомление', async () => {
    // ТЗ п. 2.8: уведомление приёмщику, а не «всем».
    await ctx.service.run(NOW);

    expect(ctx.notifications.notifyStaff).toHaveBeenCalledTimes(1);
    const call = ctx.notifications.notifyStaff.mock.calls[0][0] as {
      code: string;
      userId: string;
    };
    expect(call.code).toBe('ORDER_UNCLAIMED');
    expect(call.userId).toBe('receiver-1');
    const where = ctx.client.user.findMany.mock.calls[0][0].where;
    expect(where.roles).toEqual({ some: { role: 'RECEIVER', storeId: STORE_ID } });
  });

  it('порог берётся из настройки', async () => {
    /*
     * Срок хранения — договорное условие, и менять его должен администратор без
     * перезапуска сервиса.
     */
    ctx.client.setting.findUnique.mockResolvedValue({
      key: 'orders.unclaimedAfterDays',
      value: 60,
    });

    await ctx.service.run(NOW);

    const cutoff = ctx.client.order.findMany.mock.calls[0][0].where.readyAt.lt as Date;
    expect(cutoff.getTime()).toBe(new Date(NOW.getTime() - 60 * 86_400_000).getTime());
  });

  it('нулевой порог заменяется значением по умолчанию', async () => {
    // Ноль перевёл бы в «невостребовано» заказ, готовый час назад.
    ctx.client.setting.findUnique.mockResolvedValue({
      key: 'orders.unclaimedAfterDays',
      value: 0,
    });

    await ctx.service.run(NOW);

    const cutoff = ctx.client.order.findMany.mock.calls[0][0].where.readyAt.lt as Date;
    expect(cutoff.getTime()).toBe(
      new Date(NOW.getTime() - DEFAULT_UNCLAIMED_AFTER_DAYS * 86_400_000).getTime(),
    );
  });

  it('отрицательный порог и NaN заменяются значением по умолчанию', async () => {
    for (const bad of [-5, Number.NaN]) {
      const fresh = makeService();
      fresh.client.order.findMany.mockResolvedValue([orderRow()]);
      fresh.client.setting.findUnique.mockResolvedValue({
        key: 'orders.unclaimedAfterDays',
        value: bad,
      });

      await fresh.service.run(NOW);

      const cutoff = fresh.client.order.findMany.mock.calls[0][0].where.readyAt.lt as Date;
      expect(cutoff.getTime()).toBe(
        new Date(NOW.getTime() - DEFAULT_UNCLAIMED_AFTER_DAYS * 86_400_000).getTime(),
      );
    }
  });

  it('сбой на одном заказе не останавливает прогон', async () => {
    /*
     * Иначе падение на первой записи оставило бы все остальные «готовыми к
     * выдаче» навсегда, и прогон не изменил бы ничего.
     */
    ctx.client.order.findMany.mockResolvedValue([
      orderRow({ id: 'o-1', orderNo: 'A-1' }),
      orderRow({ id: 'o-2', orderNo: 'A-2' }),
      orderRow({ id: 'o-3', orderNo: 'A-3' }),
    ]);
    ctx.workflow.transition
      .mockResolvedValueOnce({ id: 'o-1' })
      .mockRejectedValueOnce(new Error('переход недопустим'))
      .mockResolvedValueOnce({ id: 'o-3' });

    const result = await ctx.service.run(NOW);

    expect(result.unclaimed).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('сбой уведомления не отменяет перевод', async () => {
    // Статус уже изменён, и откатывать его из-за недоступной почты нельзя.
    ctx.notifications.notifyStaff.mockRejectedValue(new Error('SMTP timeout'));

    const result = await ctx.service.run(NOW);

    expect(result.unclaimed).toBe(1);
    expect(ctx.workflow.transition).toHaveBeenCalledTimes(1);
  });

  it('перевод выполняется и без приёмщиков в магазине', async () => {
    // Отсутствие получателя — не причина оставить изделие «готовым к выдаче».
    ctx.client.user.findMany.mockResolvedValue([]);

    const result = await ctx.service.run(NOW);

    expect(result.unclaimed).toBe(1);
  });
});
