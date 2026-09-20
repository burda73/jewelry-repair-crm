/**
 * Тесты отчётов (задача 5.1, ТЗ п. 2.11).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Отчёт — это цифра, по которой принимают решение: нанимать
 * ювелира, разбираться с точкой, менять нормативы. Ошибка в ней не выглядит
 * ошибкой: число правдоподобно. Поэтому проверяются места, где ошибка
 * правдоподобна особенно:
 *
 *  * ОБЛАСТЬ ВИДИМОСТИ. Параметр `storeId` приходит от клиента. Если принять его
 *    как есть, приёмщик одного магазина получит отчёт по всей сети, дописав в
 *    адрес чужой идентификатор. Проверяется, что запрошенное СУЖАЕТ доступ, а не
 *    заменяет его, и что роль без магазинов не видит ничего.
 *  * ГРАНИЦЫ ПЕРИОДА. Даты задаются московскими сутками. При разборе как UTC
 *    отчёт за сентябрь захватил бы часть 31 августа, и числа не сошлись бы с
 *    отчётом за август.
 *  * ПОСЛЕДНИЙ ДЕНЬ ПЕРИОДА. Верхняя граница — дата, а данные хранятся
 *    моментами времени. Без расширения до конца суток из отчёта выпадало бы всё,
 *    что случилось после полуночи последнего дня.
 *  * ПРОСРОЧКА «СЕЙЧАС» И «ЗА ПЕРИОД» — РАЗНЫЕ ЧИСЛА. Выданный с опозданием
 *    заказ в текущем состоянии не виден, но в оценке работы точки остаётся.
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_NAME, permissionForReport } from '@app/shared';
import {
  RESTRICTED_TO_NOTHING,
  ReportsService,
  parseReportPeriod,
  scopedStoreIds,
  toDateKey,
} from './reports.service';
import { parseReportQuery } from './reports.controller';
import { ReportsCacheService } from '../../common/cache/reports-cache.service';

const STORE_A = 'cmu5p70yu0002bm7pzqlcawsw';
const STORE_B = 'cmu5p70yu0003bm7pzqlcawsw';
const WORKSHOP = 'cmu5p70yu0004bm7pzqlcawsw';

/*
 * Действующие лица тестов несут и `scope`, и `scopes` — как реальный
 * пользователь после задачи 7.7. `scope` остался для отображения, а фильтрация
 * идёт по набору областей (дефект 65), поэтому двойник без `scopes` проверял бы
 * несуществующее состояние системы.
 */
/** Роль приёмщика: видит один магазин. */
const RECEIVER = { scope: 'STORE' as const, scopes: ['STORE'] as const, storeIds: [STORE_A] };
/** Руководитель: видит всю сеть. */
const MANAGER = {
  scope: 'ALL_STORES' as const,
  scopes: ['ALL_STORES'] as const,
  storeIds: [] as string[],
};
/** Приёмщик со ВТОРОЙ ролью логиста (задача 7.7): магазин И производство. */
const RECEIVER_AND_LOGISTICIAN = {
  scope: 'PRODUCTION' as const,
  scopes: ['STORE_PLUS_GLOBAL_SEARCH', 'PRODUCTION'] as const,
  storeIds: [STORE_A],
};
/** Роль без магазинов: доступ есть, данных нет. */
const ORPHAN = { scope: 'STORE' as const, scopes: ['STORE'] as const, storeIds: [] as string[] };

function query(overrides: Record<string, unknown> = {}) {
  return {
    from: new Date('2025-09-01T00:00:00+03:00'),
    to: new Date('2025-09-30T00:00:00+03:00'),
    storeIds: [] as string[],
    workshopIds: [] as string[],
    groupBy: null,
    limit: 500,
    ...overrides,
  } as never;
}

function actor(scope: string, storeIds: string[] = []) {
  /*
   * Набор областей по умолчанию — из одной области: так выглядит сотрудник с
   * единственной ролью. Мультирольные случаи передают `scopes` явно.
   */
  return { id: 'u-1', scope, scopes: [scope], storeIds } as never;
}

/** Двойник Prisma с настраиваемыми выборками. */
/**
 * Подделка `ConfigService` для настройки `REPORT_CACHE_TTL_SECONDS`.
 *
 * По умолчанию настройка не задана: тесты отчётов проверяют доменные правила,
 * а не кэш, и подстановка чужого TTL исказила бы их смысл.
 */
function makeConfig(values: Record<string, unknown> = {}) {
  return { get: (key: string) => values[key] };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const client = {
    orderStatusHistory: { findMany: vi.fn(async () => []) },
    order: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    performer: { findMany: vi.fn(async () => []) },
    orderAssignment: { findMany: vi.fn(async () => []) },
    payment: { findMany: vi.fn(async () => [] as unknown[]) },
    stageNorm: { findMany: vi.fn(async () => []) },
    store: { findMany: vi.fn(async () => [] as { id: string; name: string }[]) },
    workingCalendar: { findMany: vi.fn(async () => []) },
    ...overrides,
  };
  const workflow = {
    loadCalendar: vi.fn(async () => ({ overrides: new Map(), defaultHours: 9 })),
  };
  const service = new ReportsService(
    client as never,
    workflow as never,
    new ReportsCacheService(),
    makeConfig() as never,
  );
  return { service, client, workflow };
}

// ---------------------------------------------------------------------------
// Область видимости — главная защита модуля
// ---------------------------------------------------------------------------

describe('Область видимости отчётов (задача 5.1)', () => {
  it('приёмщик получает только свои магазины', () => {
    expect(scopedStoreIds(RECEIVER, [])).toEqual([STORE_A]);
  });

  it('запрошенный чужой магазин НЕ расширяет доступ', () => {
    /*
     * Главная проверка модуля. `storeId` приходит из строки запроса, то есть от
     * клиента: приняв его как есть, приёмщик получил бы отчёт по всей сети,
     * дописав в адрес `?storeId[]=чужой`.
     *
     * Ожидается МАРКЕР «доступа нет», а не пустой список: пустой список в этом
     * модуле означает «вся сеть». Возврат `[]` здесь — реальный дефект, который
     * этот тест и поймал: приёмщик получил бы отчёт по всей сети.
     */
    expect(scopedStoreIds(RECEIVER, [STORE_B])).toEqual(RESTRICTED_TO_NOTHING);
    expect(scopedStoreIds(RECEIVER, [STORE_B])).not.toEqual([]);
  });

  it('запрошенный свой магазин сохраняется', () => {
    expect(scopedStoreIds(RECEIVER, [STORE_A])).toEqual([STORE_A]);
  });

  it('из нескольких запрошенных остаются только доступные', () => {
    // Смешанный запрос: свой магазин остаётся, чужой отбрасывается.
    expect(scopedStoreIds(RECEIVER, [STORE_A, STORE_B])).toEqual([STORE_A]);
  });

  it('роль без магазинов не видит ничего, а не всю сеть', () => {
    /*
     * Пустой список магазинов означает «вся сеть» — так устроен фильтр у
     * руководителя. Если бы роль без магазинов отдавала пустой список, её
     * ограничение превратилось бы в свою противоположность: она увидела бы всё.
     */
    const scoped = scopedStoreIds(ORPHAN, []);
    expect(scoped).toEqual(RESTRICTED_TO_NOTHING);
    expect(scoped).not.toEqual([]);
  });

  it('роль без магазинов не получает доступа и по запросу', () => {
    expect(scopedStoreIds(ORPHAN, [STORE_A])).toEqual(RESTRICTED_TO_NOTHING);
  });

  it('руководитель без запроса видит всю сеть', () => {
    expect(scopedStoreIds(MANAGER, [])).toEqual([]);
  });

  it('руководитель может сузить отчёт до одной точки', () => {
    // Сужение разрешено: руководитель вправе посмотреть конкретный магазин.
    expect(scopedStoreIds(MANAGER, [STORE_B])).toEqual([STORE_B]);
  });

  it('аудитор и производство видят всю сеть', () => {
    // Раньше исключался только ALL_STORES, и аудитор получал пустой отчёт —
    // право на чтение без единой доступной записи.
    expect(scopedStoreIds({ scope: 'READ_ALL' as never, storeIds: [] }, [])).toEqual([]);
    expect(scopedStoreIds({ scope: 'PRODUCTION' as never, storeIds: [] }, [])).toEqual([]);
  });

  it('область видимости применяется в выборке заказов', async () => {
    const { service, client } = makeService();
    await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('STORE', [STORE_A]));

    const where = client.orderStatusHistory.findMany.mock.calls[0]?.[0]?.where;
    expect(where.order.createdStoreId).toEqual({ in: [STORE_A] });
  });

  it('чужой магазин в запросе не проходит в выборку', async () => {
    // Сквозная проверка: параметр из строки запроса не должен дойти до Prisma.
    const { service, client } = makeService();
    await service.build(
      REPORT_NAME.STAGE_DURATIONS,
      query({ storeIds: [STORE_B] }),
      actor('STORE', [STORE_A]),
    );

    const where = client.orderStatusHistory.findMany.mock.calls[0]?.[0]?.where;
    // Пересечение пусто → маркер «доступа нет», а не «все магазины».
    expect(where.order.createdStoreId).toEqual({ in: RESTRICTED_TO_NOTHING });
  });
});

// ---------------------------------------------------------------------------
// Период отчёта
// ---------------------------------------------------------------------------

describe('Период отчёта (задача 5.1)', () => {
  it('начало периода — московская полночь, а не UTC', () => {
    /*
     * `2025-09-01` как UTC-полночь — это 03:00 МСК. Отчёт за сентябрь пропустил
     * бы заказы, оформленные 1 сентября с 00:00 до 03:00 по московскому времени,
     * и они попали бы в отчёт за август.
     */
    const { from } = parseReportPeriod({ from: '2025-09-01', to: '2025-09-30' });
    expect(from.toISOString()).toBe('2025-08-31T21:00:00.000Z');
  });

  it('границы периода отображаются московскими датами', () => {
    const { from } = parseReportPeriod({ from: '2025-09-01', to: '2025-09-30' });
    expect(toDateKey(from)).toBe('2025-09-01');
  });

  it('без параметров берётся последний месяц', () => {
    const now = new Date('2025-09-30T12:00:00+03:00');
    const period = parseReportPeriod({}, now);
    expect(toDateKey(period.to)).toBe('2025-09-30');
    // Тридцать дней назад — конец августа.
    expect(toDateKey(period.from)).toBe('2025-08-31');
  });

  it('без верхней границы берётся сегодняшний день', () => {
    const now = new Date('2025-09-15T12:00:00+03:00');
    const period = parseReportPeriod({ from: '2025-09-01' }, now);
    expect(toDateKey(period.to)).toBe('2025-09-15');
  });

  it('начало позже окончания — ошибка', () => {
    // Иначе отчёт молча вернул бы пустой результат, и это выглядело бы как
    // «данных нет», а не как ошибка в параметрах.
    expect(() => parseReportPeriod({ from: '2025-09-30', to: '2025-09-01' })).toThrow(
      /Начало периода позже/,
    );
  });

  it('слишком длинный период — ошибка', () => {
    /*
     * Годовой срез считается, а «с 2015 года» — это выгрузка всей базы, которая
     * займёт её на минуты. Порог честнее показать ошибкой, чем выполнять запрос,
     * замедляющий работу приёмщиков.
     */
    expect(() => parseReportPeriod({ from: '2015-01-01', to: '2025-09-01' })).toThrow(
      /не может превышать/,
    );
  });

  it('период в пределах года принимается', () => {
    expect(() => parseReportPeriod({ from: '2025-01-01', to: '2025-12-31' })).not.toThrow();
  });
});

describe('Разбор параметров строки запроса (задача 5.1)', () => {
  it('одиночный storeId принимается как список', () => {
    // Express отдаёт `?storeId=a` строкой, а `?storeId[]=a` — массивом. Ссылка,
    // скопированная из адресной строки, должна работать в обоих видах.
    expect(parseReportQuery({ storeId: STORE_A }).storeIds).toEqual([STORE_A]);
  });

  it('массив storeId принимается', () => {
    expect(parseReportQuery({ storeId: [STORE_A, STORE_B] }).storeIds).toEqual([STORE_A, STORE_B]);
  });

  it('пустой storeId не превращается в магазин с пустым идентификатором', () => {
    // `?storeId=` — это отсутствие фильтра, а не поиск по пустой строке.
    expect(parseReportQuery({ storeId: '' }).storeIds).toEqual([]);
  });

  it('нестроковые значения отбрасываются', () => {
    expect(parseReportQuery({ storeId: [STORE_A, 42, null] }).storeIds).toEqual([STORE_A]);
  });

  it('предел строк ограничен сверху', () => {
    // Иначе `?limit=100000` вернул бы всю базу одним ответом.
    expect(parseReportQuery({ limit: '100000' }).limit).toBe(2000);
  });

  it('некорректный предел заменяется значением по умолчанию', () => {
    expect(parseReportQuery({ limit: 'abc' }).limit).toBe(500);
    expect(parseReportQuery({ limit: '-5' }).limit).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Отчёт «Сроки по этапам»
// ---------------------------------------------------------------------------

describe('Отчёт «Сроки по этапам» (задача 5.1)', () => {
  it('считает среднее, медиану и перцентиль по этапу', async () => {
    const rows = [
      { stage: 'PRODUCTION', durationMinutes: 60, order: { createdStoreId: STORE_A } },
      { stage: 'PRODUCTION', durationMinutes: 120, order: { createdStoreId: STORE_A } },
      { stage: 'PRODUCTION', durationMinutes: 180, order: { createdStoreId: STORE_A } },
    ];
    const { service } = makeService({
      orderStatusHistory: { findMany: vi.fn(async () => rows) },
    });
    const result = await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    const row = result.rows[0];
    expect(row?.ordersCount).toBe(3);
    // 60, 120, 180 минут → 1, 2, 3 часа.
    expect(row?.avgHours).toBe(2);
    expect(row?.medianHours).toBe(2);
  });

  it('переходы без длительности не попадают в статистику', async () => {
    /*
     * Строка истории создаётся и на первый переход, когда предыдущего статуса
     * нет, и `durationMinutes` тогда пуст. Если бы такие строки участвовали,
     * среднее занижалось бы нулями, и этап выглядел бы быстрее, чем он есть.
     */
    const { service, client } = makeService();
    await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    const where = client.orderStatusHistory.findMany.mock.calls[0]?.[0]?.where;
    expect(where.durationMinutes).toEqual({ not: null });
    expect(where.stage).toEqual({ not: null });
  });

  it('нарушения норматива считаются по нормативу этапа', async () => {
    const rows = [
      { stage: 'PRODUCTION', durationMinutes: 60, order: { createdStoreId: STORE_A } },
      { stage: 'PRODUCTION', durationMinutes: 600, order: { createdStoreId: STORE_A } },
    ];
    const { service } = makeService({
      orderStatusHistory: { findMany: vi.fn(async () => rows) },
      // Норматив 2 рабочих часа; второй переход (10 ч) его нарушает.
      stageNorm: {
        findMany: vi.fn(async () => [{ stage: 'PRODUCTION', unit: 'WORKHOUR', value: 2 }]),
      },
    });
    const result = await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    expect(result.rows[0]?.violations).toBe(1);
    // Один из двух в норме → 50 %.
    expect(result.rows[0]?.inNormShare).toBe(0.5);
  });

  it('норматив в рабочих днях переводится в часы по календарю', async () => {
    /*
     * Единицы нормативов разные (`WORKHOUR`, `WORKDAY`, `CALENDAR_DAY`), и
     * сравнивать сроки с нормативом можно только в одной единице. Рабочий день
     * берётся из календаря, а не константой: значение настраивается, и жёсткое
     * «8 часов» разошлось бы с расчётом сроков.
     */
    const rows = [
      { stage: 'PRODUCTION', durationMinutes: 60 * 10, order: { createdStoreId: STORE_A } },
    ];
    const { service } = makeService({
      orderStatusHistory: { findMany: vi.fn(async () => rows) },
      stageNorm: {
        findMany: vi.fn(async () => [{ stage: 'PRODUCTION', unit: 'WORKDAY', value: 1 }]),
      },
    });
    // Календарь на 12 часов: норматив = 12 ч, переход 10 ч — в норме.
    const workflow = {
      loadCalendar: vi.fn(async () => ({ overrides: new Map(), defaultHours: 12 })),
    };
    const custom = new ReportsService(
      (service as unknown as { prisma: unknown }).prisma as never,
      workflow as never,
      new ReportsCacheService(),
      makeConfig() as never,
    );
    const result = await custom.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    expect(result.rows[0]?.inNormShare).toBe(1);
    expect(result.rows[0]?.violations).toBe(0);
  });

  it('верхняя граница периода расширена до конца суток', async () => {
    /*
     * Период задаётся датой (`2025-09-30`), а данные хранятся моментами времени.
     * Если сравнивать с началом суток, из отчёта выпадет всё, что случилось
     * после полуночи последнего дня, — то есть ровно за 30 сентября. Ошибка
     * незаметна: отчёт построится, просто последний день будет пустым.
     */
    const { service, client } = makeService();
    await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    const where = client.orderStatusHistory.findMany.mock.calls[0]?.[0]?.where;
    const upper = (where.createdAt.lte as Date).getTime();
    const periodStart = where.createdAt.gte.getTime();
    // Верхняя граница — на сутки позже начала, а не равна ему.
    expect(upper - periodStart).toBe(30 * 86_400_000 - 1);
  });

  it('разрез по магазину подписан НАЗВАНИЕМ магазина, а не идентификатором', async () => {
    /*
     * Дефект, замеченный на живом отчёте: строка разреза выглядела как
     * «Производство · cmu47z0xq0000ampvqypjgtrd». Идентификатор в отчёте
     * прочитать нельзя, и разрез по магазину терял смысл.
     */
    const rows = [{ stage: 'PRODUCTION', durationMinutes: 60, order: { createdStoreId: STORE_A } }];
    const { service } = makeService({
      orderStatusHistory: { findMany: vi.fn(async () => rows) },
      store: { findMany: vi.fn(async () => [{ id: STORE_A, name: 'Тверская' }]) },
    });
    const result = await service.build(
      REPORT_NAME.STAGE_DURATIONS,
      query({ groupBy: 'store' }),
      actor('ALL_STORES'),
    );

    expect(result.rows[0]?.stage).toBe('Производство · Тверская');
    expect(String(result.rows[0]?.stage)).not.toContain(STORE_A);
  });

  it('норматив сравнивается с ДЛИТЕЛЬНОСТЬЮ своей строки, а не соседней', async () => {
    /*
     * Значение и норматив хранятся парой. Если бы они лежали двумя массивами с
     * выравниванием по индексу, пропуск одного норматива сдвинул бы все
     * последующие сравнения: сроки сравнивались бы с чужой нормой, и отчёт
     * показал бы нарушения там, где их нет.
     *
     * Здесь у этапа норматива нет вовсе, а у соседнего — есть. Сравнение не
     * должно «перетечь» между группами.
     */
    const rows = [
      { stage: 'PRODUCTION', durationMinutes: 600, order: { createdStoreId: STORE_A } },
      { stage: 'QUEUE', durationMinutes: 30, order: { createdStoreId: STORE_A } },
    ];
    const { service } = makeService({
      orderStatusHistory: { findMany: vi.fn(async () => rows) },
      stageNorm: {
        findMany: vi.fn(async () => [{ stage: 'PRODUCTION', unit: 'WORKHOUR', value: 2 }]),
      },
    });
    const result = await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    const production = result.rows.find((row) => String(row.stage).includes('Производство'));
    const queue = result.rows.find((row) => String(row.stage).includes('Очередь'));
    // Производство 10 ч при норме 2 ч — нарушение; у очереди норматива нет.
    expect(production?.violations).toBe(1);
    expect(production?.inNormShare).toBe(0);
    expect(queue?.violations).toBeNull();
    expect(queue?.inNormShare).toBeNull();
  });

  it('срок РОВНО по нормативу нарушением не считается', async () => {
    /*
     * Граница. «Уложиться в норматив» значит не превысить его, и переход длиной
     * ровно 2 часа при норме 2 часа — в норме. Если считать нарушением и
     * равенство, отчёт покажет нарушения у тех, кто как раз успел, — а это
     * подрывает доверие ко всему отчёту. Здесь же проверяется согласованность с
     * «долей в норме», где сравнение `<=`.
     */
    const rows = [
      { stage: 'PRODUCTION', durationMinutes: 120, order: { createdStoreId: STORE_A } },
    ];
    const { service } = makeService({
      orderStatusHistory: { findMany: vi.fn(async () => rows) },
      stageNorm: {
        findMany: vi.fn(async () => [{ stage: 'PRODUCTION', unit: 'WORKHOUR', value: 2 }]),
      },
    });
    const result = await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    expect(result.rows[0]?.violations).toBe(0);
    expect(result.rows[0]?.inNormShare).toBe(1);
  });

  it('разрез по магазину даёт отдельные строки', async () => {
    const rows = [
      { stage: 'PRODUCTION', durationMinutes: 60, order: { createdStoreId: STORE_A } },
      { stage: 'PRODUCTION', durationMinutes: 120, order: { createdStoreId: STORE_B } },
    ];
    const { service } = makeService({
      orderStatusHistory: { findMany: vi.fn(async () => rows) },
    });
    const result = await service.build(
      REPORT_NAME.STAGE_DURATIONS,
      query({ groupBy: 'store' }),
      actor('ALL_STORES'),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.ordersCount)).toEqual([1, 1]);
  });

  it('пустой период даёт null в показателях, а не ноль', async () => {
    // «Средний срок 0 ч» — утверждение, которого данные не подтверждают.
    const { service } = makeService();
    const result = await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    expect(result.rows).toEqual([]);
    expect(result.totals.avgHours).toBeNull();
    expect(result.meta.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Отчёт «Загрузка производства»
// ---------------------------------------------------------------------------

describe('Отчёт «Загрузка производства» (задача 5.2)', () => {
  it('считает плановые и фактические часы исполнителя', async () => {
    const { service } = makeService({
      performer: {
        findMany: vi.fn(async () => [
          {
            id: 'p-1',
            fullName: 'Ювелиров А.',
            specialization: 'пайка',
            workshop: { name: 'Цех 1' },
          },
        ]),
      },
      orderAssignment: {
        findMany: vi.fn(async () => [
          {
            performerId: 'p-1',
            status: 'DONE',
            plannedHours: 4,
            startedAt: new Date('2025-09-01T07:00:00Z'),
            finishedAt: new Date('2025-09-01T13:00:00Z'),
          },
        ]),
      },
    });
    const result = await service.build(REPORT_NAME.WORKSHOP_LOAD, query(), actor('ALL_STORES'));

    const row = result.rows[0];
    expect(row?.plannedHours).toBe(4);
    // Шесть часов между началом и завершением.
    expect(row?.factHours).toBe(6);
    // Отклонение факта от плана: работа дороже плана на 2 часа.
    expect(row?.deviationHours).toBe(2);
    expect(row?.completed).toBe(1);
  });

  it('незавершённые назначения не дают фактических часов', async () => {
    /*
     * У назначения в работе `finishedAt` пуст. Если бы разница считалась от
     * «сейчас», факт рос бы с каждым запросом отчёта — и одно и то же задание
     * показывало бы разную трудоёмкость.
     */
    const { service } = makeService({
      performer: {
        findMany: vi.fn(async () => [{ id: 'p-1', fullName: 'Ювелиров А.', workshop: null }]),
      },
      orderAssignment: {
        findMany: vi.fn(async () => [
          {
            performerId: 'p-1',
            status: 'IN_PROGRESS',
            plannedHours: 4,
            startedAt: new Date('2025-09-01T07:00:00Z'),
            finishedAt: null,
          },
        ]),
      },
    });
    const result = await service.build(REPORT_NAME.WORKSHOP_LOAD, query(), actor('ALL_STORES'));

    expect(result.rows[0]?.factHours).toBe(0);
    expect(result.rows[0]?.ordersInWork).toBe(1);
  });

  it('очередь считается по заказам, ожидающим назначения', async () => {
    const count = vi.fn(async () => 7);
    const { service } = makeService({ order: { findMany: vi.fn(async () => []), count } });
    const result = await service.build(REPORT_NAME.WORKSHOP_LOAD, query(), actor('ALL_STORES'));

    expect(result.totals.queue).toBe(7);
    const where = count.mock.calls[0]?.[0]?.where;
    expect(where.status.in).toEqual(['QUEUED_FOR_DISPATCH', 'IN_TRANSIT_TO_PRODUCTION']);
  });

  it('в отчёт попадают только активные исполнители', async () => {
    // Уволенный исполнитель не должен искажать загрузку цеха.
    const findMany = vi.fn(async () => []);
    const { service } = makeService({ performer: { findMany } });
    await service.build(REPORT_NAME.WORKSHOP_LOAD, query(), actor('ALL_STORES'));

    expect(findMany.mock.calls[0]?.[0]?.where.isActive).toBe(true);
  });

  it('исполнитель без назначений показывается нулями', async () => {
    // Пропустить его значило бы скрыть свободного ювелира — того, кому и можно
    // отдать работу из очереди.
    const { service } = makeService({
      performer: {
        findMany: vi.fn(async () => [{ id: 'p-1', fullName: 'Ювелиров А.', workshop: null }]),
      },
    });
    const result = await service.build(REPORT_NAME.WORKSHOP_LOAD, query(), actor('ALL_STORES'));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.ordersInWork).toBe(0);
    expect(result.rows[0]?.plannedHours).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Отчёт «Просрочки»
// ---------------------------------------------------------------------------

describe('Отчёт «Просрочки» (задача 5.3)', () => {
  const NOW = new Date();
  const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

  it('просрочка «сейчас» не включает терминальные статусы', async () => {
    /*
     * Выданный заказ с истёкшим сроком — уже не просрочка: он закрыт. Оставить
     * его значило бы показать руководителю работу, которой не существует.
     */
    const findMany = vi.fn(async () => []);
    const { service } = makeService({ order: { findMany, count: vi.fn(async () => 0) } });
    await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.status.notIn).toContain('COMPLETED');
    expect(where.status.notIn).toContain('CANCELLED');
    expect(where.status.notIn).toContain('UNCLAIMED');
    expect(where.dueAt.not).toBeNull();
  });

  it('просрочка за период НЕ исключает выданные заказы', async () => {
    /*
     * Это накопленная статистика точки: заказ, выданный с опозданием, в текущем
     * состоянии не виден, но в оценке работы магазина он остаётся. Исключить его
     * значило бы улучшить статистику задним числом.
     */
    const findMany = vi.fn(async () => []);
    const { service } = makeService({ order: { findMany, count: vi.fn(async () => 0) } });
    await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    const periodWhere = findMany.mock.calls[1]?.[0]?.where;
    expect(periodWhere.status.notIn).not.toContain('COMPLETED');
    expect(periodWhere.status.notIn).toEqual(['DRAFT', 'CANCELLED']);
  });

  it('считает среднюю и максимальную просрочку', async () => {
    const { service } = makeService({
      order: {
        findMany: vi.fn(async (args: { where: { dueAt?: { gte?: Date } } }) =>
          args.where.dueAt?.gte === undefined
            ? [
                {
                  id: 'o-1',
                  orderNo: 'MSK1-1',
                  status: 'IN_PRODUCTION',
                  dueAt: hoursAgo(10),
                  totalAmountMinor: 100000,
                  createdStoreId: STORE_A,
                  createdStore: { name: 'Тверская' },
                  productionManager: null,
                },
                {
                  id: 'o-2',
                  orderNo: 'MSK1-2',
                  status: 'IN_PRODUCTION',
                  dueAt: hoursAgo(30),
                  totalAmountMinor: 200000,
                  createdStoreId: STORE_A,
                  createdStore: { name: 'Тверская' },
                  productionManager: null,
                },
              ]
            : [],
        ),
        count: vi.fn(async () => 0),
      },
    });
    const result = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    const row = result.rows[0];
    expect(row?.overdueNow).toBe(2);
    expect(row?.avgDelayHours).toBeCloseTo(20, 1);
    expect(row?.maxDelayHours).toBeCloseTo(30, 1);
    expect(row?.amountMinor).toBe(300000);
  });

  it('в строке показан худший заказ группы', async () => {
    // Именно он требует вмешательства первым, и его номер нужен для перехода в
    // карточку.
    const { service } = makeService({
      order: {
        findMany: vi.fn(async (args: { where: { dueAt?: { gte?: Date } } }) =>
          args.where.dueAt?.gte === undefined
            ? [
                {
                  id: 'o-1',
                  orderNo: 'MSK1-СВЕЖИЙ',
                  status: 'IN_PRODUCTION',
                  dueAt: hoursAgo(2),
                  totalAmountMinor: 1,
                  createdStoreId: STORE_A,
                  createdStore: { name: 'Тверская' },
                  productionManager: null,
                },
                {
                  id: 'o-2',
                  orderNo: 'MSK1-ЗАВИС',
                  status: 'IN_PRODUCTION',
                  dueAt: hoursAgo(100),
                  totalAmountMinor: 1,
                  createdStoreId: STORE_A,
                  createdStore: { name: 'Тверская' },
                  productionManager: null,
                },
              ]
            : [],
        ),
        count: vi.fn(async () => 0),
      },
    });
    const result = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    expect(result.rows[0]?.maxOverdueOrder).toBe('MSK1-ЗАВИС');
  });

  it('доля просроченных считается по периоду', async () => {
    const { service } = makeService({
      order: {
        findMany: vi.fn(async (args: { where: { dueAt?: { gte?: Date } } }) =>
          args.where.dueAt?.gte === undefined
            ? []
            : [
                {
                  id: 'o-1',
                  dueAt: hoursAgo(10),
                  createdStoreId: STORE_A,
                  status: 'IN_PRODUCTION',
                },
                {
                  id: 'o-2',
                  dueAt: new Date(NOW.getTime() + 100_000_000),
                  createdStoreId: STORE_A,
                  status: 'IN_PRODUCTION',
                },
                { id: 'o-3', dueAt: hoursAgo(50), createdStoreId: STORE_A, status: 'COMPLETED' },
                {
                  id: 'o-4',
                  dueAt: hoursAgo(50),
                  createdStoreId: STORE_A,
                  status: 'IN_PRODUCTION',
                },
              ],
        ),
        count: vi.fn(async () => 0),
      },
    });
    const result = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    // Три из четырёх заказов периода нарушили срок.
    expect(result.totals.overdueInPeriod).toBe(3);
    expect(result.totals.ordersInPeriod).toBe(4);
    expect(result.totals.overdueShare).toBe(0.75);
  });

  it('пустой период: доля просроченных — null, а не ноль', async () => {
    // Деление на ноль заказов дало бы NaN или 0, и «0 % просрочек» выглядело бы
    // как благополучие при полном отсутствии данных.
    const { service } = makeService();
    const result = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    expect(result.totals.overdueShare).toBeNull();
    expect(result.totals.overdueNow).toBe(0);
  });

  it('группы отсортированы по числу просроченных заказов', async () => {
    // Первой идёт точка, где проблем больше: руководитель читает сверху вниз.
    const make = (storeId: string, name: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${storeId}-${index}`,
        orderNo: `N-${storeId}-${index}`,
        status: 'IN_PRODUCTION',
        dueAt: hoursAgo(5),
        totalAmountMinor: 100,
        createdStoreId: storeId,
        createdStore: { name },
        productionManager: null,
      }));
    const { service } = makeService({
      order: {
        findMany: vi.fn(async (args: { where: { dueAt?: { gte?: Date } } }) =>
          args.where.dueAt?.gte === undefined
            ? [...make(STORE_A, 'Малая', 1), ...make(STORE_B, 'Большая', 3)]
            : [],
        ),
        count: vi.fn(async () => 0),
      },
    });
    const result = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    expect(result.rows[0]?.group).toBe('Большая');
    expect(result.rows[1]?.group).toBe('Малая');
  });
});

// ---------------------------------------------------------------------------
// Отчёт «Выручка»
// ---------------------------------------------------------------------------

describe('Отчёт «Выручка» (задача 5.4)', () => {
  const paidAt = new Date('2025-09-15T12:00:00+03:00');

  const payment = (overrides: Record<string, unknown> = {}) => ({
    kind: 'FINAL',
    method: 'CASH',
    amountMinor: 100000,
    paidAt,
    orderId: 'o-1',
    storeId: STORE_A,
    store: { name: 'Тверская' },
    order: { isWarranty: false, createdStoreId: STORE_A },
    ...overrides,
  });

  it('выручка считается по дате ПЛАТЕЖА, а не по дате заказа', async () => {
    /*
     * Главное правило отчёта. Заказ, оформленный в августе и оплаченный в
     * сентябре, — сентябрьская выручка. Иначе отчёт не сойдётся с 1С, где доход
     * признаётся по документу оплаты, и расхождение будут искать в интеграции, а
     * не в отчёте.
     */
    const findMany = vi.fn(async () => []);
    const { service } = makeService({ payment: { findMany } });
    await service.build(REPORT_NAME.REVENUE, query(), actor('ALL_STORES'));

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.paidAt.gte).toBeDefined();
    expect(where.paidAt.lte).toBeDefined();
    // По заказу периода НЕ фильтруем — иначе отчёт считался бы по дате заказа.
    expect(where.order).toBeUndefined();
  });

  it('учитываются только подтверждённые платежи', async () => {
    /*
     * `PENDING` — это намерение, а не деньги; `FAILED` — деньги, которых не
     * будет. Включить их значило бы показать выручку, которой нет.
     */
    const findMany = vi.fn(async () => []);
    const { service } = makeService({ payment: { findMany } });
    await service.build(REPORT_NAME.REVENUE, query(), actor('ALL_STORES'));

    expect(findMany.mock.calls[0]?.[0]?.where.status).toBe('CONFIRMED');
  });

  it('возвраты и сторно вычитаются из чистой выручки', async () => {
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          payment({ amountMinor: 100000 }),
          payment({ kind: 'REFUND', amountMinor: 30000, orderId: 'o-1' }),
          payment({ kind: 'REVERSAL', amountMinor: 20000, orderId: 'o-1' }),
        ]),
      },
    });
    const result = await service.build(REPORT_NAME.REVENUE, query(), actor('ALL_STORES'));

    expect(result.totals.revenueMinor).toBe(100000);
    expect(result.totals.refundsMinor).toBe(50000);
    // Чистая выручка — заработок, а не оборот.
    expect(result.totals.netRevenueMinor).toBe(50000);
  });

  it('средний чек делится на ЧИСЛО ЗАКАЗОВ, а не платежей', async () => {
    /*
     * Заказ может быть оплачен двумя платежами: предоплата и доплата. Деление на
     * число платежей занизило бы чек вдвое, и «средний чек» перестал бы
     * отвечать на вопрос «сколько в среднем приносит заказ».
     */
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          payment({ kind: 'PREPAYMENT', amountMinor: 50000, orderId: 'o-1' }),
          payment({ kind: 'FINAL', amountMinor: 50000, orderId: 'o-1' }),
        ]),
      },
    });
    const result = await service.build(REPORT_NAME.REVENUE, query(), actor('ALL_STORES'));

    expect(result.totals.ordersCount).toBe(1);
    expect(result.totals.paymentsCount).toBe(2);
    expect(result.totals.avgCheckMinor).toBe(100000);
  });

  it('разрез по дню группирует платежи по дате', async () => {
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          payment({ paidAt: new Date('2025-09-15T10:00:00+03:00'), amountMinor: 100 }),
          payment({ paidAt: new Date('2025-09-15T18:00:00+03:00'), amountMinor: 200 }),
          payment({ paidAt: new Date('2025-09-16T10:00:00+03:00'), amountMinor: 400 }),
        ]),
      },
    });
    const result = await service.build(
      REPORT_NAME.REVENUE,
      query({ groupBy: 'day' }),
      actor('ALL_STORES'),
    );

    expect(result.rows.map((row) => row.group)).toEqual(['2025-09-15', '2025-09-16']);
    expect(result.rows[0]?.revenueMinor).toBe(300);
    expect(result.rows[1]?.revenueMinor).toBe(400);
  });

  it('разрез по месяцу сворачивает дни в месяц', async () => {
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          payment({ paidAt: new Date('2025-09-15T10:00:00+03:00') }),
          payment({ paidAt: new Date('2025-10-01T10:00:00+03:00') }),
        ]),
      },
    });
    const result = await service.build(
      REPORT_NAME.REVENUE,
      query({ groupBy: 'month' }),
      actor('ALL_STORES'),
    );

    expect(result.rows.map((row) => row.group)).toEqual(['2025-09', '2025-10']);
  });

  it('неделя начинается с понедельника', async () => {
    /*
     * Отчёт читают по рабочим неделям. Если начинать с воскресенья, границы
     * сдвинутся относительно привычных, и «выручка за неделю» разойдётся с той,
     * что считают вручную.
     */
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          // Воскресенье 14 сентября 2025 и понедельник 15 сентября.
          payment({ paidAt: new Date('2025-09-14T12:00:00+03:00') }),
          payment({ paidAt: new Date('2025-09-15T12:00:00+03:00') }),
        ]),
      },
    });
    const result = await service.build(
      REPORT_NAME.REVENUE,
      query({ groupBy: 'week' }),
      actor('ALL_STORES'),
    );

    // Воскресенье относится к неделе, начавшейся 8 сентября; понедельник — к 15-му.
    expect(result.rows.map((row) => row.group)).toEqual(['2025-09-08', '2025-09-15']);
  });

  it('структура оплат показывается по всем способам, включая нулевые', async () => {
    /*
     * Отсутствующий ключ интерфейс показал бы прочерком, и «нет данных»
     * смешалось бы с «ноль наличных» — а это разные утверждения.
     */
    const { service } = makeService({
      payment: { findMany: vi.fn(async () => [payment({ method: 'CARD', amountMinor: 500 })]) },
    });
    const result = await service.build(REPORT_NAME.REVENUE, query(), actor('ALL_STORES'));

    expect(result.totals.methodCardMinor).toBe(500);
    expect(result.totals.methodCashMinor).toBe(0);
    expect(result.totals.methodBankTransferMinor).toBe(0);
    expect(result.totals.methodOnlineMinor).toBe(0);
  });

  it('пустой период: выручка ноль, средний чек null', async () => {
    const { service } = makeService();
    const result = await service.build(REPORT_NAME.REVENUE, query(), actor('ALL_STORES'));

    expect(result.totals.revenueMinor).toBe(0);
    // Средний чек по нулю заказов — не число: деление дало бы NaN или 0.
    expect(result.totals.avgCheckMinor).toBeNull();
  });

  it('область видимости применяется по магазину ВНЕСЕНИЯ платежа', async () => {
    /*
     * У платежа свой магазин: клиент часто платит не там, где оформил заказ.
     * Фильтр по магазину заказа показал бы приёмщику деньги чужой кассы и скрыл
     * бы свои.
     */
    const findMany = vi.fn(async () => []);
    const { service } = makeService({ payment: { findMany } });
    await service.build(REPORT_NAME.REVENUE, query(), actor('STORE', [STORE_A]));

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.store).toEqual({ id: { in: [STORE_A] } });
  });
});

// ---------------------------------------------------------------------------
// Отчёт «Предоплаты»
// ---------------------------------------------------------------------------

describe('Отчёт «Предоплаты» (задача 5.5)', () => {
  const paidAt = new Date('2025-09-15T12:00:00+03:00');
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

  const prepayment = (overrides: Record<string, unknown> = {}) => ({
    amountMinor: 50000,
    paidAt,
    orderId: 'o-1',
    storeId: STORE_A,
    store: { name: 'Тверская' },
    order: {
      orderNo: 'MSK1-1',
      status: 'IN_PRODUCTION',
      productionStartedAt: new Date('2025-09-16T10:00:00+03:00'),
      totalAmountMinor: 100000,
    },
    ...overrides,
  });

  it('берутся только предоплаты и только подтверждённые', async () => {
    const findMany = vi.fn(async () => []);
    const { service } = makeService({ payment: { findMany } });
    await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.kind).toBe('PREPAYMENT');
    expect(where.status).toBe('CONFIRMED');
  });

  it('разрез по магазину ВНЕСЕНИЯ, а не по магазину заказа', async () => {
    /*
     * Клиент платит не там, где заказал. Отчёт по магазину заказа показал бы
     * деньги не той точке, у которой они в кассе, — и кассир не сошёлся бы с
     * наличностью.
     */
    const findMany = vi.fn(async () => []);
    const { service } = makeService({ payment: { findMany } });
    await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    expect(findMany.mock.calls[0]?.[0]?.where.store).toBeUndefined();
    expect(findMany.mock.calls[0]?.[0]?.select.storeId).toBe(true);
  });

  it('зачтённые и находящиеся в работе разделены', async () => {
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          prepayment({
            amountMinor: 30000,
            order: {
              orderNo: 'A',
              status: 'COMPLETED',
              productionStartedAt: paidAt,
              totalAmountMinor: 1,
            },
          }),
          prepayment({
            amountMinor: 20000,
            order: {
              orderNo: 'B',
              status: 'IN_PRODUCTION',
              productionStartedAt: paidAt,
              totalAmountMinor: 1,
            },
          }),
        ]),
      },
    });
    const result = await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    // Зачтено — деньги отработаны, заказ завершён.
    expect(result.totals.creditedMinor).toBe(30000);
    expect(result.totals.inWorkMinor).toBe(20000);
  });

  it('зависшей считается предоплата без начатых работ дольше 14 дней', async () => {
    /*
     * Особый контроль docs/06 §5: деньги клиента у нас, а работы не начаты.
     * Это потенциальная потеря клиента, и её нужно видеть отдельно от общей
     * суммы предоплат.
     */
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          prepayment({
            amountMinor: 10000,
            paidAt: daysAgo(20),
            order: {
              orderNo: 'ЗАВИС',
              status: 'ACCEPTED',
              productionStartedAt: null,
              totalAmountMinor: 1,
            },
          }),
          prepayment({
            amountMinor: 20000,
            paidAt: daysAgo(20),
            order: {
              orderNo: 'НАЧАТ',
              status: 'IN_PRODUCTION',
              productionStartedAt: daysAgo(19),
              totalAmountMinor: 1,
            },
          }),
          prepayment({
            amountMinor: 30000,
            paidAt: daysAgo(3),
            order: {
              orderNo: 'СВЕЖИЙ',
              status: 'ACCEPTED',
              productionStartedAt: null,
              totalAmountMinor: 1,
            },
          }),
        ]),
      },
    });
    const result = await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    // Только первый: работы не начаты и прошло больше 14 дней.
    expect(result.totals.stuckCount).toBe(1);
    expect(result.totals.stuckMinor).toBe(10000);
    expect(String(result.totals.stuckOrders)).toContain('ЗАВИС');
    expect(String(result.totals.stuckOrders)).not.toContain('НАЧАТ');
  });

  it('заказ в производстве не считается зависшим, даже если платёж старый', async () => {
    // Работы начаты — деньги в деле, и звонить клиенту не о чем.
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          prepayment({
            paidAt: daysAgo(100),
            order: {
              orderNo: 'В РАБОТЕ',
              status: 'IN_PRODUCTION',
              productionStartedAt: daysAgo(99),
              totalAmountMinor: 1,
            },
          }),
        ]),
      },
    });
    const result = await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    expect(result.totals.stuckCount).toBe(0);
  });

  it('средняя предоплата считается по числу платежей', async () => {
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async () => [
          prepayment({ amountMinor: 10000 }),
          prepayment({ amountMinor: 30000, orderId: 'o-2' }),
        ]),
      },
    });
    const result = await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    expect(result.totals.avgPrepaymentMinor).toBe(20000);
  });

  it('возвраты показываются отдельным числом', async () => {
    const findMany = vi.fn(async (args: { where: { kind?: unknown } }) =>
      args.where.kind === 'PREPAYMENT'
        ? [prepayment({ amountMinor: 50000 })]
        : [{ amountMinor: 20000, orderId: 'o-1' }],
    );
    const { service } = makeService({ payment: { findMany } });
    const result = await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    expect(result.totals.refundedMinor).toBe(20000);
  });

  it('пустой период: средняя предоплата null, а не ноль', async () => {
    const { service } = makeService();
    const result = await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    expect(result.totals.prepaidMinor).toBe(0);
    expect(result.totals.avgPrepaymentMinor).toBeNull();
  });

  it('строки разреза отсортированы по сумме внесённого', async () => {
    // Первой идёт точка, где денег больше: руководитель читает сверху вниз.
    const { service } = makeService({
      payment: {
        findMany: vi.fn(async (args: { where: { kind?: unknown } }) =>
          args.where.kind === 'PREPAYMENT'
            ? [
                prepayment({ amountMinor: 1000, storeId: STORE_A, store: { name: 'Малая' } }),
                prepayment({ amountMinor: 9000, storeId: STORE_B, store: { name: 'Большая' } }),
              ]
            : [],
        ),
      },
    });
    const result = await service.build(REPORT_NAME.PREPAYMENTS, query(), actor('ALL_STORES'));

    expect(result.rows[0]?.store).toBe('Большая');
  });
});

// ---------------------------------------------------------------------------
// Общее поведение
// ---------------------------------------------------------------------------

describe('Отчёт «Рекламации» (задача 6.7)', () => {
  /** Рекламация с настраиваемыми полями. */
  function claim(overrides: Record<string, unknown> = {}) {
    return {
      status: 'OPENED',
      reason: 'Разошёлся шов',
      openedAt: new Date('2025-09-15T09:00:00+03:00'),
      dueAt: new Date('2025-09-29T09:00:00+03:00'),
      resolvedAt: null,
      closedAt: null,
      resolution: null,
      order: { orderNo: 'MSK1-2509-000001', isWarranty: false },
      ...overrides,
    };
  }

  it('группирует рекламации по статусу', async () => {
    const { service } = makeService({
      warrantyClaim: {
        findMany: vi.fn(async () => [
          claim({ status: 'OPENED' }),
          claim({ status: 'OPENED' }),
          claim({ status: 'REJECTED', resolvedAt: null }),
        ]),
      },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    const opened = report.rows.find((row) => row.group === 'Открыта');
    expect(opened).toMatchObject({ claimsCount: 2 });
  });

  it('выводит статусы в порядке жизненного цикла, а не по алфавиту', async () => {
    const { service } = makeService({
      warrantyClaim: {
        findMany: vi.fn(async () => [claim({ status: 'CLOSED' }), claim({ status: 'OPENED' })]),
      },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    // Алфавит поставил бы «Закрыта» раньше «Открыта», разорвав жизненный цикл.
    expect(report.rows.map((row) => row.group)).toEqual(['Открыта', 'Закрыта']);
  });

  it('считает просрочку на момент построения отчёта', async () => {
    const { service } = makeService({
      warrantyClaim: {
        findMany: vi.fn(async () => [
          // Срок истёк: рекламация всё ещё открыта.
          claim({ status: 'OPENED', dueAt: new Date('2025-09-20T09:00:00+03:00') }),
          // Срок в будущем.
          claim({ status: 'IN_REVIEW', dueAt: new Date('2099-01-01T09:00:00+03:00') }),
        ]),
      },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    expect(report.totals.overdueCount).toBe(1);
  });

  it('не считает просроченной закрытую рекламацию', async () => {
    const { service } = makeService({
      warrantyClaim: {
        findMany: vi.fn(async () => [
          claim({ status: 'CLOSED', dueAt: new Date('2020-01-01T09:00:00+03:00') }),
        ]),
      },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    // Срок относится к рассмотрению; закрытая рекламация — история.
    expect(report.totals.overdueCount).toBe(0);
  });

  it('разделяет исходы: ремонт, возврат, отказ', async () => {
    const { service } = makeService({
      warrantyClaim: {
        findMany: vi.fn(async () => [
          claim({
            status: 'RESOLVED_REPAIR',
            resolution: 'RESOLVED_REPAIR',
            resolvedAt: new Date('2025-09-20T09:00:00+03:00'),
          }),
          claim({
            status: 'RESOLVED_REFUND',
            resolution: 'RESOLVED_REFUND',
            resolvedAt: new Date('2025-09-21T09:00:00+03:00'),
          }),
          claim({ status: 'REJECTED' }),
        ]),
      },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    expect(report.totals).toMatchObject({
      resolvedRepairCount: 1,
      resolvedRefundCount: 1,
      rejectedCount: 1,
    });
  });

  it('сохраняет исход закрытой рекламации (дефект с живого сервера)', async () => {
    const { service } = makeService({
      warrantyClaim: {
        findMany: vi.fn(async () => [
          /*
           * Рекламация ЗАКРЫТА, но исход — возврат денег. Подсчёт по текущему
           * статусу потерял бы его: `CLOSED` не говорит, чем дело кончилось, и
           * отчёт показал бы ноль возвратов. Именно этот дефект и был найден на
           * живом сервере.
           */
          claim({
            status: 'CLOSED',
            resolution: 'RESOLVED_REFUND',
            resolvedAt: new Date('2025-09-21T09:00:00+03:00'),
            closedAt: new Date('2025-09-22T09:00:00+03:00'),
          }),
        ]),
      },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    expect(report.totals.resolvedRefundCount).toBe(1);
    expect(report.totals.resolvedRepairCount).toBe(0);
  });

  it('считает открытыми только незавершённые рекламации', async () => {
    const { service } = makeService({
      warrantyClaim: {
        findMany: vi.fn(async () => [
          claim({ status: 'OPENED' }),
          claim({ status: 'IN_REVIEW' }),
          claim({ status: 'CLOSED' }),
          claim({ status: 'REJECTED' }),
        ]),
      },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    // Закрытая и отклонённая — завершённые: работы по ним не осталось.
    expect(report.totals.openCount).toBe(2);
  });

  it('не выводит строку статуса, под который не было рекламаций', async () => {
    const { service } = makeService({
      warrantyClaim: { findMany: vi.fn(async () => [claim({ status: 'OPENED' })]) },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    // Пустые строки сделали бы отчёт длинным и нечитаемым.
    expect(report.rows).toHaveLength(1);
  });

  it('не считает средний разбор, если решений не было', async () => {
    const { service } = makeService({
      warrantyClaim: { findMany: vi.fn(async () => [claim({ status: 'OPENED' })]) },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    expect(report.rows[0]!.averageReviewDays).toBeNull();
  });

  it('считает средний разбор в РАБОЧИХ днях', async () => {
    const { service } = makeService({
      warrantyClaim: {
        findMany: vi.fn(async () => [
          // 15.09 (пн) → 20.09 (сб): рабочие вт, ср, чт, пт — 4 рабочих дня, а не
          // 5 календарных.
          claim({
            status: 'RESOLVED_REPAIR',
            resolution: 'RESOLVED_REPAIR',
            resolvedAt: new Date('2025-09-20T09:00:00+03:00'),
          }),
        ]),
      },
    });

    const report = await service.build(REPORT_NAME.CLAIMS, query(), actor('ALL_STORES'));

    expect(report.rows[0]!.averageReviewDays).toBe(4);
  });

  it('требует операционное право, а не денежное', async () => {
    // Рекламации — отчёт о процессе, а не о выручке: права кассира не хватает.
    expect(permissionForReport(REPORT_NAME.CLAIMS)).toBe('report:operational');
  });
});

describe('Общее поведение отчётов (задача 5.1)', () => {
  it('неизвестное имя отчёта даёт ошибку со списком поддерживаемых', async () => {
    const { service } = makeService();
    await expect(service.build('не-существует', query(), actor('ALL_STORES'))).rejects.toThrow(
      /не поддерживается/,
    );
  });

  it('ответ содержит метаданные о выборке', async () => {
    const { service } = makeService();
    const result = await service.build(REPORT_NAME.STAGE_DURATIONS, query(), actor('ALL_STORES'));

    expect(result.meta.from).toBe('2025-09-01');
    expect(result.meta.to).toBe('2025-09-30');
    expect(result.meta.cached).toBe(false);
    expect(typeof result.meta.generatedAt).toBe('string');
  });

  it('колонки описаны с типами для интерфейса и выгрузки', async () => {
    // Тип колонки говорит интерфейсу, как показать значение: 62.4 — это часы, а
    // 0.87 — доля. Без него пришлось бы форматировать на сервере, и в Excel
    // числа стали бы текстом.
    const { service } = makeService();
    const result = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    const amount = result.columns.find((column) => column.key === 'amountMinor');
    expect(amount?.type).toBe('money');
    const share = result.columns.find((column) => column.key === 'overdueShare');
    expect(share).toBeUndefined();
    expect(result.totals).toHaveProperty('overdueShare');
  });

  it('число строк ограничено параметром limit', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      stage: `STAGE_${index}`,
      durationMinutes: 60,
      order: { createdStoreId: STORE_A },
    }));
    const { service } = makeService({
      orderStatusHistory: { findMany: vi.fn(async () => rows) },
    });
    const result = await service.build(
      REPORT_NAME.STAGE_DURATIONS,
      query({ limit: 3 }),
      actor('ALL_STORES'),
    );

    expect(result.rows).toHaveLength(3);
  });
});

describe('Кэширование отчётов в сервисе (задача 5.7)', () => {
  it('второй запрос с теми же параметрами не считает отчёт заново', async () => {
    /*
     * Смысл кэша: руководитель открывает дашборд несколько раз в день и должен
     * получать мгновенный ответ, а база — не пересчитывать одно и то же.
     */
    const { service, client } = makeService();
    await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));
    const first = client.order.findMany.mock.calls.length;

    await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    expect(client.order.findMany.mock.calls.length).toBe(first);
  });

  it('повторный ответ помечен как взятый из кэша', async () => {
    // Клиент должен отличать свежий расчёт от закэшированного, чтобы понимать
    // возраст данных.
    const { service } = makeService();
    const fresh = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));
    const second = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    expect(fresh.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
  });

  it('время построения отчёта не подменяется временем выдачи', async () => {
    /*
     * `generatedAt` — момент РАСЧЁТА. Если бы при выдаче из кэша он обновлялся,
     * по нему нельзя было бы понять, насколько данные свежи, и «отчёт построен
     * только что» вводило бы в заблуждение.
     *
     * Время сдвигается принудительно: два вызова подряд укладываются в одну
     * миллисекунду, и без сдвига подмена `generatedAt` на текущий момент
     * выглядела бы как совпадение — тест проходил бы при снятой защите.
     */
    const { service } = makeService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-30T12:00:00.000Z'));
    const fresh = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    /*
     * Сдвиг — ДВЕ минуты, а не больше: у «просрочек» TTL пять минут, и при
     * большем сдвиге запись просто истечёт, запрос пересчитается, и тест
     * проверял бы не кэш, а истечение срока.
     */
    vi.setSystemTime(new Date('2025-09-30T12:02:00.000Z'));
    const second = await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));
    vi.useRealTimers();

    expect(fresh.meta.generatedAt).toBe('2025-09-30T12:00:00.000Z');
    expect(second.meta.generatedAt).toBe('2025-09-30T12:00:00.000Z');
    expect(second.meta.cached).toBe(true);
  });

  it('разные роли НЕ получают отчёт друг друга из кэша', async () => {
    /*
     * Главная проверка безопасности кэша. Приёмщик одного магазина не должен
     * получить из кэша отчёт, посчитанный руководителем для всей сети: чужие
     * суммы, чужие сроки, чужая выручка. Утечка не видна на экране — числа
     * правдоподобны.
     */
    const { service, client } = makeService();
    const receiver = actor('STORE', ['store-1']);

    await service.build(REPORT_NAME.OVERDUE, query(), receiver);
    const callsAfterFirst = client.order.findMany.mock.calls.length;

    // Руководитель видит всю сеть — это ДРУГОЙ набор магазинов, другой ключ.
    await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    expect(client.order.findMany.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('сброс кэша заставляет пересчитать отчёт', async () => {
    // Событие изменения данных обязано отражаться на следующем же запросе:
    // иначе руководитель не увидит только что переведённый заказ.
    const { service, client } = makeService();
    await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));
    const callsAfterFirst = client.order.findMany.mock.calls.length;

    service.invalidateCache();
    await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));

    expect(client.order.findMany.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('разные отчёты не делят одну запись кэша', async () => {
    // «Выручка» и «просрочки» — разные данные: общая запись отдала бы числа
    // одного отчёта под именем другого.
    const { service, client } = makeService();
    await service.build(REPORT_NAME.OVERDUE, query(), actor('ALL_STORES'));
    const callsAfterFirst = client.order.findMany.mock.calls.length;

    await service.build(REPORT_NAME.REVENUE, query(), actor('ALL_STORES'));

    expect(client.payment.findMany.mock.calls.length).toBeGreaterThan(0);
    expect(client.order.findMany.mock.calls.length).toBe(callsAfterFirst);
  });
});
