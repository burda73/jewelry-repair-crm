/**
 * Тесты сервиса рекламаций (этап 6, ТЗ п. 2.9).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Ошибки в рекламациях тихие и дорогие: рекламация, открытая по
 * незавершённому заказу, искажает статистику гарантийных случаев; срок,
 * посчитанный календарными днями, нарушается незаметно; переход, разрешённый без
 * причины отказа, лишает клиента объяснения. Ни одно из этих правил не видно в
 * схеме валидации — все они живут в сервисе, поэтому и проверяются здесь.
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса, а не
 * поведение Postgres. Календарь фиксирован (пустые `overrides`), поэтому сроки
 * считаются по дням недели и не зависят от текущей даты запуска тестов.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { ClaimsService } from './claims.service';

const CLAIM_ID = 'cmu5p70yu0001bm7pzqlcawsw';
const ORDER_ID = 'cmu5p70yu0002bm7pzqlcawsw';
const ACTOR_ID = 'cmu4cpwbg000bdl0ubltmh740';

/** Понедельник, 15 сентября 2025 года, 12:00 МСК. */
const MONDAY = new Date('2025-09-15T09:00:00.000Z');

const ACTOR: AuthenticatedUser = {
  id: ACTOR_ID,
  email: 'manager@remixgold.ru',
  fullName: 'Менеджер',
  roles: ['MANAGER'],
  primaryRole: 'MANAGER',
} as AuthenticatedUser;

/** Пустой календарь: выходные определяются по дню недели. */
const CALENDAR = { overrides: new Map(), defaultHours: 8 };

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CLAIM_ID,
    claimNo: 'РЕК-25-00001',
    orderId: ORDER_ID,
    status: 'OPENED',
    reason: 'Разошёлся шов',
    clientStatement: null,
    openedAt: MONDAY,
    dueAt: new Date('2025-09-29T09:00:00.000Z'),
    reviewerId: null,
    resolution: null,
    rejectionReason: null,
    resolvedAt: null,
    closedAt: null,
    isWarrantyCase: true,
    warningSentAt: null,
    order: {
      id: ORDER_ID,
      orderNo: 'MSK1-2509-000001',
      status: 'COMPLETED',
      totalAmountMinor: 1500000,
      isWarranty: false,
      warrantyUntil: new Date('2026-03-15T09:00:00.000Z'),
      customer: { fullName: 'Иванова А.', phone: '+79001234567' },
    },
    reviewer: null,
    ...overrides,
  };
}

/** Двойник Prisma с настраиваемыми ответами. */
function createPrismaMock() {
  const tx = {
    counter: { upsert: vi.fn() },
    warrantyClaim: { create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    orderStatusHistory: { create: vi.fn() },
  };

  return {
    warrantyClaim: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    order: { findUnique: vi.fn() },
    counter: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    orderStatusHistory: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    __tx: tx,
  };
}

function createService(prisma: ReturnType<typeof createPrismaMock>) {
  const workflow = { loadCalendar: vi.fn(async () => CALENDAR) };
  const service = new ClaimsService(prisma as never, workflow as never);
  return { service, workflow };
}

describe('Открытие рекламации', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    /*
     * Время фиксируется: срок отсчитывается от «сейчас», и без фиксации тест
     * зависел бы от дня запуска (выходные сдвигают расчёт рабочих дней).
     */
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY);
    prisma = createPrismaMock();
    prisma.order.findUnique.mockResolvedValue({
      id: ORDER_ID,
      orderNo: 'MSK1-2509-000001',
      status: 'COMPLETED',
    });
    prisma.__tx.counter.upsert.mockResolvedValue({ scope: 'CLAIM:2025', value: 1 });
    prisma.__tx.warrantyClaim.create.mockResolvedValue(claimRow());
  });

  it('считает срок в РАБОЧИХ днях: понедельник плюс 10 рабочих дней', () => {
    return createService(prisma)
      .service.open({ orderId: ORDER_ID, reason: 'Разошёлся шов' }, ACTOR)
      .then(() => {
        const data = prisma.__tx.warrantyClaim.create.mock.calls[0]![0].data;
        // 10 рабочих дней от понедельника 15.09 — понедельник 29.09, а не 25.09.
        expect(data.dueAt.toISOString().slice(0, 10)).toBe('2025-09-29');
      });
  });

  it('берёт номер из счётчика за год, а не из числа записей', async () => {
    await createService(prisma).service.open({ orderId: ORDER_ID, reason: 'Разошёлся шов' }, ACTOR);

    expect(prisma.__tx.counter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: 'CLAIM:2025' } }),
    );
    const data = prisma.__tx.warrantyClaim.create.mock.calls[0]![0].data;
    expect(data.claimNo).toBe('РЕК-25-00001');
  });

  it('отклоняет рекламацию по незавершённому заказу', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: ORDER_ID,
      orderNo: 'X',
      status: 'IN_PRODUCTION',
    });

    // Гарантия отсчитывается от выдачи: пока заказ в работе, речь о переделке.
    await expect(
      createService(prisma).service.open({ orderId: ORDER_ID, reason: 'Разошёлся шов' }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'CLAIM_ORDER_NOT_COMPLETED' } });
  });

  it('отклоняет пустую причину', async () => {
    await expect(
      createService(prisma).service.open({ orderId: ORDER_ID, reason: '   ' }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    // Ничего не создаётся: отклонение произошло до обращения к базе.
    expect(prisma.__tx.warrantyClaim.create).not.toHaveBeenCalled();
  });

  it('отклоняет неизвестный заказ', async () => {
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(
      createService(prisma).service.open({ orderId: ORDER_ID, reason: 'Разошёлся шов' }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('пишет рекламацию в аудит', async () => {
    await createService(prisma).service.open({ orderId: ORDER_ID, reason: 'Разошёлся шов' }, ACTOR);

    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entity: 'WarrantyClaim', action: 'CREATE' }),
      }),
    );
  });

  it('допускает открытие по невостребованному заказу', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, orderNo: 'X', status: 'UNCLAIMED' });

    // Изделие выдано не было, но изготовлено: гарантия уже действует.
    await expect(
      createService(prisma).service.open({ orderId: ORDER_ID, reason: 'Разошёлся шов' }, ACTOR),
    ).resolves.toMatchObject({ claimNo: 'РЕК-25-00001' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe('Смена статуса рекламации', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.warrantyClaim.findUnique.mockResolvedValue({
      id: CLAIM_ID,
      claimNo: 'РЕК-25-00001',
      status: 'OPENED',
      orderId: ORDER_ID,
      order: { status: 'COMPLETED' },
    });
    prisma.__tx.warrantyClaim.update.mockResolvedValue(
      claimRow({ status: 'IN_REVIEW', reviewer: { id: ACTOR_ID, fullName: 'Менеджер' } }),
    );
  });

  it('назначает рассматривающего при взятии в работу', async () => {
    await createService(prisma).service.transition(CLAIM_ID, { to: 'IN_REVIEW' }, ACTOR);

    const data = prisma.__tx.warrantyClaim.update.mock.calls[0]![0].data;
    expect(data.reviewerId).toBe(ACTOR_ID);
  });

  it('пишет событие в историю основного заказа (задача 6.5)', async () => {
    await createService(prisma).service.transition(CLAIM_ID, { to: 'IN_REVIEW' }, ACTOR);

    expect(prisma.__tx.orderStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: ORDER_ID,
          reason: expect.stringContaining('РЕК-25-00001'),
        }),
      }),
    );
  });

  it('не меняет статус заказа в истории рекламации', async () => {
    await createService(prisma).service.transition(CLAIM_ID, { to: 'IN_REVIEW' }, ACTOR);

    // Рекламация — отдельный процесс: перевод заказа исказил бы сроки производства.
    const data = prisma.__tx.orderStatusHistory.create.mock.calls[0]![0].data;
    expect(data.toStatus).toBe('COMPLETED');
  });

  it('требует причину при отказе', async () => {
    await expect(
      createService(prisma).service.transition(CLAIM_ID, { to: 'REJECTED' }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'CLAIM_REJECTION_REASON_REQUIRED' } });
    expect(prisma.__tx.warrantyClaim.update).not.toHaveBeenCalled();
  });

  it('записывает причину отказа в своё поле', async () => {
    prisma.__tx.warrantyClaim.update.mockResolvedValue(claimRow({ status: 'REJECTED' }));

    await createService(prisma)
      .service.transition(CLAIM_ID, { to: 'REJECTED', rejectionReason: 'Следы удара' }, ACTOR)
      .catch(() => undefined);

    const data = prisma.__tx.warrantyClaim.update.mock.calls[0]![0].data;
    expect(data.rejectionReason).toBe('Следы удара');
    // Урегулирования нет: отказ — не урегулирование.
    expect(data.resolvedAt).toBeUndefined();
  });

  it('не переоткрывает закрытую рекламацию', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue({
      id: CLAIM_ID,
      claimNo: 'РЕК-25-00001',
      status: 'CLOSED',
      orderId: ORDER_ID,
      order: { status: 'COMPLETED' },
    });

    await expect(
      createService(prisma).service.transition(CLAIM_ID, { to: 'IN_REVIEW' }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'CLAIM_TERMINAL' } });
  });

  it('запрещает закрыть одобренную рекламацию без урегулирования', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue({
      id: CLAIM_ID,
      claimNo: 'РЕК-25-00001',
      status: 'APPROVED',
      orderId: ORDER_ID,
      order: { status: 'COMPLETED' },
    });

    await expect(
      createService(prisma).service.transition(CLAIM_ID, { to: 'CLOSED' }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'CLAIM_ILLEGAL_TRANSITION' } });
  });

  it('фиксирует дату урегулирования, но не дату закрытия', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue({
      id: CLAIM_ID,
      claimNo: 'РЕК-25-00001',
      status: 'APPROVED',
      orderId: ORDER_ID,
      order: { status: 'COMPLETED' },
    });
    prisma.__tx.warrantyClaim.update.mockResolvedValue(claimRow({ status: 'RESOLVED_REFUND' }));

    await createService(prisma).service.transition(CLAIM_ID, { to: 'RESOLVED_REFUND' }, ACTOR);

    const data = prisma.__tx.warrantyClaim.update.mock.calls[0]![0].data;
    expect(data.resolvedAt).toBeInstanceOf(Date);
    // Закрытие — отдельный шаг: изделие может быть ещё не выдано клиенту.
    expect(data.closedAt).toBeUndefined();
  });

  it('фиксирует дату закрытия', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue({
      id: CLAIM_ID,
      claimNo: 'РЕК-25-00001',
      status: 'RESOLVED_REPAIR',
      orderId: ORDER_ID,
      order: { status: 'COMPLETED' },
    });
    prisma.__tx.warrantyClaim.update.mockResolvedValue(claimRow({ status: 'CLOSED' }));

    await createService(prisma).service.transition(CLAIM_ID, { to: 'CLOSED' }, ACTOR);

    const data = prisma.__tx.warrantyClaim.update.mock.calls[0]![0].data;
    expect(data.closedAt).toBeInstanceOf(Date);
  });

  it('не сообщает о неизвестной рекламации как о найденной', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue(null);

    await expect(
      createService(prisma).service.transition(CLAIM_ID, { to: 'IN_REVIEW' }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });
});

describe('Сохранение исхода при закрытии (дефект, найденный на живом сервере)', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('записывает исход в поле, а не только в статус', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue({
      id: CLAIM_ID,
      claimNo: 'РЕК-25-00001',
      status: 'APPROVED',
      orderId: ORDER_ID,
      order: { status: 'COMPLETED' },
    });
    prisma.__tx.warrantyClaim.update.mockResolvedValue(claimRow({ status: 'RESOLVED_REFUND' }));

    await createService(prisma).service.transition(CLAIM_ID, { to: 'RESOLVED_REFUND' }, ACTOR);

    /*
     * Без записи исхода закрытие переводит рекламацию в `CLOSED`, и отчёт уже не
     * может ответить, сколько денег вернули: статус `RESOLVED_REFUND` стёрт.
     * Именно это и произошло на живом сервере — отчёт показал ноль возвратов по
     * закрытой рекламации с возвратом.
     */
    const data = prisma.__tx.warrantyClaim.update.mock.calls[0]![0].data;
    expect(data.resolution).toBe('RESOLVED_REFUND');
  });

  it('сохраняет исход ремонта отдельно от возврата', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue({
      id: CLAIM_ID,
      claimNo: 'РЕК-25-00001',
      status: 'APPROVED',
      orderId: ORDER_ID,
      order: { status: 'COMPLETED' },
    });
    prisma.__tx.warrantyClaim.update.mockResolvedValue(claimRow({ status: 'RESOLVED_REPAIR' }));

    await createService(prisma).service.transition(CLAIM_ID, { to: 'RESOLVED_REPAIR' }, ACTOR);

    const data = prisma.__tx.warrantyClaim.update.mock.calls[0]![0].data;
    expect(data.resolution).toBe('RESOLVED_REPAIR');
  });

  it('не записывает исход при переходах, которые им не являются', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue({
      id: CLAIM_ID,
      claimNo: 'РЕК-25-00001',
      status: 'OPENED',
      orderId: ORDER_ID,
      order: { status: 'COMPLETED' },
    });
    prisma.__tx.warrantyClaim.update.mockResolvedValue(claimRow({ status: 'IN_REVIEW' }));

    await createService(prisma).service.transition(CLAIM_ID, { to: 'IN_REVIEW' }, ACTOR);

    // Взятие в работу — не исход: поле остаётся незаполненным.
    const data = prisma.__tx.warrantyClaim.update.mock.calls[0]![0].data;
    expect(data.resolution).toBeUndefined();
  });

  it('отдаёт читаемую формулировку исхода', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue(
      claimRow({ status: 'CLOSED', resolution: 'RESOLVED_REFUND' }),
    );

    const claim = await createService(prisma).service.get(CLAIM_ID);

    // После закрытия статус уже `CLOSED`, и подпись обязана браться из исхода.
    expect(claim.resolutionLabel).toBe('Возврат денег');
  });
});

describe('Реестр рекламаций', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('считает остаток рабочих дней, а не календарных', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([claimRow()]);
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY);

    const items = await createService(prisma).service.list();

    // От понедельника 15.09 до срока 29.09 — ровно 10 рабочих дней.
    expect(items[0]!.workingDaysLeft).toBe(10);
    vi.useRealTimers();
  });

  it('помечает просроченную рекламацию', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([claimRow()]);
    vi.setSystemTime(new Date('2025-10-05T09:00:00.000Z'));

    const items = await createService(prisma).service.list();

    expect(items[0]!.isOverdue).toBe(true);
    vi.useRealTimers();
  });

  it('не считает просроченной закрытую рекламацию', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([claimRow({ status: 'CLOSED' })]);
    vi.setSystemTime(new Date('2026-01-05T09:00:00.000Z'));

    const items = await createService(prisma).service.list();

    // Иначе список просроченных превратился бы в архив.
    expect(items[0]!.isOverdue).toBe(false);
    vi.useRealTimers();
  });

  it('фильтрует по просрочке после расчёта, а не в запросе', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([
      claimRow({ id: 'a', dueAt: new Date('2025-09-29T09:00:00.000Z'), status: 'OPENED' }),
      claimRow({ id: 'b', dueAt: new Date('2025-09-30T09:00:00.000Z'), status: 'OPENED' }),
    ]);
    vi.setSystemTime(new Date('2025-09-29T12:00:00.000Z'));

    const items = await createService(prisma).service.list({ overdueOnly: true });

    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('a');
    vi.useRealTimers();
  });

  it('отклоняет неизвестный статус вместо «показать всё»', async () => {
    // Молча проигнорированный фильтр выглядел бы как «рекламаций нет».
    await expect(
      createService(prisma).service.list({ status: 'НЕТ_ТАКОГО' }),
    ).rejects.toMatchObject({
      response: { code: 'VALIDATION_ERROR' },
    });
    expect(prisma.warrantyClaim.findMany).not.toHaveBeenCalled();
  });

  it('отдаёт допустимые переходы для интерфейса', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue(claimRow());

    const claim = await createService(prisma).service.get(CLAIM_ID);

    expect(claim.availableTransitions).toEqual(['IN_REVIEW', 'APPROVED', 'REJECTED']);
  });

  it('не предлагает переходов для закрытой рекламации', async () => {
    prisma.warrantyClaim.findUnique.mockResolvedValue(claimRow({ status: 'CLOSED' }));

    const claim = await createService(prisma).service.get(CLAIM_ID);

    expect(claim.availableTransitions).toEqual([]);
    expect(claim.isTerminal).toBe(true);
  });
});

describe('Предупреждения о сроке', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('пропускает рекламации, по которым предупреждение уже ушло', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([]);

    const rows = await createService(prisma).service.findNeedingWarning();

    expect(rows).toHaveLength(0);
    expect(prisma.warrantyClaim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ warningSentAt: null }),
      }),
    );
  });

  it('не предупреждает по рекламации с далёким сроком', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([
      {
        id: CLAIM_ID,
        claimNo: 'РЕК-25-00001',
        dueAt: new Date('2025-12-31T09:00:00.000Z'),
        orderId: ORDER_ID,
        status: 'OPENED',
      },
    ]);
    vi.setSystemTime(MONDAY);

    const rows = await createService(prisma).service.findNeedingWarning();

    expect(rows).toHaveLength(0);
    vi.useRealTimers();
  });

  it('предупреждает, когда до срока осталось мало рабочих дней', async () => {
    // Срок 29.09 (понедельник); предупреждение наступает за 3 рабочих дня —
    // то есть с 24.09. На 26.09 оно обязано сработать.
    prisma.warrantyClaim.findMany.mockResolvedValue([
      {
        id: CLAIM_ID,
        claimNo: 'РЕК-25-00001',
        dueAt: new Date('2025-09-29T09:00:00.000Z'),
        orderId: ORDER_ID,
        status: 'OPENED',
      },
    ]);
    vi.setSystemTime(new Date('2025-09-26T09:00:00.000Z'));

    const rows = await createService(prisma).service.findNeedingWarning();

    expect(rows).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('Сводка по рекламациям (задача 6.7)', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('считает исходы раздельно: ремонт, возврат, отказ', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([
      claimRow({
        id: '1',
        status: 'RESOLVED_REPAIR',
        resolvedAt: new Date('2025-09-25T09:00:00.000Z'),
      }),
      claimRow({
        id: '2',
        status: 'RESOLVED_REFUND',
        resolvedAt: new Date('2025-09-26T09:00:00.000Z'),
      }),
      claimRow({ id: '3', status: 'REJECTED' }),
      claimRow({ id: '4', status: 'OPENED' }),
    ]);

    const summary = await createService(prisma).service.summary(
      MONDAY,
      new Date('2025-10-31T00:00:00.000Z'),
    );

    expect(summary.total).toBe(4);
    expect(summary.resolvedRepair).toBe(1);
    expect(summary.resolvedRefund).toBe(1);
    expect(summary.rejected).toBe(1);
  });

  it('считает среднюю длительность разбора в рабочих днях', async () => {
    // 15.09 (пн) → 25.09 (чт): 8 рабочих дней, а не 10 календарных.
    prisma.warrantyClaim.findMany.mockResolvedValue([
      claimRow({ status: 'RESOLVED_REPAIR', resolvedAt: new Date('2025-09-25T09:00:00.000Z') }),
    ]);

    const summary = await createService(prisma).service.summary(
      MONDAY,
      new Date('2025-10-31T00:00:00.000Z'),
    );

    expect(summary.averageReviewWorkingDays).toBe(8);
  });

  it('не считает среднее, если решений ещё не было', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([claimRow({ status: 'OPENED' })]);

    const summary = await createService(prisma).service.summary(
      MONDAY,
      new Date('2025-10-31T00:00:00.000Z'),
    );

    // Ноль означал бы «разбирали мгновенно»; отсутствие данных — это null.
    expect(summary.averageReviewWorkingDays).toBeNull();
  });

  it('считает просроченные среди незавершённых', async () => {
    prisma.warrantyClaim.findMany.mockResolvedValue([
      claimRow({ id: '1', dueAt: new Date('2025-09-29T09:00:00.000Z'), status: 'OPENED' }),
      claimRow({ id: '2', dueAt: new Date('2025-10-01T09:00:00.000Z'), status: 'IN_REVIEW' }),
    ]);
    vi.setSystemTime(new Date('2025-09-30T09:00:00.000Z'));

    const summary = await createService(prisma).service.summary(
      MONDAY,
      new Date('2025-10-31T00:00:00.000Z'),
    );

    expect(summary.overdue).toBe(1);
    vi.useRealTimers();
  });
});
