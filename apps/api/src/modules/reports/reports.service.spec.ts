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
import { REPORT_NAME } from '@app/shared';
import {
  RESTRICTED_TO_NOTHING,
  ReportsService,
  parseReportPeriod,
  scopedStoreIds,
  toDateKey,
} from './reports.service';
import { parseReportQuery } from './reports.controller';

const STORE_A = 'cmu5p70yu0002bm7pzqlcawsw';
const STORE_B = 'cmu5p70yu0003bm7pzqlcawsw';
const WORKSHOP = 'cmu5p70yu0004bm7pzqlcawsw';

/** Роль приёмщика: видит один магазин. */
const RECEIVER = { scope: 'STORE' as const, storeIds: [STORE_A] };
/** Руководитель: видит всю сеть. */
const MANAGER = { scope: 'ALL_STORES' as const, storeIds: [] as string[] };
/** Роль без магазинов: доступ есть, данных нет. */
const ORPHAN = { scope: 'STORE' as const, storeIds: [] as string[] };

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
  return { id: 'u-1', scope, storeIds } as never;
}

/** Двойник Prisma с настраиваемыми выборками. */
function makeService(overrides: Record<string, unknown> = {}) {
  const client = {
    orderStatusHistory: { findMany: vi.fn(async () => []) },
    order: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    performer: { findMany: vi.fn(async () => []) },
    orderAssignment: { findMany: vi.fn(async () => []) },
    stageNorm: { findMany: vi.fn(async () => []) },
    store: { findMany: vi.fn(async () => [] as { id: string; name: string }[]) },
    workingCalendar: { findMany: vi.fn(async () => []) },
    ...overrides,
  };
  const workflow = {
    loadCalendar: vi.fn(async () => ({ overrides: new Map(), defaultHours: 9 })),
  };
  const service = new ReportsService(client as never, workflow as never);
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
// Общее поведение
// ---------------------------------------------------------------------------

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
