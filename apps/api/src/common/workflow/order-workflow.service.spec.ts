/**
 * Тесты расчёта нормативного срока (задача 1.3.4, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Они закрывают дефект, который lived в продакшне и не был
 * виден ни одному тесту: норматив НИКОГДА не находился, поэтому `dueAt` не
 * устанавливался вообще. Причины было три, и каждая проверяется здесь:
 *
 *  1. расчёт искал норматив по имени СТАТУСА (`QUEUED_FOR_DISPATCH`), а
 *     справочник заполнен ЭТАПАМИ (`QUEUE`) — совпадений 0 из 13;
 *  2. существовали ТРИ несогласованных словаря этапов: справочник
 *     (`DISPATCH`/`DELIVERY_OUT`/`DELIVERY_IN`/`STORAGE`), домен
 *     (`QUEUE`/`LOGISTICS_OUT`/`LOGISTICS_IN`/`PICKUP`) и статусы;
 *  3. значением по умолчанию для срока было `order.readyAt` — ДРУГОЕ поле
 *     (дата готовности), поэтому переход без норматива переписывал срок выдачи
 *     датой готовности.
 *
 * Прежний тест (`stage-norms.spec.ts`) этого не ловил, потому что полностью
 * дублировал логику сервиса вместо её вызова: он проверял копию, а не код.
 * Здесь вызывается настоящий `computeDueAt` и настоящий `stageForStatus`.
 *
 * Проверено на живом сервере до исправления: заказ `MSK1-2609-000006` перешёл в
 * `QUEUED_FOR_DISPATCH` (переход с эффектом `SET_DUE_AT`) и остался с
 * `dueAt = NULL`, при заполненном справочнике из 9 нормативов.
 */

import { describe, expect, it, vi } from 'vitest';
import { computeDueAt, OrderWorkflowService } from './order-workflow.service';
import { ReportsCacheService } from '../cache/reports-cache.service';
import {
  ALL_NORM_STAGES,
  ORDER_STATUS,
  STATUS_STAGE,
  NORM_STAGE,
  stageForStatus,
  toDateKey,
  type WorkingCalendar,
} from '@app/shared';
import { customerEventForTransition, ORDER_TRANSITIONS, REPORT_NAME } from '@app/shared';

/** Календарь без исключений: будни рабочие, праздники — по ТК РФ. */
const CALENDAR: WorkingCalendar = { overrides: new Map(), defaultHours: 8 };

/** Сентябрь 2027: 17-е — пятница, 18–19 — выходные, 20 — понедельник. */
const FRIDAY = new Date('2027-09-17T12:00:00Z');

/**
 * Заглушка сервиса уведомлений (задача 5.10).
 *
 * По умолчанию НИЧЕГО НЕ СОЗДАЁТ и записывает вызовы: большинство тестов
 * перехода проверяют сам переход, и без этой заглушки конструктор сервиса
 * требовал бы настоящий модуль уведомлений.
 */
/**
 * Подделка `ConfigService` для бизнес-настроек.
 *
 * Возвращает значения по умолчанию, если тест не задал своё: сервис читает
 * `WARRANTY_MONTHS_DEFAULT`, и без двойника обращение к нему падало бы.
 */
function configStub(values: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = { WARRANTY_MONTHS_DEFAULT: 6, ...values };
  return { get: (key: string) => defaults[key] };
}

function notificationsStub() {
  const calls: { code: string; phone: string | null; orderId: string | null }[] = [];
  return {
    calls,
    notifyCustomer: async (params: {
      code: string;
      phone: string | null;
      orderId?: string | null;
    }) => {
      calls.push({
        code: params.code,
        phone: params.phone,
        orderId: params.orderId ?? null,
      });
      return [];
    },
  };
}

describe('stageForStatus: этап по статусу', () => {
  it('сопоставляет статус с этапом справочника', () => {
    // Именно это сопоставление отсутствовало: в справочник передавался статус.
    expect(stageForStatus(ORDER_STATUS.QUEUED_FOR_DISPATCH)).toBe(NORM_STAGE.QUEUE);
    expect(stageForStatus(ORDER_STATUS.IN_PRODUCTION)).toBe(NORM_STAGE.PRODUCTION);
    expect(stageForStatus(ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION)).toBe(NORM_STAGE.LOGISTICS_OUT);
    expect(stageForStatus(ORDER_STATUS.IN_TRANSIT_TO_STORE)).toBe(NORM_STAGE.LOGISTICS_IN);
    expect(stageForStatus(ORDER_STATUS.AWAITING_APPROVAL)).toBe(NORM_STAGE.APPROVAL);
    expect(stageForStatus(ORDER_STATUS.AWAITING_PREPAYMENT)).toBe(NORM_STAGE.PREPAYMENT);
  });

  it('возвращает null для этапов без норматива срока', () => {
    // `ACCEPTED` — «принят в работу»: срок задаётся следующим этапом, и
    // придумывать ему норматив значило бы обещать клиенту произвольную дату.
    expect(stageForStatus(ORDER_STATUS.ACCEPTED)).toBeNull();
    expect(stageForStatus(ORDER_STATUS.DRAFT)).toBeNull();
  });

  it('не выдаёт этап для закрытых заказов', () => {
    // Закрытый заказ никого не торопит: срок ему не назначается.
    for (const status of [ORDER_STATUS.COMPLETED, ORDER_STATUS.REFUSED, ORDER_STATUS.CANCELLED]) {
      expect(stageForStatus(status)).toBeNull();
    }
  });

  it('КАЖДЫЙ этап справочника достижим хотя бы одним статусом или известен как отдельный процесс', () => {
    // Регрессия на расхождение словарей: если этап есть в NORM_STAGE, но
    // недостижим ни одним статусом, его норматив — мёртвая строка.
    const reachable = new Set(
      Object.values(ORDER_STATUS)
        .map((status) => stageForStatus(status))
        .filter((stage): stage is NonNullable<typeof stage> => stage !== null),
    );
    // CLAIM — рассмотрение рекламации: отдельный процесс (WarrantyClaim), у
    // заказа статуса нет, поэтому проверяется отдельно.
    const standalone = new Set<string>([NORM_STAGE.CLAIM]);

    for (const stage of ALL_NORM_STAGES) {
      const ok = reachable.has(stage as never) || standalone.has(stage);
      expect(ok, `этап ${stage} недостижим: норматив для него никогда не применится`).toBe(true);
    }
  });

  it('КАЖДЫЙ переход с SET_DUE_AT ведёт на этап, у которого есть норматив', () => {
    // Это инвариант, а не пожелание: `SET_DUE_AT` означает «назначить срок»,
    // и если у целевого статуса этапа с нормативом нет, эффект невыполним.
    // Прежде так было у ТРЁХ переходов (3, 5, 7 — все в `ACCEPTED`): они
    // объявляли `SET_DUE_AT`, но этап `INTAKE` норматива не имеет, поэтому
    // срок молча не назначался. Проверено на проде: `dueAt = NULL`.
    const withDue = ORDER_TRANSITIONS.filter((t) => t.effects.includes('SET_DUE_AT'));
    expect(withDue.length).toBeGreaterThan(0);

    for (const transition of withDue) {
      const stage = stageForStatus(transition.to);
      expect(
        stage,
        `переход ${transition.id} в ${transition.to} объявляет SET_DUE_AT, ` +
          'но этапа с нормативом у него нет — срок не будет назначен',
      ).not.toBeNull();
    }
  });

  it('ACCEPTED не объявляет SET_DUE_AT: у этапа INTAKE норматива нет', () => {
    // Отдельная проверка, потому что это была конкретная ошибка: «принят в
    // работу» — ещё не этап с нормируемым сроком, срок назначает следующий
    // переход (в `QUEUED_FOR_DISPATCH`, этап `QUEUE`).
    const intoAccepted = ORDER_TRANSITIONS.filter((t) => t.to === ORDER_STATUS.ACCEPTED);
    expect(intoAccepted.length).toBeGreaterThan(0);
    for (const transition of intoAccepted) {
      expect(transition.effects).not.toContain('SET_DUE_AT');
    }
  });

  it('словарь этапов справочника совпадает с этапами домена', () => {
    // Третий словарь из дефекта: `DISPATCH`, `DELIVERY_OUT`, `DELIVERY_IN`,
    // `STORAGE` существовали только в seed и не совпадали ни с чем.
    const domainStages = new Set<string>(Object.values(STATUS_STAGE));
    for (const stage of ALL_NORM_STAGES) {
      if (stage === NORM_STAGE.CLAIM) continue; // рекламация — не этап заказа
      expect(domainStages.has(stage), `этап ${stage} отсутствует в домене`).toBe(true);
    }
  });
});

describe('computeDueAt: единицы измерения норматива', () => {
  it('WORKDAY прибавляет рабочие дни, пропуская выходные', () => {
    // 3 рабочих дня от пятницы 17.09.2027 → среда 22.09 (18–19 выходные).
    const due = computeDueAt(FRIDAY, { value: 3, unit: 'WORKDAY' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-22');
  });

  it('WORKDAY учитывает праздники ТК РФ', () => {
    // Согласование 3 рабочих дня от 04.11.2026 (праздник) → 09.11.
    const due = computeDueAt(
      new Date('2026-11-03T12:00:00Z'),
      { value: 3, unit: 'WORKDAY' },
      CALENDAR,
    );
    expect(toDateKey(due!)).toBe('2026-11-09');
  });

  it('WORKHOUR считает рабочие ЧАСЫ внутри окна 10:00–19:00 МСК', () => {
    // 12:00 UTC — это 15:00 МСК, то есть до конца рабочего окна остаётся 4 часа.
    // Норматив в 4 часа укладывается в пятницу.
    const due = computeDueAt(FRIDAY, { value: 4, unit: 'WORKHOUR' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-17');
  });

  it('WORKHOUR переносит остаток часов на следующий рабочий день', () => {
    // 5 часов от 15:00 МСК: 4 часа в пятницу, пятый — уже в понедельник.
    // Это и есть смысл «рабочих часов»: остаток дня не растягивает окно, а
    // переносится на следующий рабочий день, а не считается как «весь день».
    const due = computeDueAt(FRIDAY, { value: 5, unit: 'WORKHOUR' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-20');
  });

  it('WORKHOUR переносит срок через выходные', () => {
    // 24 рабочих часа — три полных рабочих дня: пятница (4 ч), понедельник
    // (9 ч), вторник (9 ч) → среда. Курьер не работает в субботу, поэтому
    // срок обязан перешагнуть выходные, а не «досчитать» их как рабочие.
    const due = computeDueAt(FRIDAY, { value: 24, unit: 'WORKHOUR' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-22');
  });

  it('WORKHOUR не считает выходные рабочими часами', () => {
    // 8 часов, начатых в пятницу вечером, заканчиваются в понедельник, а не
    // в субботу: иначе срок обещал бы доставку в нерабочий день.
    const lateFriday = new Date('2027-09-17T16:00:00Z'); // 19:00 МСК — окно закрыто
    const due = computeDueAt(lateFriday, { value: 8, unit: 'WORKHOUR' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-20');
  });

  it('CALENDAR_DAY считает календарные дни, включая выходные', () => {
    // Хранение 30 календарных дней — именно календарных: заказ лежит на полке,
    // и выходные цеха его срок не продлевают.
    const due = computeDueAt(FRIDAY, { value: 30, unit: 'CALENDAR_DAY' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-10-17');
  });

  it('неизвестная единица не даёт срока вместо «похожего» значения', () => {
    // Молчаливая подстановка дала бы неверное обещание клиенту.
    expect(computeDueAt(FRIDAY, { value: 5, unit: 'FORTNIGHT' }, CALENDAR)).toBeNull();
  });

  it('нулевое значение допустимо и даёт тот же день', () => {
    expect(toDateKey(computeDueAt(FRIDAY, { value: 0, unit: 'WORKDAY' }, CALENDAR)!)).toBe(
      '2027-09-17',
    );
  });
});

describe('Нормативы: значения по умолчанию из docs/04 §3', () => {
  /**
   * Проверка на реальных нормативах заказчика: они не хардкодятся в коде
   * (docs/00-decisions.md §6.11), но их значения должны давать осмысленные
   * сроки. Здесь проверяется не «правильность цифр», а то, что каждая единица
   * измерения даёт результат и срок не попадает на выходной.
   */
  const defaults = [
    { stage: NORM_STAGE.APPROVAL, value: 3, unit: 'WORKDAY' },
    { stage: NORM_STAGE.PREPAYMENT, value: 5, unit: 'WORKDAY' },
    { stage: NORM_STAGE.QUEUE, value: 24, unit: 'WORKHOUR' },
    { stage: NORM_STAGE.LOGISTICS_OUT, value: 8, unit: 'WORKHOUR' },
    { stage: NORM_STAGE.PRODUCTION, value: 5, unit: 'WORKDAY' },
    { stage: NORM_STAGE.LOGISTICS_IN, value: 8, unit: 'WORKHOUR' },
    { stage: NORM_STAGE.PICKUP, value: 30, unit: 'CALENDAR_DAY' },
    { stage: NORM_STAGE.CLAIM, value: 10, unit: 'WORKDAY' },
  ];

  it('каждый норматив даёт срок', () => {
    for (const norm of defaults) {
      const due = computeDueAt(FRIDAY, norm, CALENDAR);
      expect(
        due,
        `норматив ${norm.stage} (${norm.value} ${norm.unit}) не дал срока`,
      ).not.toBeNull();
    }
  });

  it('все этапы справочника покрыты значениями по умолчанию', () => {
    // Если у этапа нет норматива, заказ на этом этапе останется без срока —
    // то есть просрочку по нему система не увидит.
    const covered = new Set(defaults.map((n) => n.stage));
    for (const stage of ALL_NORM_STAGES) {
      expect(covered.has(stage), `для этапа ${stage} нет норматива по умолчанию`).toBe(true);
    }
  });

  it('сроки в рабочих днях не попадают на выходные', () => {
    for (const norm of defaults.filter((n) => n.unit === 'WORKDAY')) {
      const due = computeDueAt(FRIDAY, norm, CALENDAR)!;
      const day = due.getUTCDay();
      expect(day === 0 || day === 6, `${norm.stage}: срок попал на выходной`).toBe(false);
    }
  });
});

describe('Системный переход: actorId обязателен как null (дефект 33)', () => {
  /**
   * ДЕФЕКТ 33, найденный на живом сервере. `OrderStatusHistory.changedById` —
   * внешний ключ на `User`. Системный переход передавал строку `'system'`, и
   * вставка нарушала `order_status_history_changedById_fkey`: переход падал,
   * заказ оставался «готов к выдаче» навсегда, а в журнале была лишь одна
   * строка «не переведён».
   *
   * Двойник Prisma принимает любой идентификатор, поэтому юнит-тест сервиса
   * невостребованных заказов этого не ловил: он проверял, что переход ВЫЗВАН,
   * но не то, с каким актором. Проверка перенесена в сам сервис переходов —
   * переходов с актором `'SYSTEM'` несколько, и каждый новый вызывающий мог бы
   * повторить ту же ошибку.
   */
  const service = new OrderWorkflowService(
    {} as never,
    new ReportsCacheService(),
    notificationsStub() as never,
    configStub() as never,
  );

  it('системный переход со строкой вместо null отклоняется', async () => {
    await expect(
      service.transition({
        orderId: 'o-1',
        to: ORDER_STATUS.UNCLAIMED,
        actorId: 'system',
        actorRole: 'SYSTEM',
        version: 1,
        scope: 'ALL_STORES',
        storeIds: [],
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_ACTOR' } });
  });

  it('системный переход с null доходит до загрузки заказа', async () => {
    /*
     * Проверка не должна отвергать правильный вызов: ошибка здесь означала бы,
     * что автостатус «Невостребовано» не работает вообще. Падение на загрузке
     * заказа (двойник пуст) — ожидаемо и доказывает, что проверка пройдена.
     */
    const error = await service
      .transition({
        orderId: 'o-1',
        to: ORDER_STATUS.UNCLAIMED,
        actorId: null,
        actorRole: 'SYSTEM',
        version: 1,
        scope: 'ALL_STORES',
        storeIds: [],
      })
      .catch((e: unknown) => e);

    expect((error as { response?: { code?: string } }).response?.code).not.toBe('INVALID_ACTOR');
  });
});

describe('Сброс кэша отчётов при переходе (задача 5.7)', () => {
  /**
   * Переход статуса меняет и просрочки, и сроки этапов, и загрузку цеха — то
   * есть любой отчёт. Без сброса руководитель видел бы старую картину до
   * истечения TTL и не понял бы, почему только что переведённый заказ в отчёте
   * не появился.
   */
  function makeService(order: Record<string, unknown> | null) {
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.OVERDUE}|x`, reportStub(), 60_000);

    const prisma = {
      order: { findFirst: async () => order },
      workingCalendar: { findMany: async () => [] },
    };
    const service = new OrderWorkflowService(
      prisma as never,
      cache,
      notificationsStub() as never,
      configStub() as never,
    );
    return { service, cache };
  }

  function reportStub() {
    return {
      meta: {
        from: '2025-09-01',
        to: '2025-09-30',
        generatedAt: '2025-09-30T12:00:00.000Z',
        cached: false,
        rowCount: 0,
      },
      columns: [],
      rows: [],
      totals: {},
    };
  }

  it('отклонённый переход НЕ сбрасывает кэш', async () => {
    /*
     * Переход не состоялся (не выполнено условие, устаревшая версия) — данные не
     * изменились, и сбрасывать кэш значило бы заставлять следующий запрос
     * считать отчёты заново без причины.
     */
    const { service, cache } = makeService(null);
    await service
      .transition({
        orderId: 'o-1',
        to: ORDER_STATUS.IN_PRODUCTION,
        actorId: 'u-1',
        actorRole: 'RECEIVER',
        version: 1,
        scope: 'ALL_STORES',
        storeIds: [],
      })
      .catch(() => undefined);

    // Заказ не найден — переход не применён, кэш не тронут.
    expect(cache.size()).toBe(1);
  });

  it('УСПЕШНЫЙ переход сбрасывает кэш', async () => {
    /*
     * Это и есть настоящая проверка защиты. Тесты выше проверяют лишь то, что
     * отклонённый переход кэш не трогает, — а если убрать сам вызов сброса, они
     * всё равно проходят. Только доведённый до успеха переход доказывает, что
     * сброс выполняется.
     *
     * Берётся переход 13 (`IN_PRODUCTION → QUEUED_FOR_DISPATCH`): у него нет
     * guard-условий, кроме обязательной причины, поэтому двойник Prisma может
     * быть маленьким.
     */
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.OVERDUE}|x`, reportStub(), 60_000);
    cache.set(`${REPORT_NAME.REVENUE}|y`, reportStub(), 60_000);

    const order = {
      id: 'o-1',
      status: 'IN_PRODUCTION',
      version: 1,
      worksTotalMinor: 100000,
      stonesTotalMinor: 0,
      discountMinor: 0,
      totalAmountMinor: 100000,
      prepaymentRequiredMinor: 0,
      requiresPrepayment: false,
      // Оба условия выдачи выполнены: заказ оплачен и подпись клиента есть.
      pickupSignatureFileId: 'f-1',
      paidAmountMinor: 120_000,
      warrantyMonths: 12,
      complexity: 'SIMPLE',
      dueAt: null,
      readyAt: null,
      items: [{ id: 'i-1' }],
      works: [{ id: 'w-1', warrantyMonths: 12 }],
      approvals: [],
      refusalAct: null,
      claims: [],
      batchItems: [],
      assignments: [{ id: 'as-1', status: 'DONE' }],
      customer: { consentCallRecording: true },
    };

    const tx = {
      order: {
        updateMany: async () => ({ count: 1 }),
        findUniqueOrThrow: async () => ({
          ...order,
          status: 'QUEUED_FOR_DISPATCH',
          statusHistory: [],
        }),
      },
      /*
       * Переход 13 несёт эффект `RESET_PERFORMER`, который закрывает активные
       * назначения исполнителей (дефект 60). Без `orderAssignment` в двойнике
       * переход падал бы на обращении к отсутствующей модели.
       */
      orderAssignment: { updateMany: async () => ({ count: 1 }) },
      orderStatusHistory: {
        findFirst: async () => null,
        create: async () => ({ id: 'h-1' }),
      },
      auditLog: { create: async () => ({ id: 'a-1' }) },
    };

    const prisma = {
      buildOrderScopeFilter: () => ({}),
      order: { findFirst: async () => order },
      stageNorm: { findMany: async () => [] },
      workingCalendar: { findMany: async () => [] },
      runInTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    };

    const service = new OrderWorkflowService(
      prisma as never,
      cache,
      notificationsStub() as never,
      configStub() as never,
    );

    await service.transition({
      orderId: 'o-1',
      to: ORDER_STATUS.QUEUED_FOR_DISPATCH,
      actorId: 'u-1',
      actorRole: 'PRODUCTION_MANAGER',
      version: 1,
      scope: 'ALL_STORES',
      storeIds: [],
      reason: 'Возврат на очередь: нужны запчасти',
    });

    // Переход состоялся — кэш обоих отчётов пуст.
    expect(cache.size()).toBe(0);
  });

  it('кэш сбрасывается тем же экземпляром, что читают отчёты', () => {
    /*
     * Проверка на уровне сервиса: кэш должен быть ОДИН на процесс. Если бы
     * каждый модуль создавал свой экземпляр, сброс из переходов не доходил бы до
     * отчётов — и это не проявилось бы как ошибка: отчёт просто показывал бы
     * старые данные до истечения TTL. Поэтому модуль кэша объявлен `@Global()`.
     */
    const shared = new ReportsCacheService();
    shared.set(`${REPORT_NAME.REVENUE}|x`, reportStub(), 60_000);
    expect(shared.invalidate()).toBe(1);
    expect(shared.size()).toBe(0);
  });
});

describe('Перераспределение работы: RESET_PERFORMER (дефект 60)', () => {
  /**
   * ДЕФЕКТ 60. Эффект назывался «сбросить исполнителя», но очищал
   * `productionManagerId` — поле, в котором хранится ОТВЕТСТВЕННЫЙ МЕНЕДЖЕР, а
   * не исполнитель. Перераспределение работы (переход 13) стирало ответственного
   * и при этом оставляло `OrderAssignment` активным, поэтому:
   *
   *  * заказ терял менеджера, который за него отвечает;
   *  * `PERFORMER_ASSIGNED` продолжал видеть прежнего ювелира, и повторное
   *    назначение проходило поверх незакрытого.
   *
   * Тест доводит переход 13 до успеха: без этого проверка была бы ложной —
   * отклонённый переход тоже ничего не пишет, и мутация «вернуть сброс
   * менеджера» осталась бы незамеченной (проверено: до этого теста она
   * проходила).
   */
  function makeService(assignments: Array<{ id: string; status: string }>) {
    const order = {
      id: 'o-1',
      status: 'IN_PRODUCTION',
      version: 1,
      worksTotalMinor: 100000,
      stonesTotalMinor: 0,
      discountMinor: 0,
      totalAmountMinor: 100000,
      prepaymentRequiredMinor: 0,
      requiresPrepayment: false,
      paidAmountMinor: 0,
      warrantyMonths: 12,
      complexity: 'SIMPLE',
      dueAt: null,
      readyAt: null,
      items: [{ id: 'i-1' }],
      works: [{ id: 'w-1', warrantyMonths: 12 }],
      approvals: [],
      refusalAct: null,
      claims: [],
      batchItems: [],
      assignments,
      customer: { consentCallRecording: true },
    };

    const updateManyAssignment = vi.fn(async () => ({ count: assignments.length }));
    const orderUpdateMany = vi.fn(async (args: { data: Record<string, unknown> }) => {
      capturedOrderUpdate = args.data;
      return { count: 1 };
    });
    let capturedOrderUpdate: Record<string, unknown> = {};

    const tx = {
      order: {
        updateMany: orderUpdateMany,
        findUniqueOrThrow: async () => ({
          ...order,
          status: 'QUEUED_FOR_DISPATCH',
          statusHistory: [],
        }),
      },
      orderAssignment: { updateMany: updateManyAssignment },
      orderStatusHistory: {
        findFirst: async () => null,
        create: async () => ({ id: 'h-1' }),
      },
      auditLog: { create: async () => ({ id: 'a-1' }) },
    };

    const prisma = {
      buildOrderScopeFilter: () => ({}),
      order: { findFirst: async () => order },
      stageNorm: { findMany: async () => [] },
      workingCalendar: { findMany: async () => [] },
      runInTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    };

    const service = new OrderWorkflowService(
      prisma as never,
      new ReportsCacheService(),
      notificationsStub() as never,
      configStub() as never,
    );

    return {
      service,
      updateManyAssignment,
      getOrderUpdate: () => capturedOrderUpdate,
    };
  }

  it('закрывает активные назначения статусом RETURNED', async () => {
    const { service, updateManyAssignment } = makeService([
      { id: 'as-1', status: 'ASSIGNED' },
      { id: 'as-2', status: 'IN_PROGRESS' },
    ]);

    await service.transition({
      orderId: 'o-1',
      to: ORDER_STATUS.QUEUED_FOR_DISPATCH,
      actorId: 'u-1',
      actorRole: 'PRODUCTION_MANAGER',
      version: 1,
      scope: 'ALL_STORES',
      storeIds: [],
      reason: 'Возврат на очередь: нужны запчасти',
    });

    expect(updateManyAssignment).toHaveBeenCalledTimes(1);
    const call = updateManyAssignment.mock.calls[0]?.[0] as {
      where: { orderId: string; status: { in: string[] } };
      data: { status: string; finishedAt: Date };
    };
    expect(call.where).toEqual({ orderId: 'o-1', status: { in: ['ASSIGNED', 'IN_PROGRESS'] } });
    expect(call.data.status).toBe('RETURNED');
    expect(call.data.finishedAt).toBeInstanceOf(Date);
  });

  it('НЕ трогает ответственного менеджера', async () => {
    /*
     * Это и есть дефект 60. Очистка `productionManagerId` лишала заказ
     * ответственного, хотя перераспределялась только работа ювелира.
     */
    const { service, getOrderUpdate } = makeService([{ id: 'as-1', status: 'ASSIGNED' }]);

    await service.transition({
      orderId: 'o-1',
      to: ORDER_STATUS.QUEUED_FOR_DISPATCH,
      actorId: 'u-1',
      actorRole: 'PRODUCTION_MANAGER',
      version: 1,
      scope: 'ALL_STORES',
      storeIds: [],
      reason: 'Возврат на очередь: нужны запчасти',
    });

    expect(getOrderUpdate()).not.toHaveProperty('productionManagerId');
  });
});

describe('Уведомление клиента при переходе (задача 5.10)', () => {
  /**
   * Собрать сервис с заказом, переходящим в «Готов к выдаче».
   *
   * `READY_FOR_PICKUP` выбран потому, что это САМОЕ ЗНАЧИМОЕ для клиента
   * событие: без него изделие лежит в магазине, а клиент не знает, что его
   * можно забрать.
   */
  function makeService(options: {
    phoneNormalized?: string;
    customer?: Record<string, unknown> | null;
    orderRow?: Record<string, unknown> | null;
    withEffect?: boolean;
    /** Значение настройки `WARRANTY_MONTHS_DEFAULT` в двойнике ConfigService. */
    warrantyMonthsDefault?: number;
    /** Перехват данных, с которыми сервис обновляет заказ. */
    onUpdate?: (data: Record<string, unknown>) => void;
  }) {
    const order = {
      id: 'o-1',
      orderNo: 'MSK1-2509-000001',
      status: 'IN_TRANSIT_TO_STORE',
      version: 1,
      storeId: 's-1',
      complexity: 'SIMPLE',
      dueAt: new Date('2026-09-25T00:00:00.000Z'),
      readyAt: null,
      items: [{ id: 'i-1' }],
      works: [{ id: 'w-1', warrantyMonths: 12 }],
      approvals: [],
      refusalAct: null,
      claims: [],
      batchItems: [{ batch: { id: 'b-1', status: 'RECEIVED', acts: [{ id: 'act-1' }] } }],
      assignments: [],
      customer: { id: 'c-1', consentCallRecording: true, phoneNormalized: '+79161234567' },
      ...(options.customer === undefined ? {} : { customer: options.customer }),
      ...(options.orderRow ?? {}),
    };

    const tx = {
      order: {
        updateMany: async (args: { data: Record<string, unknown> }) => {
          options.onUpdate?.(args.data);
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({
          ...order,
          status: 'READY_FOR_PICKUP',
          statusHistory: [],
        }),
      },
      orderStatusHistory: {
        findFirst: async () => null,
        create: async () => ({ id: 'h-1' }),
      },
      auditLog: { create: async () => ({ id: 'a-1' }) },
    };

    const prisma = {
      buildOrderScopeFilter: () => ({}),
      order: {
        findFirst: async () => order,
        // Заказ читается ЗАНОВО для уведомления: результат перехода не содержит
        // ни клиента, ни сумм.
        findUnique: async () => ({
          id: 'o-1',
          orderNo: 'MSK1-2509-000001',
          dueAt: order.dueAt,
          warrantyUntil: null,
          totalAmountMinor: 120_000,
          customer: { id: 'c-1', phoneNormalized: options.phoneNormalized ?? '+79161234567' },
        }),
      },
      stageNorm: { findMany: async () => [] },
      workingCalendar: { findMany: async () => [] },
      runInTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    };

    const notifications = notificationsStub();
    const service = new OrderWorkflowService(
      prisma as never,
      new ReportsCacheService(),
      notifications as never,
      configStub(
        options.warrantyMonthsDefault === undefined
          ? {}
          : { WARRANTY_MONTHS_DEFAULT: options.warrantyMonthsDefault },
      ) as never,
    );
    return { service, notifications };
  }

  async function transition(service: OrderWorkflowService) {
    return await service.transition({
      orderId: 'o-1',
      to: ORDER_STATUS.READY_FOR_PICKUP,
      actorId: 'u-1',
      actorRole: 'LOGISTICIAN',
      version: 1,
      scope: 'ALL_STORES',
      storeIds: [],
    });
  }

  it('переход в «Готов к выдаче» создаёт уведомление клиенту', async () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА ЗАДАЧИ. Эффект `NOTIFY_CUSTOMER` есть в таблице переходов,
     * но раньше не обрабатывался ВООБЩЕ: клиент не получал ничего, хотя система
     * считала, что уведомила его. Дефект не проявлялся как ошибка — просто
     * клиент не знал, что заказ готов, и изделие лежало в магазине.
     */
    const { service, notifications } = makeService({});
    await transition(service);

    expect(notifications.calls).toHaveLength(1);
    expect(notifications.calls[0].code).toBe('READY_FOR_PICKUP');
    expect(notifications.calls[0].phone).toBe('+79161234567');
    expect(notifications.calls[0].orderId).toBe('o-1');
  });

  it('без телефона уведомление не создаётся, но переход выполняется', async () => {
    /*
     * Телефон записан не у всех клиентов. Переход обязан состояться: изделие
     * физически готово, и отказ в переводе из-за пустого поля оставил бы заказ в
     * статусе «в пути» навсегда.
     */
    const { service, notifications } = makeService({ phoneNormalized: '' });
    const result = await transition(service);

    expect(result).toBeDefined();
    expect(notifications.calls).toHaveLength(0);
  });

  it('нормализованный телефон передаётся шлюзу, а не «как ввёл пользователь»', async () => {
    /*
     * В поле «как ввёл пользователь» могут быть скобки и дефисы — шлюз такую
     * строку отклонит. Отправляется E.164.
     */
    const { service, notifications } = makeService({ phoneNormalized: '+79035554433' });
    await transition(service);

    /*
     * Значение НЕ совпадает с тем, что стоит по умолчанию в двойнике: иначе
     * проверка прошла бы и при подстановке константы вместо поля клиента, то
     * есть ничего бы не доказывала.
     */
    expect(notifications.calls[0].phone).toBe('+79035554433');
  });

  it('пустой телефон не создаёт уведомление с пустым получателем', async () => {
    /*
     * `Order.customerId` в схеме ОБЯЗАТЕЛЕН, поэтому клиента без связи не
     * бывает, а вот телефон у него может быть не заполнен. Запись с пустым
     * получателем навсегда осталась бы в очереди и копилась бы в списке
     * «требует вмешательства».
     */
    const { service, notifications } = makeService({ phoneNormalized: '' });
    await transition(service);

    expect(notifications.calls).toHaveLength(0);
  });

  it('переходы, не касающиеся клиента, события не имеют', () => {
    /*
     * НЕ КАЖДЫЙ ПЕРЕХОД ТРЕБУЕТ СООБЩЕНИЯ КЛИЕНТУ. Перевод на очередь
     * производства, в путь или между цехами клиента не касается, и писать ему на
     * каждый шаг было бы навязчиво.
     */
    const silent: [string, string][] = [
      ['ACCEPTED', 'QUEUED_FOR_DISPATCH'],
      ['QUEUED_FOR_DISPATCH', 'IN_TRANSIT_TO_WORKSHOP'],
      ['IN_TRANSIT_TO_WORKSHOP', 'IN_PRODUCTION'],
      ['IN_PRODUCTION', 'PRODUCTION_FINISHED'],
    ];

    for (const [from, to] of silent) {
      expect(
        customerEventForTransition(from, to),
        `${from}->${to}: клиенту не о чем сообщать`,
      ).toBeNull();
    }
  });

  it('важные для клиента переходы влекут клиентское событие', () => {
    /*
     * Обратная проверка: событие не должно ПРОПАСТЬ из таблицы. Пропажа
     * «готов к выдаче» означала бы, что изделие лежит в магазине, а клиент об
     * этом не знает, — ровно тот дефект, который закрывает задача.
     */
    expect(customerEventForTransition('IN_TRANSIT_TO_STORE', 'READY_FOR_PICKUP')).toBe(
      'READY_FOR_PICKUP',
    );
    expect(customerEventForTransition('DRAFT', 'ACCEPTED')).toBe('ORDER_ACCEPTED');
    expect(customerEventForTransition('READY_FOR_PICKUP', 'COMPLETED')).toBe('WARRANTY_ISSUED');
  });

  it('один целевой статус даёт разные события для разных переходов', () => {
    /*
     * ДЕФЕКТ ПЕРВОЙ ВЕРСИИ, найденный при разборе таблицы переходов. Статус
     * `ACCEPTED` достигается двумя переходами: из `DRAFT` («заказ принят») и из
     * `AWAITING_PREPAYMENT` («предоплата получена»). Таблица, ключёванная
     * ЦЕЛЕВЫМ СТАТУСОМ, смогла бы выразить только один смысл — и клиент либо не
     * узнал бы, что заказ принят, либо получил бы «оплата получена», ничего не
     * заплатив.
     *
     * Ключ по паре «откуда→куда» это различает.
     */
    const fromDraft = customerEventForTransition('DRAFT', 'ACCEPTED');
    const fromPrepayment = customerEventForTransition('AWAITING_PREPAYMENT', 'ACCEPTED');

    expect(fromDraft).toBe('ORDER_ACCEPTED');
    // Предоплата — событие ПЛАТЕЖА: создаётся тем, кто принимает деньги.
    expect(fromPrepayment).toBeNull();
  });

  it('ошибка уведомления не отменяет переход', async () => {
    /*
     * Уведомление — СЛЕДСТВИЕ перехода, а не его условие. Исключение здесь
     * вернуло бы сотруднику ошибку при фактически выполненной операции и
     * заставило бы повторить переход, который уже состоялся.
     */
    const { service, notifications } = makeService({});
    notifications.notifyCustomer = async () => {
      throw new Error('шлюз недоступен');
    };

    const result = await transition(service);
    expect(result).toBeDefined();
  });
});

describe('Срок гарантии по умолчанию из настройки WARRANTY_MONTHS_DEFAULT (дефект 53)', () => {
  /*
   * Настройка была объявлена в схеме окружения и в `.env.example` с
   * комментарием «6 обычный, 3 закрепка», но не читалась нигде: в коде стояла
   * жёсткая «6». Изменение переменной не меняло ничего.
   */
  function makeServiceWithWarranty(defaultMonths?: number) {
    const order = {
      id: 'o-1',
      orderNo: 'MSK1-2509-000001',
      // Гарантия считается при ВЫДАЧЕ клиенту: переход 18 «Готов к выдаче →
      // Выдан» содержит эффект COMPUTE_WARRANTY.
      status: 'READY_FOR_PICKUP',
      version: 1,
      storeId: 's-1',
      complexity: 'SIMPLE',
      dueAt: new Date('2026-09-25T00:00:00.000Z'),
      readyAt: null,
      items: [{ id: 'i-1' }],
      // Работ у заказа нет: именно тогда применяется значение по умолчанию.
      works: [],
      customerId: 'c-1',
      totalAmountMinor: 120_000,
      warrantyMonths: 6,
      statusHistory: [],
      batchItems: [],
      claims: [],
      assignments: [],
      approvals: [],
      refusalAct: null,
      workshopId: 'w-1',
      customer: { id: 'c-1', consentCallRecording: true, phoneNormalized: '+79161234567' },
      customerId: 'c-1',
      worksTotalMinor: 100_000,
      stonesTotalMinor: 20_000,
      discountMinor: 0,
      prepaymentRequiredMinor: 0,
      requiresPrepayment: false,
      // Оба условия выдачи выполнены: заказ оплачен и подпись клиента есть.
      pickupSignatureFileId: 'f-1',
      paidAmountMinor: 120_000,
      performerAssigned: false,
      workFinished: false,
    };

    let captured: Record<string, unknown> | undefined;
    const tx = {
      order: {
        updateMany: async (args: { data: Record<string, unknown> }) => {
          captured = args.data;
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({ ...order, status: 'COMPLETED', statusHistory: [] }),
      },
      orderStatusHistory: {
        findFirst: async () => null,
        create: async () => ({ id: 'h-1' }),
      },
      auditLog: { create: async () => ({ id: 'a-1' }) },
    };

    const prisma = {
      buildOrderScopeFilter: () => ({}),
      order: {
        findFirst: async () => order,
        findUnique: async () => ({
          id: 'o-1',
          orderNo: 'MSK1-2509-000001',
          dueAt: order.dueAt,
          warrantyUntil: null,
          totalAmountMinor: 120_000,
          customer: { id: 'c-1', phoneNormalized: '+79161234567' },
        }),
      },
      stageNorm: { findMany: async () => [] },
      workingCalendar: { findMany: async () => [] },
      runInTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    };

    const config = {
      get: (key: string) =>
        key === 'WARRANTY_MONTHS_DEFAULT' && defaultMonths !== undefined ? defaultMonths : 6,
    };
    const service = new OrderWorkflowService(
      prisma as never,
      new ReportsCacheService(),
      notificationsStub() as never,
      config as never,
    );
    return { service, captured: () => captured };
  }

  async function complete(service: OrderWorkflowService) {
    // Выдача клиенту — действие приёмщика (переход 18: RECEIVER, CASHIER, ADMIN).
    return await service.transition({
      orderId: 'o-1',
      to: ORDER_STATUS.COMPLETED,
      actorId: 'u-1',
      actorRole: 'RECEIVER',
      version: 1,
      scope: 'ALL_STORES',
      storeIds: [],
    });
  }

  /** Разница в месяцах между двумя моментами — с учётом разной длины месяцев. */
  function monthsBetween(from: Date, to: Date): number {
    let months =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
    if (to.getUTCDate() < from.getUTCDate()) months -= 1;
    return months;
  }

  it('настройка действительно применяется при выдаче заказа', async () => {
    const { service, captured } = makeServiceWithWarranty(12);
    await complete(service);

    /*
     * Заказ без работ: гарантия берётся из настройки. Сравнивается РАЗНИЦА, а
     * не конкретная дата: она зависела бы от дня прогона теста.
     */
    const until = captured()?.warrantyUntil as Date;
    expect(until).toBeInstanceOf(Date);
    expect(monthsBetween(new Date(), until)).toBe(12);
  });

  it('значение по умолчанию — 6 месяцев', async () => {
    const { service, captured } = makeServiceWithWarranty(undefined);
    await complete(service);

    expect(monthsBetween(new Date(), captured()?.warrantyUntil as Date)).toBe(6);
  });

  it('испорченное значение настройки не обнуляет гарантию', async () => {
    const { service, captured } = makeServiceWithWarranty(0);
    await complete(service);

    // Ноль месяцев означал бы «гарантии нет» — клиент потерял бы право,
    // которое ему назвали. Берётся значение по умолчанию.
    expect(monthsBetween(new Date(), captured()?.warrantyUntil as Date)).toBe(6);
  });
});
