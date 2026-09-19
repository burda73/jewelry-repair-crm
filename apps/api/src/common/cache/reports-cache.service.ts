/**
 * Кэш отчётов (задача 5.7, docs/06 §6.2).
 *
 * ЗАЧЕМ ЭТО. Отчёт считается SQL-агрегатами по всей истории: годовой срез
 * «сроков по этапам» читает десятки тысяч строк истории. Руководитель открывает
 * дашборд несколько раз в день и каждый раз получает одно и то же — считать это
 * заново значит нагружать базу ради неизменного ответа и заставлять человека
 * ждать.
 *
 * ПОЧЕМУ КЭШ В ПАМЯТИ, А НЕ REDIS. На боевом сервере Redis не установлен, и
 * развёртывание обходится без него: API — один процесс, и общий кэш между
 * процессами не нужен. Внешний кэш добавил бы ещё один сервис, который надо
 * поднимать, мониторить и резервировать, — ради экономии секунд на отчёте это
 * неоправданно.
 *
 * ЧЕГО ЭТОТ КЭШ НЕ ДЕЛАЕТ. Он не переживает перезапуск (и не должен: после
 * развёртывания данные могли измениться, и старый ответ опаснее медленного) и не
 * разделяется с воркером. Воркер эскалаций меняет статусы заказов, а его
 * инвалидация до API не доходит — от этого защищает короткий TTL: данные
 * обновляются сами, без внешнего сигнала. Именно поэтому TTL у «просрочек»
 * пять минут, а не час.
 *
 * ГЛАВНОЕ СВОЙСТВО — КЛЮЧ ВКЛЮЧАЕТ ОБЛАСТЬ ВИДИМОСТИ. Если бы ключ был только
 * «отчёт + период», приёмщик одного магазина получил бы из кэша отчёт,
 * посчитанный для всей сети: чужие суммы, чужие сроки, чужая выручка. Это не
 * «неточность», а утечка, и заметить её на экране невозможно — числа
 * правдоподобны. Поэтому в ключ входит набор доступных магазинов, и разные роли
 * физически не могут попасть в одну запись.
 */

import { Injectable, Logger } from '@nestjs/common';
import { REPORT_NAME, type ReportName } from '@app/shared';
import type { ReportResult } from '@app/shared';

/**
 * Время жизни записи по типу отчёта (docs/06 §6.2).
 *
 * Разное, потому что у отчётов разная скорость устаревания. «Просрочки» меняются
 * от каждого перехода статуса и нужны руководителю как текущая картина — пять
 * минут. «Сроки по этапам» описывают закономерность за период и от нового
 * заказа не меняются — час.
 */
export const REPORT_TTL_MS: Record<ReportName, number> = {
  [REPORT_NAME.OVERDUE]: 5 * 60_000,
  [REPORT_NAME.WORKSHOP_LOAD]: 15 * 60_000,
  [REPORT_NAME.STAGE_DURATIONS]: 60 * 60_000,
  [REPORT_NAME.REVENUE]: 15 * 60_000,
  [REPORT_NAME.PREPAYMENTS]: 15 * 60_000,
};

/** Время жизни по умолчанию: для отчёта, которого нет в таблице TTL. */
export const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Предельное число записей.
 *
 * Кэш без ограничения — это утечка памяти: каждый набор фильтров (период,
 * магазины, разрез) даёт свою запись, а число сочетаний не ограничено. При
 * превышении вытесняются самые старые — отчёты запрашивают свежие периоды, и они
 * же нужнее.
 */
export const MAX_ENTRIES = 200;

/** Причина сброса — для журнала: по ней видно, что именно изменилось. */
export const INVALIDATION_REASON = {
  STATUS: 'status',
  PAYMENT: 'payment',
  MANUAL: 'manual',
} as const;

export type InvalidationReason = (typeof INVALIDATION_REASON)[keyof typeof INVALIDATION_REASON];

interface CacheEntry {
  value: ReportResult;
  /** Момент, после которого запись недействительна. */
  expiresAt: number;
  /** Момент создания: по нему вытесняются самые старые. */
  createdAt: number;
}

@Injectable()
export class ReportsCacheService {
  private readonly logger = new Logger(ReportsCacheService.name);
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * Взять отчёт из кэша.
   *
   * Просроченная запись удаляется и не возвращается: отдать её значило бы
   * показать данные, которые система уже считает устаревшими.
   */
  get(key: string, now = Date.now()): ReportResult | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;

    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Положить отчёт в кэш.
   *
   * `now` передаётся и в вытеснение. Это не формальность: вытеснение сравнивает
   * `expiresAt` с текущим моментом, и если бы оно брало системное время, а запись
   * ставилась с другим отсчётом, ВСЕ записи выглядели бы просроченными и
   * удалялись бы сразу — кэш не работал бы вовсе, а выглядело бы это как
   * «отчёты всегда считаются заново». Дефект найден тестом «вытесняются самые
   * старые записи».
   */
  set(key: string, value: ReportResult, ttlMs: number, now = Date.now()): void {
    this.entries.set(key, { value, expiresAt: now + ttlMs, createdAt: now });
    this.evictIfNeeded(now);
  }

  /**
   * Сбросить записи.
   *
   * Без отчёта сбрасывается всё — так делается при изменении данных, которое
   * может затронуть любой отчёт (переход статуса меняет и просрочки, и сроки, и
   * загрузку цеха). С отчётом — только он: платёж не влияет на сроки этапов, и
   * сбрасывать их значило бы заставлять следующий запрос считать заново без
   * причины.
   *
   * @returns число сброшенных записей — для журнала и тестов
   */
  invalidate(reports?: readonly ReportName[]): number {
    if (reports === undefined || reports.length === 0) {
      const count = this.entries.size;
      this.entries.clear();
      return count;
    }

    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      // Ключ начинается с имени отчёта: `revenue|<scope>|<период>`.
      const name = key.slice(0, key.indexOf('|'));
      if (reports.includes(name as ReportName)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Текущее число записей — для проверок и наблюдения. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Вытеснить самые старые записи при превышении предела.
   *
   * Сначала убираются просроченные: они уже недействительны, и освобождать место
   * за их счёт честнее, чем за счёт свежих данных.
   */
  private evictIfNeeded(now = Date.now()): void {
    if (this.entries.size <= MAX_ENTRIES) return;

    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }

    while (this.entries.size > MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestCreatedAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries.entries()) {
        if (entry.createdAt < oldestCreatedAt) {
          oldestCreatedAt = entry.createdAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      this.entries.delete(oldestKey);
    }

    this.logger.debug(`Кэш отчётов: вытеснено до ${this.entries.size} записей`);
  }
}

/**
 * Ключ кэша.
 *
 * ОБЛАСТЬ ВИДИМОСТИ ВХОДИТ В КЛЮЧ. Это главное свойство модуля: без него
 * приёмщик одного магазина получил бы из кэша отчёт по всей сети — чужие суммы и
 * чужие сроки. Ошибка не видна на экране, потому что числа правдоподобны.
 *
 * Магазины СОРТИРУЮТСЯ: `[A, B]` и `[B, A]` — один и тот же доступ, и без
 * сортировки они дали бы две записи с одинаковым содержимым, то есть кэш
 * промахивался бы впустую.
 *
 * Период входит миллисекундами: `from`/`to` — моменты времени, и сравнивать их
 * строками значило бы зависеть от формата вывода даты.
 */
export function reportCacheKey(
  name: string,
  query: {
    from: Date;
    to: Date;
    storeIds: readonly string[];
    workshopIds: readonly string[];
    groupBy: string | null;
    limit: number;
  },
): string {
  const stores = [...query.storeIds].sort().join(',');
  const workshops = [...query.workshopIds].sort().join(',');
  return [
    name,
    stores,
    workshops,
    query.from.getTime(),
    query.to.getTime(),
    query.groupBy ?? '',
    query.limit,
  ].join('|');
}

/**
 * Время жизни для отчёта.
 *
 * Годовые срезы живут сутки (docs/06 §6.2): отчёт за год меняется медленно, и
 * пересчитывать его каждый час незачем. Проверка идёт по ДЛИНЕ периода, а не по
 * календарному году: «с января по декабрь» и «365 дней назад — сегодня» — это
 * один и тот же годовой срез.
 */
export function ttlForReport(name: string, periodDays: number): number {
  if (periodDays >= 300) return 24 * 60 * 60_000;
  return REPORT_TTL_MS[name as ReportName] ?? DEFAULT_TTL_MS;
}
