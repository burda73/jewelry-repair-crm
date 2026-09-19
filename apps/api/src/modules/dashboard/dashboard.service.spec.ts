/**
 * Тесты сводки главного экрана (задача 5.8, docs/06 §6.5).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Дашборд — единственное место, где собраны числа из разных
 * источников. Ошибка здесь не видна: числа правдоподобны, страница работает.
 * Поэтому проверяются три свойства, которые легко потерять при правке:
 *
 *  * БЛОКИ ПО ПРАВАМ. Кассир не должен видеть загрузку цеха, а руководитель
 *    производства — выручку. Проверяется ещё и то, что недоступные блоки НЕ
 *    ЗАПРАШИВАЮТСЯ: иначе дашборд кассира грузит тяжёлый отчёт, который он
 *    никогда не увидит.
 *  * ЧИСЛА СОВПАДАЮТ С ОТЧЁТАМИ. Выручка и загрузка берутся из тех же отчётов,
 *    что открываются по клику. Свой запрос дал бы второе определение, и два
 *    числа на одном экране разошлись бы.
 *  * ПРОСРОЧКА БЕЗ ЗАКРЫТЫХ ЗАКАЗОВ. Здесь был реальный дефект: `/orders/summary`
 *    считал все заказы с прошедшим сроком, включая выданные. Счётчик рос навсегда
 *    и не уменьшался, потому что выполненные заказы из него не уходили.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  visibleDashboardBlocks,
  DASHBOARD_BLOCK,
  DASHBOARD_UNIT,
  REPORT_NAME,
  ROLE_PERMISSIONS,
  ROLE,
  PERMISSION,
  type Permission,
} from '@app/shared';
import { DashboardService, currentMonthPeriod } from './dashboard.service';
import { DASHBOARD_ROUTE_PERMISSIONS } from './dashboard.controller';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import type { RoleCode } from '@app/shared';

/**
 * Сотрудник с указанными ролями.
 *
 * Роли задаются ЯВНО, а не выводятся из набора прав: попытка подобрать роль по
 * правам даёт объединение всех подходящих ролей, и тогда «кассир» получает права
 * администратора — тест начинает проверять не то, что задумано.
 */
function user(...roles: RoleCode[]): AuthenticatedUser {
  return {
    id: 'u-1',
    email: 'user@remixgold.ru',
    roles,
    primaryRole: roles[0] ?? ROLE.RECEIVER,
    scope: 'ALL_STORES',
    storeIds: [],
  } as unknown as AuthenticatedUser;
}

const A = '2025-09-15T12:00:00.000Z';

/**
 * Двойник Prisma и отчётов.
 *
 * Отчёты — двойники с заданными итогами: тест проверяет, что дашборд берёт число
 * ИМЕННО оттуда и правильно его читает, а не пересчитывает агрегаты заново.
 */
function makeService(overrides: Record<string, unknown> = {}) {
  const totalsByName: Record<string, Record<string, unknown>> = {
    [REPORT_NAME.REVENUE]: { netRevenueMinor: 1_170_000 },
    [REPORT_NAME.PREPAYMENTS]: { inWorkMinor: 240_000 },
    [REPORT_NAME.STAGE_DURATIONS]: { avgHours: 62.4 },
    [REPORT_NAME.WORKSHOP_LOAD]: { plannedHours: 160, factHours: 140 },
  };

  const reports = {
    build: vi.fn(async (name: string) => ({
      meta: { from: '2025-09-01', to: '2025-09-30', generatedAt: A, cached: false, rowCount: 0 },
      columns: [],
      rows: [],
      totals: totalsByName[name] ?? {},
    })),
  };

  const prisma = {
    buildOrderScopeFilter: vi.fn(() => ({})),
    order: { count: vi.fn(async () => 7) },
    warrantyClaim: { count: vi.fn(async () => 2) },
    ...overrides,
  };

  const service = new DashboardService(prisma as never, reports as never);
  return { service, reports, prisma };
}

const ALL_BLOCKS = Object.values(DASHBOARD_BLOCK);
const fullAccess = user(ROLE.ADMIN);

describe('Состав сводки по правам (задача 5.8)', () => {
  it('администратор получает все блоки', async () => {
    const { service } = makeService();
    const result = await service.build(fullAccess, new Date(A));
    expect(result.blocks.map((b) => b.code).sort()).toEqual([...ALL_BLOCKS].sort());
  });

  it('кассир НЕ получает загрузку цеха', async () => {
    /*
     * Главная проверка состава. Кассир работает с оплатой и не управляет
     * производством: показать ему загрузку цеха — дать число, за которое он не
     * отвечает и не может повлиять.
     */
    const { service } = makeService();
    const result = await service.build(user(ROLE.CASHIER), new Date(A));
    const codes = result.blocks.map((b) => b.code);

    expect(codes).toContain(DASHBOARD_BLOCK.REVENUE_MONTH);
    expect(codes).not.toContain(DASHBOARD_BLOCK.WORKSHOP_LOAD);
  });

  it('руководитель производства НЕ получает выручку', async () => {
    // Обратная граница: производство видит свою загрузку и не видит деньги
    // клиентов.
    const { service } = makeService();
    const result = await service.build(user(ROLE.PRODUCTION_MANAGER), new Date(A));
    const codes = result.blocks.map((b) => b.code);

    expect(codes).toContain(DASHBOARD_BLOCK.WORKSHOP_LOAD);
    expect(codes).not.toContain(DASHBOARD_BLOCK.REVENUE_MONTH);
  });

  it('недоступные блоки НЕ ЗАПРАШИВАЮТСЯ, а не просто скрываются', async () => {
    /*
     * Разница практическая: если считать всё, дашборд кассира грузил бы тяжёлый
     * отчёт по загрузке цеха, который он никогда не увидит.
     */
    const { service, reports } = makeService();
    await service.build(user(ROLE.CASHIER), new Date(A));

    const requested = reports.build.mock.calls.map((call) => call[0]);
    expect(requested).toContain(REPORT_NAME.REVENUE);
    expect(requested).not.toContain(REPORT_NAME.WORKSHOP_LOAD);
    expect(requested).not.toContain(REPORT_NAME.STAGE_DURATIONS);
  });

  it('сотрудник без прав получает пустой список, а не выдуманные нули', async () => {
    // Пустой экран честнее: интерфейс покажет пояснение, а не «0 заказов».
    const { service } = makeService();
    const result = await service.build(user(), new Date(A));
    expect(result.blocks).toHaveLength(0);
  });

  it('порядок блоков — порядок спецификации', async () => {
    // Экран не должен переставляться в зависимости от роли: человек привыкает
    // к расположению карточек.
    const { service } = makeService();
    const result = await service.build(fullAccess, new Date(A));
    const codes = result.blocks.map((b) => b.code);
    expect(codes).toEqual([
      DASHBOARD_BLOCK.IN_WORK,
      DASHBOARD_BLOCK.OVERDUE,
      DASHBOARD_BLOCK.REVENUE_MONTH,
      DASHBOARD_BLOCK.PREPAYMENTS_IN_WORK,
      DASHBOARD_BLOCK.AVG_REPAIR,
      DASHBOARD_BLOCK.WORKSHOP_LOAD,
      DASHBOARD_BLOCK.OPEN_CLAIMS,
    ]);
  });

  it('каждый блок содержит путь для клика', async () => {
    // Требование docs/06 §6.5: каждый блок ведёт в отчёт или список.
    const { service } = makeService();
    const result = await service.build(fullAccess, new Date(A));
    for (const block of result.blocks) {
      expect(block.href, block.code).toMatch(/^\//);
    }
  });
});

describe('Значения блоков (задача 5.8)', () => {
  it('выручка берётся из отчёта, а не пересчитывается', async () => {
    /*
     * Число на дашборде обязано совпадать с числом в отчёте, который
     * открывается по клику. Свой запрос здесь дал бы второе определение
     * выручки, и два числа на одном экране разошлись бы.
     */
    const { service, reports, prisma } = makeService();
    const result = await service.build(fullAccess, new Date(A));

    const revenue = result.blocks.find((b) => b.code === DASHBOARD_BLOCK.REVENUE_MONTH);
    expect(revenue?.value).toBe(1_170_000);
    expect(reports.build).toHaveBeenCalledWith(
      REPORT_NAME.REVENUE,
      expect.anything(),
      expect.anything(),
    );
    // Убеждаемся, что выручка не посчитана запросом к платежам.
    expect(prisma).not.toHaveProperty('payment');
  });

  it('денежные блоки считаются за текущий МЕСЯЦ', async () => {
    // Руководитель сверяет цифру с бухгалтерией, а та закрывает месяц
    // календарно — «последние 30 дней» с этим не сойдётся.
    const { service, reports } = makeService();
    await service.build(fullAccess, new Date('2025-09-15T12:00:00.000Z'));

    const revenueCall = reports.build.mock.calls.find((call) => call[0] === REPORT_NAME.REVENUE);
    expect(revenueCall?.[1].from.toISOString()).toBe('2025-09-01T00:00:00.000Z');
  });

  it('период включает текущие сутки целиком', async () => {
    /*
     * Конец периода — конец суток, а не `now`: выручка, внесённая час назад, не
     * попала бы в отчёт, потому что платёж записан моментом позже начала запроса.
     */
    const { service, reports } = makeService();
    await service.build(fullAccess, new Date('2025-09-15T12:00:00.000Z'));
    const call = reports.build.mock.calls.find((c) => c[0] === REPORT_NAME.REVENUE);
    expect(call?.[1].to.toISOString()).toBe('2025-09-15T23:59:59.999Z');
  });

  it('загрузка цеха показывается ДОЛЕЙ, а не часами', async () => {
    // «87 %» руководителю понятнее, чем «140 из 160 ч».
    const { service } = makeService();
    const result = await service.build(fullAccess, new Date(A));
    const load = result.blocks.find((b) => b.code === DASHBOARD_BLOCK.WORKSHOP_LOAD);

    expect(load?.unit).toBe(DASHBOARD_UNIT.PERCENT);
    expect(load?.value).toBe(0.875);
  });

  it('загрузка без плановых часов не показывается нулём', async () => {
    /*
     * Ноль процентов означал бы «цех простаивает», а это неправда: плановых
     * часов просто нет. `null` — «данных нет», и интерфейс покажет прочерк.
     */
    const { service } = makeService();
    const reports = (service as unknown as { reports: { build: ReturnType<typeof vi.fn> } })
      .reports;
    reports.build.mockImplementation(async (name: string) => ({
      meta: {},
      columns: [],
      rows: [],
      totals: name === REPORT_NAME.WORKSHOP_LOAD ? { plannedHours: 0, factHours: 0 } : {},
    }));

    const result = await service.build(fullAccess, new Date(A));
    const load = result.blocks.find((b) => b.code === DASHBOARD_BLOCK.WORKSHOP_LOAD);
    expect(load?.value).toBeNull();
  });

  it('отсутствующее значение показывается прочерком, а не нулём', async () => {
    /*
     * Для «среднего срока ремонта» ноль означал бы «ремонт занимает 0 часов»,
     * то есть мгновенный. Отсутствие данных — это `null`.
     */
    const { service } = makeService();
    const reports = (service as unknown as { reports: { build: ReturnType<typeof vi.fn> } })
      .reports;
    reports.build.mockResolvedValue({ meta: {}, columns: [], rows: [], totals: {} });

    const result = await service.build(fullAccess, new Date(A));
    const avg = result.blocks.find((b) => b.code === DASHBOARD_BLOCK.AVG_REPAIR);
    expect(avg?.value).toBeNull();
  });

  it('сводка помечена моментом сбора', async () => {
    // Без этого признака нельзя понять, насколько данные свежи.
    const { service } = makeService();
    const result = await service.build(fullAccess, new Date(A));
    expect(result.generatedAt).toBe(A);
  });

  it('период отдаётся интерфейсу', async () => {
    // Интерфейс подписывает блоки «за сентябрь» — по этим датам.
    const { service } = makeService();
    const result = await service.build(fullAccess, new Date(A));
    expect(result.period).toEqual({ from: '2025-09-01', to: '2025-09-15' });
  });
});

describe('Просрочка на дашборде (дефект, задача 5.8)', () => {
  it('просрочка исключает ЗАКРЫТЫЕ заказы', async () => {
    /*
     * РЕАЛЬНЫЙ ДЕФЕКТ. `/orders/summary` считал `dueAt < now` без фильтра по
     * статусу: выданный заказ с истёкшим сроком изготовления попадал в
     * «просрочено» НАВСЕГДА. Чем дольше работает сеть, тем больше счётчик, и
     * руководитель видел растущую просрочку, которую невозможно закрыть, —
     * выполненные заказы из неё не уходили.
     *
     * docs/06 §3 («Просрочено сейчас») требует исключать терминальные статусы, и
     * отчёт `overdue` их уже исключал. Дашборд и отчёт об одном и том же обязаны
     * показывать одно число.
     */
    const count = vi.fn(async () => 0);
    const { service } = makeService({ order: { count } });
    await service.build(fullAccess, new Date(A));

    const overdueCall = count.mock.calls.find((call) => {
      const where = JSON.stringify(call[0]?.where ?? {});
      return where.includes('dueAt');
    });
    expect(overdueCall, 'запрос просрочки не найден').toBeDefined();

    const where = JSON.stringify(overdueCall?.[0]?.where);
    for (const status of ['COMPLETED', 'REFUSED', 'CANCELLED', 'UNCLAIMED']) {
      expect(where, `статус ${status} должен исключаться`).toContain(status);
    }
  });

  it('просрочка не учитывает заказы, ждущие клиента', async () => {
    /*
     * `AWAITING_PREPAYMENT` ждёт клиента, а не сотрудника: напоминать
     * ответственному бессмысленно, пока клиент не заплатит. `DRAFT` и `ACCEPTED`
     * ещё не в производстве — срок по ним не начал идти.
     */
    const count = vi.fn(async () => 0);
    const { service } = makeService({ order: { count } });
    await service.build(fullAccess, new Date(A));

    const overdueCall = count.mock.calls.find((call) =>
      JSON.stringify(call[0]?.where ?? {}).includes('dueAt'),
    );
    const where = JSON.stringify(overdueCall?.[0]?.where);
    for (const status of ['DRAFT', 'ACCEPTED', 'AWAITING_PREPAYMENT']) {
      expect(where, `статус ${status} должен исключаться`).toContain(status);
    }
  });

  it('«в работе» исключает закрытые заказы', async () => {
    // Иначе счётчик «заказов в работе» включал бы выданные и отменённые.
    const count = vi.fn(async () => 0);
    const { service } = makeService({ order: { count } });
    await service.build(fullAccess, new Date(A));

    const inWork = count.mock.calls.find((call) => {
      const where = JSON.stringify(call[0]?.where ?? {});
      return where.includes('notIn') && !where.includes('dueAt');
    });
    expect(inWork, 'запрос «в работе» не найден').toBeDefined();
    const where = JSON.stringify(inWork?.[0]?.where);
    for (const status of ['COMPLETED', 'REFUSED', 'CANCELLED']) {
      expect(where, `статус ${status}`).toContain(status);
    }
  });

  it('рекламации считаются только открытые и рассматриваемые', async () => {
    // Одобренная и решённая — работа уже распределена, и в «в работе» им не
    // место, иначе руководитель видел бы очередь, которой нет.
    const claimCount = vi.fn(async () => 0);
    const { service } = makeService({ warrantyClaim: { count: claimCount } });
    await service.build(fullAccess, new Date(A));

    const where = JSON.stringify(claimCount.mock.calls[0]?.[0]?.where);
    expect(where).toContain('OPENED');
    expect(where).toContain('IN_REVIEW');
    expect(where).not.toContain('CLOSED');
  });
});

describe('Период текущего месяца (задача 5.8)', () => {
  it('начало — первое число месяца', () => {
    const period = currentMonthPeriod(new Date('2025-09-15T12:00:00.000Z'));
    expect(period.from.toISOString()).toBe('2025-09-01T00:00:00.000Z');
  });

  it('конец — конец текущих суток', () => {
    const period = currentMonthPeriod(new Date('2025-09-15T12:00:00.000Z'));
    expect(period.to.toISOString()).toBe('2025-09-15T23:59:59.999Z');
  });

  it('январь не уезжает в прошлый год', () => {
    // Проверка границы: месяц 0 — январь, и ошибка на единицу дала бы декабрь
    // прошлого года.
    const period = currentMonthPeriod(new Date('2026-01-05T08:00:00.000Z'));
    expect(period.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('декабрь не уезжает в следующий год', () => {
    const period = currentMonthPeriod(new Date('2025-12-31T23:00:00.000Z'));
    expect(period.from.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });
});

describe('Права маршрута главного экрана (задача 5.8)', () => {
  it('маршрут принимает ЛЮБОЕ из прав, а не только операционное', () => {
    /*
     * Дефект ровно такого рода уже был на отчётах (задача 5.6): маршрут требовал
     * только `report:operational`, и кассир с правом `report:revenue` не мог
     * открыть выручку — право есть, доступа нет. Здесь маршрут обязан пускать по
     * любому из прав, а состав блоков определяется внутри.
     */
    expect(DASHBOARD_ROUTE_PERMISSIONS.length).toBeGreaterThan(1);
    expect(DASHBOARD_ROUTE_PERMISSIONS).toContain(PERMISSION.ORDER_READ);
    expect(DASHBOARD_ROUTE_PERMISSIONS).toContain(PERMISSION.REPORT_REVENUE);
  });

  it('каждая роль с доступом к заказам или отчётам проходит маршрут', () => {
    // Если бы маршрут требовал одно конкретное право, часть ролей получила бы
    // 403 на главном экране — то есть не смогла бы войти в систему вообще.
    for (const role of Object.keys(ROLE_PERMISSIONS) as RoleCode[]) {
      const permissions = ROLE_PERMISSIONS[role];
      const passes = DASHBOARD_ROUTE_PERMISSIONS.some((p) => permissions.includes(p));
      expect(passes, `роль ${role} без доступа к главному экрану`).toBe(true);
    }
  });

  it('каждая роль с доступом получает хотя бы один блок', () => {
    /*
     * Роль, проходящая маршрут, но не получающая ни одного блока, увидела бы
     * пустой экран и решила бы, что система сломана.
     */
    for (const role of Object.keys(ROLE_PERMISSIONS) as RoleCode[]) {
      const permissions = ROLE_PERMISSIONS[role];
      if (!DASHBOARD_ROUTE_PERMISSIONS.some((p) => permissions.includes(p))) continue;
      const blocks = visibleDashboardBlocks(permissions);
      expect(blocks.length, `роль ${role}`).toBeGreaterThan(0);
    }
  });
});
