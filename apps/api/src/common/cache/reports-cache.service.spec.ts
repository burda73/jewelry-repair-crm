/**
 * Тесты кэша отчётов (задача 5.7, docs/06 §6.2).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Кэш — это место, где ошибка НЕ ВИДНА: ответ приходит, числа
 * правдоподобны, страница работает. Поэтому проверяются не «кэш сохраняет», а
 * свойства, ради которых он существует и которые легко потерять при правке:
 *
 *  * ОБЛАСТЬ ВИДИМОСТИ В КЛЮЧЕ. Без неё приёмщик одного магазина получает из
 *    кэша отчёт по всей сети: чужие суммы, чужие сроки, чужая выручка. Это
 *    утечка, а не «неточность», и заметить её на экране невозможно.
 *  * ПРОСРОЧЕННАЯ ЗАПИСЬ НЕ ОТДАЁТСЯ. Иначе кэш превращается в источник
 *    устаревших данных, и руководитель принимает решения по вчерашней картине.
 *  * КЭШ ОГРАНИЧЕН. Каждый набор фильтров даёт свою запись, а число сочетаний не
 *    ограничено — без предела это утечка памяти, которая проявится через недели.
 *  * СБРОС ПОПАДАЕТ В НУЖНЫЕ ОТЧЁТЫ. Платёж не меняет сроки этапов: сбросить их
 *    значило бы считать заново без причины, а не сбросить выручку — показывать
 *    старые деньги после приёма оплаты.
 */

import { describe, expect, it } from 'vitest';
import { REPORT_NAME, type ReportResult } from '@app/shared';
import {
  DEFAULT_TTL_MS,
  MAX_ENTRIES,
  REPORT_TTL_MS,
  ReportsCacheService,
  reportCacheKey,
  ttlForReport,
} from './reports-cache.service';

const STORE_A = 'cmu5p70yu0002bm7pzqlcawsw';
const STORE_B = 'cmu5p70yu0003bm7pzqlcawsw';

function result(from = '2025-09-01'): ReportResult {
  return {
    meta: {
      from,
      to: '2025-09-30',
      generatedAt: '2025-09-30T12:00:00.000Z',
      cached: false,
      rowCount: 1,
    },
    columns: [{ key: 'store', title: 'Магазин', type: 'string' }],
    rows: [{ store: 'Тверская' }],
    totals: { ordersCount: 1 },
  };
}

function query(overrides: Record<string, unknown> = {}) {
  return {
    from: new Date('2025-09-01T00:00:00+03:00'),
    to: new Date('2025-09-30T00:00:00+03:00'),
    storeIds: [] as string[],
    workshopIds: [] as string[],
    groupBy: null,
    limit: 500,
    ...overrides,
  };
}

describe('Ключ кэша и область видимости (задача 5.7)', () => {
  it('разные наборы магазинов дают РАЗНЫЕ ключи', () => {
    /*
     * Главная проверка модуля. Ключ без области видимости означал бы, что
     * приёмщик одного магазина получит из кэша отчёт, посчитанный для всей сети:
     * чужие суммы и чужие сроки. Ошибка не видна на экране — числа правдоподобны.
     */
    const a = reportCacheKey(REPORT_NAME.OVERDUE, query({ storeIds: [STORE_A] }));
    const b = reportCacheKey(REPORT_NAME.OVERDUE, query({ storeIds: [STORE_B] }));
    const all = reportCacheKey(REPORT_NAME.OVERDUE, query({ storeIds: [] }));

    expect(a).not.toBe(b);
    expect(a).not.toBe(all);
    expect(all).not.toBe(b);
  });

  it('порядок магазинов не влияет на ключ', () => {
    /*
     * `[A, B]` и `[B, A]` — один и тот же доступ. Без сортировки это дало бы две
     * записи с одинаковым содержимым, и кэш промахивался бы впустую.
     */
    const ab = reportCacheKey(REPORT_NAME.REVENUE, query({ storeIds: [STORE_A, STORE_B] }));
    const ba = reportCacheKey(REPORT_NAME.REVENUE, query({ storeIds: [STORE_B, STORE_A] }));
    expect(ab).toBe(ba);
  });

  it('разные периоды дают разные ключи', () => {
    const september = reportCacheKey(REPORT_NAME.REVENUE, query());
    const october = reportCacheKey(
      REPORT_NAME.REVENUE,
      query({ from: new Date('2025-10-01T00:00:00+03:00') }),
    );
    expect(september).not.toBe(october);
  });

  it('разрез и предел строк входят в ключ', () => {
    // Иначе отчёт «по магазинам» отдался бы на запрос без разреза.
    const plain = reportCacheKey(REPORT_NAME.REVENUE, query());
    expect(reportCacheKey(REPORT_NAME.REVENUE, query({ groupBy: 'month' }))).not.toBe(plain);
    expect(reportCacheKey(REPORT_NAME.REVENUE, query({ limit: 10 }))).not.toBe(plain);
  });

  it('разные отчёты дают разные ключи', () => {
    expect(reportCacheKey(REPORT_NAME.REVENUE, query())).not.toBe(
      reportCacheKey(REPORT_NAME.PREPAYMENTS, query()),
    );
  });

  it('разные цеха дают разные ключи', () => {
    const a = reportCacheKey(REPORT_NAME.WORKSHOP_LOAD, query({ workshopIds: ['w-1'] }));
    const b = reportCacheKey(REPORT_NAME.WORKSHOP_LOAD, query({ workshopIds: ['w-2'] }));
    expect(a).not.toBe(b);
  });

  it('одинаковые параметры дают одинаковый ключ', () => {
    // Иначе кэш не работал бы вовсе: каждый запрос считался бы заново.
    expect(reportCacheKey(REPORT_NAME.OVERDUE, query())).toBe(
      reportCacheKey(REPORT_NAME.OVERDUE, query()),
    );
  });
});

describe('Хранение и срок жизни (задача 5.7)', () => {
  it('сохраняет и возвращает отчёт', () => {
    const cache = new ReportsCacheService();
    cache.set('k', result(), 60_000);
    expect(cache.get('k')?.rows).toHaveLength(1);
  });

  it('незнакомый ключ даёт null', () => {
    expect(new ReportsCacheService().get('нет')).toBeNull();
  });

  it('просроченная запись не отдаётся и удаляется', () => {
    /*
     * Иначе кэш превратился бы в источник устаревших данных: руководитель
     * принимал бы решения по вчерашней картине, не зная об этом.
     */
    const cache = new ReportsCacheService();
    const now = 1_000_000;
    cache.set('k', result(), 5_000, now);

    // Ровно на границе запись уже недействительна.
    expect(cache.get('k', now + 5_000)).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('запись живёт весь свой срок', () => {
    const cache = new ReportsCacheService();
    const now = 1_000_000;
    cache.set('k', result(), 5_000, now);
    expect(cache.get('k', now + 4_999)).not.toBeNull();
  });

  it('сроки жизни различаются по типу отчёта', () => {
    /*
     * У отчётов разная скорость устаревания: «просрочки» меняются от каждого
     * перехода статуса, «сроки по этапам» описывают закономерность за период и
     * от нового заказа не меняются.
     */
    expect(REPORT_TTL_MS[REPORT_NAME.OVERDUE]).toBe(5 * 60_000);
    expect(REPORT_TTL_MS[REPORT_NAME.STAGE_DURATIONS]).toBe(60 * 60_000);
    expect(REPORT_TTL_MS[REPORT_NAME.REVENUE]).toBe(15 * 60_000);
    expect(REPORT_TTL_MS[REPORT_NAME.OVERDUE]).toBeLessThan(
      REPORT_TTL_MS[REPORT_NAME.STAGE_DURATIONS],
    );
  });

  it('годовой срез живёт сутки', () => {
    // Отчёт за год меняется медленно, и пересчитывать его каждый час незачем.
    expect(ttlForReport(REPORT_NAME.REVENUE, 365)).toBe(24 * 60 * 60_000);
    expect(ttlForReport(REPORT_NAME.REVENUE, 300)).toBe(24 * 60 * 60_000);
  });

  it('короткий период использует обычный срок', () => {
    // Проверка идёт по ДЛИНЕ периода: «с января по декабрь» и «365 дней назад —
    // сегодня» — один и тот же годовой срез.
    expect(ttlForReport(REPORT_NAME.REVENUE, 30)).toBe(REPORT_TTL_MS[REPORT_NAME.REVENUE]);
    expect(ttlForReport(REPORT_NAME.OVERDUE, 7)).toBe(REPORT_TTL_MS[REPORT_NAME.OVERDUE]);
  });

  it('незнакомый отчёт получает срок по умолчанию', () => {
    // Новый отчёт должен кэшироваться, а не падать из-за отсутствия в таблице.
    expect(ttlForReport('новый-отчёт', 10)).toBe(DEFAULT_TTL_MS);
  });
});

describe('Сброс кэша (задача 5.7)', () => {
  it('полный сброс очищает всё', () => {
    // Переход статуса меняет и просрочки, и сроки, и загрузку цеха — то есть
    // любой отчёт.
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.REVENUE}|x`, result(), 60_000);
    cache.set(`${REPORT_NAME.OVERDUE}|x`, result(), 60_000);
    expect(cache.invalidate()).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it('сброс по отчёту не трогает остальные', () => {
    /*
     * Платёж меняет выручку, но не сроки этапов: сбросить их значило бы заставить
     * следующий запрос считать заново без причины.
     */
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.REVENUE}|x`, result(), 60_000);
    cache.set(`${REPORT_NAME.STAGE_DURATIONS}|x`, result(), 60_000);
    cache.set(`${REPORT_NAME.PREPAYMENTS}|x`, result(), 60_000);

    expect(cache.invalidate([REPORT_NAME.REVENUE, REPORT_NAME.PREPAYMENTS])).toBe(2);
    expect(cache.size()).toBe(1);
    expect(cache.get(`${REPORT_NAME.STAGE_DURATIONS}|x`)).not.toBeNull();
  });

  it('сброс выручки убирает и её, и предоплаты', () => {
    // Деньги влияют на оба отчёта, и оставить один — показать старые суммы.
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.REVENUE}|a`, result(), 60_000);
    cache.set(`${REPORT_NAME.REVENUE}|b`, result(), 60_000);
    cache.set(`${REPORT_NAME.PREPAYMENTS}|a`, result(), 60_000);
    cache.invalidate([REPORT_NAME.REVENUE, REPORT_NAME.PREPAYMENTS]);
    expect(cache.size()).toBe(0);
  });

  it('сброс пустого кэша безопасен', () => {
    expect(new ReportsCacheService().invalidate()).toBe(0);
  });

  it('сброс несуществующего отчёта безопасен', () => {
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.REVENUE}|x`, result(), 60_000);
    expect(cache.invalidate([REPORT_NAME.OVERDUE])).toBe(0);
    expect(cache.size()).toBe(1);
  });

  it('сброс по всем записям одного отчёта, а не только первой', () => {
    // Записей одного отчёта много: разные роли, периоды и разрезы.
    const cache = new ReportsCacheService();
    cache.set(`${REPORT_NAME.OVERDUE}|a`, result(), 60_000);
    cache.set(`${REPORT_NAME.OVERDUE}|b`, result(), 60_000);
    cache.set(`${REPORT_NAME.OVERDUE}|c`, result(), 60_000);
    expect(cache.invalidate([REPORT_NAME.OVERDUE])).toBe(3);
  });
});

describe('Предел размера кэша (задача 5.7)', () => {
  it('число записей не превышает предел', () => {
    /*
     * Каждый набор фильтров даёт свою запись, а число сочетаний не ограничено.
     * Кэш без предела — это утечка памяти, которая проявится через недели
     * работы, когда причину уже никто не свяжет с отчётами.
     */
    const cache = new ReportsCacheService();
    for (let index = 0; index < MAX_ENTRIES + 50; index += 1) {
      cache.set(`k-${index}`, result(), 60_000);
    }
    expect(cache.size()).toBeLessThanOrEqual(MAX_ENTRIES);
  });

  it('вытесняются самые старые записи', () => {
    // Отчёты запрашивают свежие периоды, и они же нужнее.
    const cache = new ReportsCacheService();
    const now = 1_000_000;
    for (let index = 0; index < MAX_ENTRIES; index += 1) {
      cache.set(`k-${index}`, result(), 600_000, now + index);
    }
    cache.set('новый', result(), 600_000, now + MAX_ENTRIES + 1);

    expect(cache.get('k-0', now + MAX_ENTRIES + 2)).toBeNull();
    expect(cache.get('новый', now + MAX_ENTRIES + 2)).not.toBeNull();
  });

  it('сначала вытесняются просроченные записи', () => {
    /*
     * Они уже недействительны, и освобождать место за их счёт честнее, чем за
     * счёт свежих данных.
     */
    const cache = new ReportsCacheService();
    const now = 1_000_000;
    for (let index = 0; index < MAX_ENTRIES; index += 1) {
      // Просроченные: срок истёк.
      cache.set(`старый-${index}`, result(), 1, now);
    }
    cache.set('новый', result(), 600_000, now + 10);

    // Свежая запись осталась, а место освободили просроченные.
    expect(cache.get('новый', now + 11)).not.toBeNull();
    expect(cache.size()).toBeLessThanOrEqual(MAX_ENTRIES);
  });
});
