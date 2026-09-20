import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_COUNTERS,
  counterListHref,
  summaryFromCounts,
  OVERDUE_EXCLUDED_STATUSES,
  IN_TRANSIT_STATUSES,
  type DashboardCounterKey,
} from './order-counters.js';
import { ORDER_TRANSITIONS } from './order-transitions.js';
import {
  ORDER_STATUS,
  IN_PRODUCTION_STATUSES,
  ALL_ORDER_STATUSES,
  STATUS_STAGE,
  isWorksEditable,
  type OrderStatus,
} from './order-status.js';

/** Собрать карту статусов из пар «статус → число». */
function counts(pairs: Partial<Record<OrderStatus, number>>): Map<OrderStatus, number> {
  return new Map(Object.entries(pairs) as [OrderStatus, number][]);
}

/** Сумма чисел по набору статусов — эталон для групповых счётчиков. */
function sumOf(pairs: Partial<Record<OrderStatus, number>>, statuses: readonly OrderStatus[]) {
  return statuses.reduce((sum, status) => sum + (pairs[status] ?? 0), 0);
}

describe('Счётчики дашборда: число и ссылка из одного описания', () => {
  it('каждый ключ сводки описан ровно один раз', () => {
    // Дубль ключа дал бы две плитки с одним числом, а ссылка от одной из них
    // потерялась бы.
    const keys = DASHBOARD_COUNTERS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('описаны все ключи ответа `/orders/summary`', () => {
    // Пропущенный ключ — плитка, которой нет на экране, хотя сервер её считает.
    const described = new Set<DashboardCounterKey>(DASHBOARD_COUNTERS.map((c) => c.key));
    const expected: DashboardCounterKey[] = [
      'total',
      'inProduction',
      'readyForPickup',
      'overdue',
      'awaitingPrepayment',
      'unclaimed',
      'awaitingApproval',
      'inTransit',
    ];
    for (const key of expected) expect(described, `ключ ${key}`).toContain(key);
    expect(described.size).toBe(expected.length);
  });

  it('«В производстве» считает ВСЕ статусы цеха, а не только IN_PRODUCTION', () => {
    /*
     * После задачи 7.1 заказы в цехе находятся в `ACCEPTED_BY_WORKSHOP`,
     * `IN_WORK` и `WORK_COMPLETED`; `IN_PRODUCTION` остался только у заказов,
     * принятых до этой правки. Подсчёт по одному статусу показывал бы
     * «в производстве: 0» при полном цехе — дашборд врал бы в самую заметную
     * сторону.
     */
    const pairs = {
      ACCEPTED_BY_WORKSHOP: 2,
      IN_WORK: 3,
      WORK_COMPLETED: 1,
      IN_PRODUCTION: 4,
      REWORK: 1,
      // Не входит в производство: заказ уже уехал в магазин.
      IN_TRANSIT_TO_STORE: 9,
    } as const;

    const summary = summaryFromCounts({ total: 30, byStatus: counts(pairs), overdue: 0 });

    expect(summary.inProduction).toBe(11);
    expect(summary.inProduction).toBe(sumOf(pairs, IN_PRODUCTION_STATUSES));
  });

  it('«В пути» складывает очередь и оба направления', () => {
    const pairs = {
      QUEUED_FOR_DISPATCH: 2,
      IN_TRANSIT_TO_PRODUCTION: 3,
      IN_TRANSIT_TO_STORE: 1,
      // Уже не «в пути»: изделие на месте, ждёт клиента.
      READY_FOR_PICKUP: 4,
      IN_PRODUCTION: 5,
    } as const;

    const summary = summaryFromCounts({ total: 20, byStatus: counts(pairs), overdue: 0 });

    expect(summary.inTransit).toBe(6);
    expect(summary.inTransit).toBe(sumOf(pairs, IN_TRANSIT_STATUSES));
  });

  it('«Просрочено» берётся из отдельного счёта, а не из разбивки по статусам', () => {
    /*
     * «Просрочено» — пересечение `dueAt < now` с набором исключений; из разбивки
     * по статусам это число не вывести. Если бы функция брала его из карты,
     * счётчик показывал бы совершенно другое число.
     */
    const summary = summaryFromCounts({
      total: 100,
      byStatus: counts({ IN_WORK: 100 }),
      overdue: 7,
    });

    expect(summary.overdue).toBe(7);
    // Сумма по статусам дала бы 100 — счётчик обязан её игнорировать.
    expect(summary.overdue).not.toBe(100);
  });

  it('«Всего» — общее число, а не сумма по статусам', () => {
    /*
     * Расходимся намеренно: если функция начнёт выводить «всего» из карты, тест
     * упадёт. Общее число приходит из `aggregate` и включает статусы, которых в
     * карте может не быть.
     */
    const summary = summaryFromCounts({
      total: 50,
      byStatus: counts({ IN_WORK: 3 }),
      overdue: 0,
    });

    expect(summary.total).toBe(50);
    expect(summary.inProduction).toBe(3);
  });

  it('одиночные статусы считаются точно по своему статусу', () => {
    const pairs = {
      READY_FOR_PICKUP: 6,
      UNCLAIMED: 2,
      AWAITING_APPROVAL: 3,
      AWAITING_PREPAYMENT: 4,
      // Похожие по смыслу, но другие статусы: в эти счётчики попасть не должны.
      ACCEPTED: 7,
      IN_WORK: 8,
    } as const;

    const summary = summaryFromCounts({ total: 40, byStatus: counts(pairs), overdue: 0 });

    expect(summary.readyForPickup).toBe(6);
    expect(summary.unclaimed).toBe(2);
    expect(summary.awaitingApproval).toBe(3);
    expect(summary.awaitingPrepayment).toBe(4);
  });

  it('отсутствующий статус считается нулём, а не пропуском', () => {
    const summary = summaryFromCounts({ total: 0, byStatus: counts({}), overdue: 0 });

    for (const counter of DASHBOARD_COUNTERS) {
      expect(summary[counter.key], `ключ ${counter.key}`).toBe(0);
    }
  });

  it('разбивка по статусам не влияет на «просрочено» ни при каком составе', () => {
    // Обратная сторона предыдущей проверки: подмена карты не должна менять
    // просрочку — иначе число зависело бы от того, что попалось в groupBy.
    const first = summaryFromCounts({
      total: 10,
      byStatus: counts({ IN_WORK: 5 }),
      overdue: 3,
    });
    const second = summaryFromCounts({
      total: 10,
      byStatus: counts({ COMPLETED: 999 }),
      overdue: 3,
    });

    expect(first.overdue).toBe(second.overdue);
  });
});

describe('Счётчики дашборда: адрес списка заказов', () => {
  it('фильтр по статусу превращается в `status=`, а не в произвольную строку', () => {
    expect(counterListHref({ status: [ORDER_STATUS.READY_FOR_PICKUP] })).toBe(
      '/orders?status=READY_FOR_PICKUP',
    );
  });

  it('несколько статусов идут одним параметром через запятую', () => {
    /*
     * Формат адреса — контракт с разбором фильтров в интерфейсе: разойдясь,
     * ссылка открывала бы список без фильтра, и число на карточке не совпало бы
     * со списком.
     *
     * Разбираем параметр, а не сверяем строку: `URLSearchParams` кодирует
     * запятую как `%2C`, и это нормально — обратное чтение возвращает список
     * статусов целиком. Сверка «как выглядит строка» ломалась бы от смены
     * кодировщика, ничего не проверяя по существу.
     */
    const href = counterListHref({ status: IN_PRODUCTION_STATUSES });
    const params = new URLSearchParams(href.split('?')[1] ?? '');

    expect(params.getAll('status')).toHaveLength(1);
    expect(params.get('status')?.split(',')).toEqual([...IN_PRODUCTION_STATUSES]);
  });

  it('просрочка кодируется `overdue=true`', () => {
    expect(counterListHref({ overdue: true })).toBe('/orders?overdue=true');
  });

  it('пустой фильтр ведёт в список без параметров', () => {
    // «Всего заказов» не должно давать `/orders?` с пустым хвостом.
    expect(counterListHref({})).toBe('/orders');
  });

  it('пустой набор статусов не превращается в фильтр по пустоте', () => {
    /*
     * `status=` без значения сервер понял бы как отсутствие фильтра, но клиент
     * мог бы отправить `status: { in: [] }` — запрос, который не вернёт ничего.
     * Лучше не отправлять параметр вовсе.
     */
    expect(counterListHref({ status: [] })).toBe('/orders');
  });

  it('адрес каждого счётчика содержит ровно один ожидаемый параметр', () => {
    for (const counter of DASHBOARD_COUNTERS) {
      const href = counterListHref(counter.filter);
      const params = new URLSearchParams(href.split('?')[1] ?? '');
      const expectedKeys = counter.filter.overdue === true ? ['overdue'] : [];
      if (counter.filter.status !== undefined && counter.filter.status.length > 0) {
        expectedKeys.push('status');
      }
      expect([...params.keys()].sort(), `счётчик ${counter.key}`).toEqual(expectedKeys.sort());
    }
  });
});

describe('Счётчики дашборда: набор исключений просрочки', () => {
  it('закрытые статусы просрочкой не считаются', () => {
    // Выданный заказ с истёкшим сроком иначе числился бы просроченным вечно.
    for (const status of [
      ORDER_STATUS.COMPLETED,
      ORDER_STATUS.REFUSED,
      ORDER_STATUS.REFUSED_BEFORE_WORK,
      ORDER_STATUS.CANCELLED,
      ORDER_STATUS.UNCLAIMED,
    ]) {
      expect(OVERDUE_EXCLUDED_STATUSES, `статус ${status}`).toContain(status);
    }
  });

  it('те статусы, где ждут клиента, просрочкой не считаются', () => {
    // Пока клиент не заплатил или не согласовал, срок идёт по вине клиента:
    // напоминать ответственному бессмысленно.
    expect(OVERDUE_EXCLUDED_STATUSES).toContain(ORDER_STATUS.DRAFT);
    expect(OVERDUE_EXCLUDED_STATUSES).toContain(ORDER_STATUS.ACCEPTED);
    expect(OVERDUE_EXCLUDED_STATUSES).toContain(ORDER_STATUS.AWAITING_PREPAYMENT);
  });

  it('статусы цеха и выдачи в просрочке участвуют', () => {
    // Обратная сторона: исключить их значило бы спрятать настоящую просрочку.
    for (const status of [
      ORDER_STATUS.ACCEPTED_BY_WORKSHOP,
      ORDER_STATUS.IN_WORK,
      ORDER_STATUS.WORK_COMPLETED,
      ORDER_STATUS.READY_FOR_PICKUP,
    ]) {
      expect(OVERDUE_EXCLUDED_STATUSES, `статус ${status}`).not.toContain(status);
    }
  });

  it('«в производстве» и «исключено из просрочки» не пересекаются', () => {
    /*
     * Статус в цехе обязан быть просрочиваемым: иначе заказ, застрявший у
     * ювелира, никогда не попадёт в счётчик, и просрочку никто не заметит.
     */
    const production = new Set<string>(IN_PRODUCTION_STATUSES);
    const excluded = new Set<string>(OVERDUE_EXCLUDED_STATUSES);
    expect([...production].filter((s) => excluded.has(s))).toEqual([]);
  });

  it('наборы «в пути» и «в производстве» не пересекаются', () => {
    // Заказ либо едет, либо стоит в цехе; пересечение означало бы двойной учёт.
    const transit = new Set<string>(IN_TRANSIT_STATUSES);
    const production = new Set<string>(IN_PRODUCTION_STATUSES);
    expect([...transit].filter((s) => production.has(s))).toEqual([]);
  });
});

/**
 * Граница правки состава работ (требование заказчика).
 *
 * Работы правятся, пока изделие не выдано исполнителю. Последний такой статус —
 * `ACCEPTED_BY_WORKSHOP`: менеджер цеха принимает изделие и может дополнить
 * объём, если при осмотре нашёлся скрытый дефект.
 *
 * ЗДЕСЬ БЫЛА ОШИБКА, и тест её фиксирует. Первая версия правила выводила
 * границу из этапов (`INTAKE`, `APPROVAL`, `PREPAYMENT`), а
 * `ACCEPTED_BY_WORKSHOP` относится к этапу `PRODUCTION` — поэтому правка
 * запрещалась ровно в том статусе, где она нужна, и требование «меняй работы,
 * но получи согласование» становилось невыполнимым: раньше работы менять
 * поздно, позже — они уже выполняются.
 */
describe('Граница правки состава работ', () => {
  it('на этапе приёма и согласования работы правятся', () => {
    for (const status of [
      ORDER_STATUS.DRAFT,
      ORDER_STATUS.AWAITING_APPROVAL,
      ORDER_STATUS.AWAITING_PREPAYMENT,
      ORDER_STATUS.ACCEPTED,
    ] as const) {
      expect(isWorksEditable(status), `статус ${status}`).toBe(true);
    }
  });

  it('в ЦЕХЕ работы правятся, пока не выданы исполнителю', () => {
    /*
     * Главная проверка границы и исправление ошибки. `ACCEPTED_BY_WORKSHOP` —
     * последний статус, где правка ещё возможна: именно здесь менеджер цеха
     * видит изделие и понимает, что объём неполон.
     */
    for (const status of [
      ORDER_STATUS.QUEUED_FOR_DISPATCH,
      ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
      ORDER_STATUS.IN_PRODUCTION,
      ORDER_STATUS.ACCEPTED_BY_WORKSHOP,
    ] as const) {
      expect(isWorksEditable(status), `статус ${status}`).toBe(true);
    }
  });

  it('после выдачи исполнителю работы НЕ правятся', () => {
    // С `IN_WORK` ювелир работает по конкретному перечню: правка задним числом
    // означала бы, что заказ описывает не то, что выполняли.
    for (const status of [
      ORDER_STATUS.IN_WORK,
      ORDER_STATUS.WORK_COMPLETED,
      ORDER_STATUS.IN_TRANSIT_TO_STORE,
      ORDER_STATUS.READY_FOR_PICKUP,
      ORDER_STATUS.UNCLAIMED,
      ORDER_STATUS.REWORK,
    ] as const) {
      expect(isWorksEditable(status), `статус ${status}`).toBe(false);
    }
  });

  it('закрытые заказы не правятся', () => {
    for (const status of [
      ORDER_STATUS.COMPLETED,
      ORDER_STATUS.REFUSED,
      ORDER_STATUS.REFUSED_BEFORE_WORK,
      ORDER_STATUS.CANCELLED,
    ] as const) {
      expect(isWorksEditable(status), `статус ${status}`).toBe(false);
    }
  });

  it('граница проходит по статусу, а не по этапу', () => {
    /*
     * Регрессия на конкретную ошибку: `ACCEPTED_BY_WORKSHOP` относится к этапу
     * PRODUCTION, но правка в нём РАЗРЕШЕНА. Если кто-то снова выведет правило
     * из этапов, тест упадёт — и это правильно, потому что этап описывает, где
     * находится изделие, а не когда зафиксирован объём работ.
     */
    expect(STATUS_STAGE[ORDER_STATUS.ACCEPTED_BY_WORKSHOP]).toBe('PRODUCTION');
    expect(isWorksEditable(ORDER_STATUS.ACCEPTED_BY_WORKSHOP)).toBe(true);

    // И обратная сторона: соседний статус того же этапа уже закрыт.
    expect(STATUS_STAGE[ORDER_STATUS.IN_WORK]).toBe('PRODUCTION');
    expect(isWorksEditable(ORDER_STATUS.IN_WORK)).toBe(false);
  });

  it('статус, из которого выдаётся работа, ещё открыт для правки', () => {
    /*
     * Связь с таблицей переходов: работа выдаётся переходом в `IN_WORK`, и
     * статус-источник этого перехода обязан быть открыт для правки. Иначе
     * требование «измени работы и получи согласование, прежде чем выдавать»
     * снова стало бы невыполнимым.
     */
    const sourceStatuses = ORDER_TRANSITIONS.filter((rule) => rule.to === ORDER_STATUS.IN_WORK).map(
      (rule) => rule.from,
    );

    expect(sourceStatuses.length).toBeGreaterThan(0);
    for (const status of sourceStatuses) {
      if (status === null) continue;
      expect(isWorksEditable(status), `источник выдачи ${status} должен быть открыт`).toBe(true);
    }
  });

  it('каждый статус получает определённый ответ', () => {
    // Ни один статус не должен «выпасть» из правила: undefined в проверке права
    // означал бы, что кнопка правки показывается по случайности.
    for (const status of ALL_ORDER_STATUSES) {
      expect(typeof isWorksEditable(status), `статус ${status}`).toBe('boolean');
    }
  });
});
