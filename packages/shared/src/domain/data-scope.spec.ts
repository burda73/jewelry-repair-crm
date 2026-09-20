/**
 * Тесты областей видимости данных (дефект 65).
 *
 * ## Почему это отдельный файл
 *
 * Область видимости — не украшение роли, а фильтр, который добавляется к
 * КАЖДОМУ запросу списка и к загрузке карточки. Ошибка в нём не даёт ни
 * исключения, ни записи в журнале: список просто короче. Именно так и
 * случилось — приёмщик со второй ролью `LOGISTICIAN` (задача 7.7) перестал
 * видеть заказы собственного магазина, потому что система выбирала одну «самую
 * широкую» область, а области видимости НЕ вложены друг в друга.
 *
 * Здесь проверяются свойства самих функций, а сквозная проверка фильтра — в
 * `apps/api/src/common/prisma/prisma-scope.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  DATA_SCOPE,
  DEFAULT_ROLE_SCOPE,
  ROLE,
  SCOPE_PRIORITY,
  hasUnrestrictedScope,
  resolveDataScopes,
  scopesIncludeAny,
  widestDataScope,
} from './roles.js';

describe('Объединение областей видимости (дефект 65)', () => {
  it('сохраняет ВСЕ области, а не одну', () => {
    /*
     * Главное свойство. Приёмщик со второй ролью логиста обязан сохранить обе
     * области: магазинную (иначе он не видит принятые им заказы) и
     * производственную (иначе он не видит логистику).
     */
    expect(resolveDataScopes([DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH, DATA_SCOPE.PRODUCTION])).toEqual(
      [DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH, DATA_SCOPE.PRODUCTION],
    );
  });

  it('убирает повторы', () => {
    // Две роли могут иметь одинаковую область (приёмщик и кассир): дубликат в
    // фильтре дал бы лишнее условие в запросе без изменения результата.
    expect(resolveDataScopes([DATA_SCOPE.STORE, DATA_SCOPE.STORE])).toEqual([DATA_SCOPE.STORE]);
  });

  it('одна роль даёт ровно одну область', () => {
    expect(resolveDataScopes([DATA_SCOPE.PRODUCTION])).toEqual([DATA_SCOPE.PRODUCTION]);
  });

  it('пустой набор остаётся пустым (проверка «нет областей»)', () => {
    // Пустой набор трактуется вызывающим кодом как «запретить всё» (fail
    // closed). Функция не должна подменять его безопасной областью.
    expect(resolveDataScopes([])).toEqual([]);
  });

  it('неограниченная область распознаётся в наборе', () => {
    expect(hasUnrestrictedScope([DATA_SCOPE.ALL_STORES, DATA_SCOPE.STORE])).toBe(true);
    expect(hasUnrestrictedScope([DATA_SCOPE.READ_ALL])).toBe(true);
    expect(hasUnrestrictedScope([DATA_SCOPE.STORE, DATA_SCOPE.PRODUCTION])).toBe(false);
  });

  it('наличие любой из перечисленных областей определяется верно', () => {
    const scopes = [DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH, DATA_SCOPE.PRODUCTION];
    expect(scopesIncludeAny(scopes, [DATA_SCOPE.PRODUCTION])).toBe(true);
    expect(scopesIncludeAny(scopes, [DATA_SCOPE.ALL_STORES])).toBe(false);
  });
});

describe('Область видимости для отображения', () => {
  it('показывается самая широкая из имеющихся', () => {
    // В карточке сотрудника нужно одно значение. Для показа берётся самая
    // широкая, но ФИЛЬТРАЦИЯ по ней не идёт — в этом и был дефект 65.
    expect(widestDataScope([DATA_SCOPE.STORE, DATA_SCOPE.ALL_STORES])).toBe(DATA_SCOPE.ALL_STORES);
    expect(widestDataScope([DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH, DATA_SCOPE.PRODUCTION])).toBe(
      DATA_SCOPE.PRODUCTION,
    );
  });

  it('пустой набор даёт самую узкую область, а не самую широкую', () => {
    // Обратная ошибка была бы опасной: неизвестное состояние привело бы к
    // показу «видит всё».
    expect(widestDataScope([])).toBe(DATA_SCOPE.STORE);
  });

  it('порядок приоритета содержит все области ровно один раз', () => {
    /*
     * Приоритет — упорядоченный список, по которому выбирается «широкая»
     * область. Забытая в нём область сделала бы выбор произвольным, а
     * дубликат — недостижимой веткой.
     */
    const all = Object.values(DATA_SCOPE);
    expect([...SCOPE_PRIORITY].sort()).toEqual([...all].sort());
    expect(new Set(SCOPE_PRIORITY).size).toBe(SCOPE_PRIORITY.length);
  });

  it('PRODUCTION стоит ВЫШЕ магазинных областей — источник дефекта 65', () => {
    /*
     * Фиксируем причину дефекта явно. `PRODUCTION` в приоритете считается шире
     * магазинных областей, хотя на самом деле он их не включает: заказы
     * магазина в производственных статусах не находятся. Пока фильтрация шла
     * по одной области, приёмщик с ролью логиста получал `PRODUCTION` и терял
     * свои заказы. Тест объясняет, почему фильтрация обязана идти по набору.
     */
    expect(SCOPE_PRIORITY.indexOf(DATA_SCOPE.PRODUCTION)).toBeLessThan(
      SCOPE_PRIORITY.indexOf(DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH),
    );
    // И при этом PRODUCTION — не неограниченная область: он не открывает всё.
    expect(hasUnrestrictedScope([DATA_SCOPE.PRODUCTION])).toBe(false);
  });
});

describe('Области видимости ролей по умолчанию', () => {
  it('каждая роль имеет область', () => {
    for (const role of Object.values(ROLE)) {
      expect(DEFAULT_ROLE_SCOPE[role], `роль ${role} без области видимости`).toBeDefined();
    }
  });

  it('логист получает производственную область, приёмщик — магазинную', () => {
    /*
     * Именно это сочетание и породило дефект 65: у приёмщика, получившего
     * вторую роль `LOGISTICIAN`, набор областей становится
     * `[STORE_PLUS_GLOBAL_SEARCH, PRODUCTION]`, и обе должны работать
     * одновременно.
     */
    expect(DEFAULT_ROLE_SCOPE[ROLE.LOGISTICIAN]).toBe(DATA_SCOPE.PRODUCTION);
    expect(DEFAULT_ROLE_SCOPE[ROLE.RECEIVER]).toBe(DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH);

    const combined = resolveDataScopes([
      DEFAULT_ROLE_SCOPE[ROLE.RECEIVER],
      DEFAULT_ROLE_SCOPE[ROLE.LOGISTICIAN],
    ]);
    expect(combined).toContain(DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH);
    expect(combined).toContain(DATA_SCOPE.PRODUCTION);
  });
});
