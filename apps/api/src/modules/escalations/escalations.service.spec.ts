/**
 * Тесты воркера эскалаций (задача 2.8, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Воркер рассылает уведомления людям, и ошибки здесь тихие:
 * ничего не падает, просто ответственный не узнаёт о просрочке, а клиент
 * узнаёт о ней раньше цеха. Проверяются правила, которые нельзя увидеть в схеме
 * валидации:
 *
 *  * адресат зависит от ЭТАПА: на производстве это назначенный менеджер, на
 *    логистике — логист. Рассылка «всем приёмщикам» размывает ответственность;
 *  * руководитель получает отдельное уведомление, а не то же самое повторно:
 *    иначе на втором уровне ответственный получал бы дубль;
 *  * при отсутствии ответственного уровень НЕ повышается: иначе заказ «сгорел»
 *    бы без единого уведомления, и следующий прогон молчал бы вечно;
 *  * при сбое рассылки уровень тоже не повышается: заказ не должен считаться
 *    оповещённым, если сообщение не ушло.
 *
 * Prisma подменяется управляемым двойником: проверяются правила воркера, а не
 * поведение Postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EscalationsService } from './escalations.service';

const ORDER_ID = 'cmu5p70yu0001bm7pzqlcawsw';
const AUTHOR_ID = 'cmu4cpwbg000bdl0ubltmh740';
const PROD_MANAGER_ID = 'cmu4cpwbg000cdl0ubltmh741';
const LOGIST_ID = 'cmu4cpwbg000ddl0ubltmh742';
const MANAGER_ID = 'cmu4cpwbg000edl0ubltmh743';
const STORE_ID = 'cmu5p70yu0002bm7pzqlcawsw';

/** Понедельник, 15 сентября 2025 года, 12:00 МСК — середина рабочего дня. */
const NOW = new Date('2025-09-15T09:00:00Z');

/** Момент в московском времени. */
const msk = (iso: string): Date => new Date(`${iso}+03:00`);

/*
 * Сроки задаются КОНКРЕТНЫМИ датами, а не вычитанием часов из `NOW`.
 * Вычитание календарных часов дало бы неверный вход: между пятницей и
 * понедельником рабочих часов проходит меньше, чем календарных, и тест
 * проверял бы не то правило. Значения посчитаны вручную:
 *
 *   пятница 10:00 → понедельник 12:00 = 9 ч (пт) + 2 ч (пн) = 11 рабочих часов;
 *   пятница 11:00 → понедельник 12:00 = 8 ч (пт) + 2 ч (пн) = 10 рабочих часов;
 *   пятница 18:00 → понедельник 12:00 = 1 ч (пт) + 2 ч (пн) = 3 рабочих часа.
 */
const DUE_11_WORKING_HOURS = msk('2025-09-12T10:00:00');
const DUE_10_WORKING_HOURS = msk('2025-09-12T11:00:00');
const DUE_3_WORKING_HOURS = msk('2025-09-12T18:00:00');
const DUE_IN_FUTURE = msk('2025-09-15T18:00:00');

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNo: 'MSK1-2509-000001',
    status: 'IN_PRODUCTION',
    dueAt: DUE_3_WORKING_HOURS,
    escalatedAt: null,
    escalationLevel: 0,
    createdById: AUTHOR_ID,
    productionManagerId: PROD_MANAGER_ID,
    createdStoreId: STORE_ID,
    // Имя ответственного приходит вместе с заказом: оно нужно для текста
    // письма руководителю.
    createdBy: { fullName: 'Приёмщиков Пётр' },
    productionManager: { fullName: 'Мастеров Иван' },
    ...overrides,
  };
}

function makeService(prisma: Record<string, unknown> = {}) {
  const client = {
    order: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({ id: ORDER_ID })),
      ...(prisma.order as object),
    },
    user: {
      /*
       * `email` присутствует намеренно: эскалация уведомляет сотрудника по двум
       * каналам (задача 5.9), и адрес нужен для письма. Двойник без адреса
       * проверял бы только канал «в приложении», то есть половину поведения.
       */
      findFirst: vi.fn(async () => ({ id: AUTHOR_ID, email: 'author@remixgold.ru' })),
      findMany: vi.fn(async () => [{ id: AUTHOR_ID, email: 'author@remixgold.ru' }]),
      findUnique: vi.fn(async () => ({ id: AUTHOR_ID, email: 'author@remixgold.ru' })),
      ...(prisma.user as object),
    },
    ...prisma,
  };
  const workflow = { loadCalendar: vi.fn(async () => ({ overrides: new Map(), defaultHours: 9 })) };
  /*
   * Двойник отдаёт ОБА канала: эскалация уведомляет сотрудника и в интерфейсе, и
   * письмом (задача 5.9). Возвращается та же форма, что у настоящего метода, —
   * иначе тест проверял бы несуществующий контракт.
   */
  const notifications = {
    notifyStaff: vi.fn(async () => ({ inApp: { id: 'n-1' }, email: { id: 'n-2' } })),
  };
  const service = new EscalationsService(
    client as never,
    workflow as never,
    notifications as never,
  );
  return { service, client, workflow, notifications };
}

describe('Воркер эскалаций: выборка (задача 2.8)', () => {
  it('просматриваются только заказы со сроком в прошлом', async () => {
    // Заказ без `dueAt` эскалировать нельзя: норматив не найден, и «просрочка»
    // была бы выдумкой.
    const { service, client } = makeService();
    await service.run(NOW);

    const where = client.order.findMany.mock.calls[0][0].where;
    expect(where.dueAt).toEqual({ not: null, lt: NOW });
  });

  it('закрытые и ожидающие оплаты заказы исключены', async () => {
    /*
     * `AWAITING_PREPAYMENT` ждёт клиента: напоминать о нём ответственному
     * бессмысленно — он ничего не может сделать, пока клиент не заплатит.
     */
    const { service, client } = makeService();
    await service.run(NOW);

    const excluded = client.order.findMany.mock.calls[0][0].where.status.notIn as string[];
    expect(excluded).toContain('COMPLETED');
    expect(excluded).toContain('CANCELLED');
    expect(excluded).toContain('AWAITING_PREPAYMENT');
    expect(excluded).toContain('DRAFT');
  });

  it('пустая выборка не порождает запросов к календарю', async () => {
    // Прогон по пустой базе не должен дёргать рабочий календарь.
    const { service, workflow } = makeService();
    const result = await service.run(NOW);

    expect(result.scanned).toBe(0);
    expect(workflow.loadCalendar).not.toHaveBeenCalled();
  });
});

describe('Воркер эскалаций: уровни (задача 2.8)', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('небольшая просрочка оповещает только ответственного', async () => {
    ctx.client.order.findMany.mockResolvedValue([orderRow()]);
    ctx.client.user.findFirst.mockResolvedValue({ id: PROD_MANAGER_ID });

    const result = await ctx.service.run(NOW);

    expect(result.notified).toBe(1);
    expect(result.escalated).toBe(1);
    const updated = ctx.client.order.update.mock.calls[0][0].data;
    expect(updated.escalationLevel).toBe(1);
    expect(updated.escalatedAt).toEqual(NOW);
  });

  it('заказ в срок не эскалируется', async () => {
    // `dueAt` в будущем: срок не наступил, тревога была бы ложной.
    ctx.client.order.findMany.mockResolvedValue([orderRow({ dueAt: DUE_IN_FUTURE })]);

    const result = await ctx.service.run(NOW);

    expect(result.notified).toBe(0);
    expect(ctx.notifications.notifyStaff).not.toHaveBeenCalled();
    expect(ctx.client.order.update).not.toHaveBeenCalled();
  });

  it('повторный прогон на том же уровне молчит', async () => {
    /*
     * Воркер может быть запущен дважды (перезапуск сервиса, два экземпляра).
     * Повторная эскалация того же уровня превратила бы ленту в шум, и настоящее
     * событие в ней потерялось бы.
     */
    ctx.client.order.findMany.mockResolvedValue([orderRow({ escalationLevel: 1 })]);

    const result = await ctx.service.run(NOW);

    expect(result.notified).toBe(0);
    expect(ctx.notifications.notifyStaff).not.toHaveBeenCalled();
  });

  it('просрочка больше рабочего дня поднимает уровень до руководителя', async () => {
    // Порог — 9 рабочих часов; просрочка на 10 часов уже требует руководителя.
    ctx.client.order.findMany.mockResolvedValue([orderRow({ dueAt: DUE_10_WORKING_HOURS })]);
    ctx.client.user.findMany.mockResolvedValue([{ id: MANAGER_ID }]);

    const result = await ctx.service.run(NOW);

    expect(result.escalated).toBe(1);
    expect(ctx.client.order.update.mock.calls[0][0].data.escalationLevel).toBe(2);
    expect(ctx.client.user.findMany.mock.calls[0][0].where.roles).toEqual({
      some: { role: 'MANAGER' },
    });
  });

  it('повышение до руководителя оповещает заново', async () => {
    // Новый адресат — новое событие: руководителя надо оповестить.
    ctx.client.order.findMany.mockResolvedValue([
      orderRow({ dueAt: DUE_10_WORKING_HOURS, escalationLevel: 1 }),
    ]);
    ctx.client.user.findMany.mockResolvedValue([{ id: MANAGER_ID }]);

    const result = await ctx.service.run(NOW);

    expect(result.notified).toBe(1);
    expect(result.escalated).toBe(1);
  });
});

describe('Воркер эскалаций: адресаты (задача 2.8)', () => {
  it('на производстве отвечает назначенный менеджер', async () => {
    /*
     * Ответственный зависит от ЭТАПА: рассылка «всем менеджерам производства»
     * размывает ответственность — каждый решает, что займётся кто-то другой.
     */
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ status: 'IN_PRODUCTION' })]);
    client.user.findFirst.mockResolvedValue({ id: PROD_MANAGER_ID });

    await service.run(NOW);

    const call = notifications.notifyStaff.mock.calls[0][0] as { userId: string };
    expect(call.userId).toBe(PROD_MANAGER_ID);
    // Назначенный менеджер берётся из поля заказа: искать его среди пользователей
    // не нужно, и лишний запрос к базе здесь не выполняется.
    expect(client.user.findFirst).not.toHaveBeenCalled();
  });

  it('без назначенного менеджера берётся резерв', async () => {
    // Назначенный мог уволиться или быть в отпуске: без резерва просрочка
    // осталась бы без адресата.
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([
      orderRow({ status: 'IN_PRODUCTION', productionManagerId: null, productionManager: null }),
    ]);
    client.user.findMany.mockResolvedValue([{ id: PROD_MANAGER_ID }]);

    await service.run(NOW);

    expect(client.user.findMany.mock.calls[0][0].where.roles).toEqual({
      some: { role: 'PRODUCTION_MANAGER' },
    });
    expect(notifications.notifyStaff).toHaveBeenCalledTimes(1);
  });

  it('на логистике отвечает логист', async () => {
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ status: 'IN_TRANSIT_TO_PRODUCTION' })]);
    client.user.findMany.mockResolvedValue([{ id: LOGIST_ID }]);

    await service.run(NOW);

    expect(client.user.findMany.mock.calls[0][0].where.roles).toEqual({
      some: { role: 'LOGISTICIAN' },
    });
    const call = notifications.notifyStaff.mock.calls[0][0] as { userId: string };
    expect(call.userId).toBe(LOGIST_ID);
  });

  it('на приёме отвечает оформивший заказ приёмщик', async () => {
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ status: 'AWAITING_APPROVAL' })]);
    client.user.findFirst.mockResolvedValue({ id: AUTHOR_ID });

    await service.run(NOW);

    const call = notifications.notifyStaff.mock.calls[0][0] as { userId: string };
    expect(call.userId).toBe(AUTHOR_ID);
  });

  it('недоступного приёмщика заменяют приёмщики магазина', async () => {
    // Уволенный или заблокированный автор не должен оставить просрочку без
    // адресата.
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ status: 'READY_FOR_PICKUP' })]);
    client.user.findFirst.mockResolvedValue(null);
    client.user.findMany.mockResolvedValue([{ id: 'receiver-2' }]);

    await service.run(NOW);

    const where = client.user.findMany.mock.calls[0][0].where;
    expect(where.roles).toEqual({ some: { role: 'RECEIVER', storeId: STORE_ID } });
    expect(notifications.notifyStaff).toHaveBeenCalledTimes(1);
  });
});

describe('Воркер эскалаций: отказы (задача 2.8)', () => {
  it('без ответственного уровень НЕ повышается', async () => {
    /*
     * Иначе заказ «сгорел» бы без единого уведомления: следующий прогон счёл бы
     * уровень уже достигнутым и молчал бы вечно. Лучше повторить попытку.
     */
    const { service, client } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ status: 'READY_FOR_PICKUP' })]);
    client.user.findFirst.mockResolvedValue(null);
    client.user.findMany.mockResolvedValue([]);

    const result = await service.run(NOW);

    expect(result.withoutResponsible).toBe(1);
    expect(result.escalated).toBe(0);
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it('при сбое рассылки уровень НЕ повышается', async () => {
    // Заказ не должен считаться оповещённым, если сообщение не ушло.
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow()]);
    notifications.notifyStaff.mockRejectedValue(new Error('SMTP timeout'));

    const result = await service.run(NOW);

    expect(result.notified).toBe(0);
    expect(result.escalated).toBe(0);
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it('сбой на одном получателе не мешает остальным', async () => {
    /*
     * Падение на первом получателе оставило бы второго без оповещения, а
     * остальные просроченные заказы — без обработки.
     */
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ status: 'READY_FOR_PICKUP' })]);
    client.user.findFirst.mockResolvedValue(null);
    client.user.findMany.mockResolvedValue([{ id: 'receiver-1' }, { id: 'receiver-2' }]);
    notifications.notifyStaff
      .mockRejectedValueOnce(new Error('первый получатель недоступен'))
      .mockResolvedValueOnce({ id: 'n-2' });

    const result = await service.run(NOW);

    expect(notifications.notifyStaff).toHaveBeenCalledTimes(2);
    expect(result.notified).toBe(1);
    expect(result.escalated).toBe(1);
  });

  it('сбой на одном заказе не отменяет обработку остальных', async () => {
    // Иначе одна недоступная запись оставила бы без оповещения целый день.
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([
      orderRow({ id: 'o-1', status: 'READY_FOR_PICKUP' }),
      orderRow({ id: 'o-2', status: 'READY_FOR_PICKUP' }),
    ]);
    client.user.findFirst.mockResolvedValue(null);
    client.user.findMany.mockResolvedValue([{ id: 'receiver-1' }]);
    notifications.notifyStaff
      .mockRejectedValueOnce(new Error('сбой'))
      .mockResolvedValueOnce({ id: 'n-2' });

    const result = await service.run(NOW);

    expect(result.escalated).toBe(1);
    expect(result.notified).toBe(1);
  });
});
describe('Воркер эскалаций: шаблоны (задача 2.8)', () => {
  it('руководителю используется отдельный шаблон', async () => {
    /*
     * У руководителя другой текст: ему нужно вмешательство, а не напоминание.
     * Общий шаблон прислал бы ему то же самое, что ответственному, — и
     * эскалация потеряла бы смысл.
     */
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ dueAt: DUE_10_WORKING_HOURS })]);
    client.user.findMany.mockResolvedValue([{ id: MANAGER_ID }]);

    await service.run(NOW);

    const call = notifications.notifyStaff.mock.calls[0][0] as { code: string };
    expect(call.code).toBe('ESCALATION_MANAGER');
  });

  it('ответственному используется шаблон просрочки', async () => {
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ status: 'IN_PRODUCTION' })]);

    await service.run(NOW);

    const call = notifications.notifyStaff.mock.calls[0][0] as { code: string };
    expect(call.code).toBe('ORDER_OVERDUE');
  });

  it('просрочка выражается в рабочих днях', async () => {
    // «Просрочено на 1,3 дня» сотруднику ничего не говорит, «на 1 день» — говорит.
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ dueAt: DUE_10_WORKING_HOURS })]);
    client.user.findMany.mockResolvedValue([{ id: MANAGER_ID }]);

    await service.run(NOW);

    const call = notifications.notifyStaff.mock.calls[0][0] as {
      values: { overdueDays: number };
    };
    // 10 рабочих часов при девятичасовом дне — это один полный день.
    expect(call.values.overdueDays).toBe(1);
  });
});

describe('Воркер эскалаций: имя ответственного (дефект 32)', () => {
  it('в письмо руководителю подставляется ИМЯ, а не номер заказа', async () => {
    /*
     * ДЕФЕКТ 32, найденный на живом сервере. Шаблон `ESCALATION_MANAGER`
     * содержит `{{responsible}}` — «кто отвечает». В него подставлялся номер
     * заказа, и руководитель получал письмо «Ответственный:
     * MSK1-2509-000001». На вопрос «к кому идти» это не отвечает.
     */
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([orderRow({ dueAt: DUE_10_WORKING_HOURS })]);
    client.user.findMany.mockResolvedValue([{ id: MANAGER_ID }]);

    await service.run(NOW);

    const call = notifications.notifyStaff.mock.calls[0][0] as {
      values: { responsible: string };
    };
    expect(call.values.responsible).toBe('Мастеров Иван');
    expect(call.values.responsible).not.toContain('MSK1');
  });

  it('без назначенного менеджера указывается приёмщик заказа', async () => {
    // Ответственный всё равно должен быть назван: «никто» — не ответ.
    const { service, client, notifications } = makeService();
    client.order.findMany.mockResolvedValue([
      orderRow({
        dueAt: DUE_10_WORKING_HOURS,
        productionManagerId: null,
        productionManager: null,
      }),
    ]);
    client.user.findMany.mockResolvedValue([{ id: MANAGER_ID }]);

    await service.run(NOW);

    const call = notifications.notifyStaff.mock.calls[0][0] as {
      values: { responsible: string };
    };
    expect(call.values.responsible).toBe('Приёмщиков Пётр');
  });
});
