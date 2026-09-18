'use client';

/**
 * Хранилище данных, привязанных к сотруднику (задачи 1.7.3, 1.7.4).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Черновики форм и сохранённые представления списка
 * хранятся в браузере и содержат данные клиента (ФИО, телефон в фильтре).
 * На торговой точке часто один общий компьютер, поэтому у обоих наборов одно и
 * то же требование: ключ включает идентификатор сотрудника, а при выходе из
 * системы данные сотрудника удаляются (152-ФЗ).
 *
 * Логика перебора ключей по префиксу нетривиальна (именно она защищает от
 * удаления чужих данных), поэтому она живёт в одном месте: копия в каждом
 * модуле рано или поздно разошлась бы, и одна из копий удаляла бы лишнее.
 */

/** Общий префикс всех ключей приложения в localStorage. */
export const STORAGE_ROOT = 'repair:';

/**
 * Ключ хранилища.
 *
 * Формат: `repair:<область>:<подобласть>:<сотрудник>`.
 *
 * @param area   область (`draft`, `view`)
 * @param scope  подобласть внутри области (например, `order-new`, `order-list`)
 * @param userId сотрудник
 */
export function userStorageKey(area: string, scope: string, userId: string): string {
  return `${STORAGE_ROOT}${area}:${scope}:${userId}`;
}

/**
 * Удалить ВСЕ записи области для сотрудника, независимо от подобласти.
 *
 * Перечислять подобласти по именам нельзя: новая форма или новый список,
 * добавленные позже, не попали бы в список и остались бы на диске. Поэтому
 * ключи перебираются по префиксу области и суффиксу сотрудника.
 *
 * Проверка суффикса — именно `:${userId}` целиком: без ведущего двоеточия
 * ключ сотрудника `abc` совпал бы с ключом сотрудника `xabc`.
 */
export function clearAreaForUser(area: string, userId: string): void {
  try {
    const areaPrefix = `${STORAGE_ROOT}${area}:`;
    const userSuffix = `:${userId}`;
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key !== null && key.startsWith(areaPrefix) && key.endsWith(userSuffix)) {
        keys.push(key);
      }
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Хранилище недоступно (приватный режим) — чистить нечего.
  }
}

/**
 * Удалить все браузерные данные сотрудника во всех областях.
 *
 * Вызывается при выходе из системы: иначе следующий сотрудник на общем
 * компьютере увидел бы чужие данные клиента.
 */
export function clearAllForUser(userId: string): void {
  clearAreaForUser('draft', userId);
  clearAreaForUser('view', userId);
}

/**
 * Прочитать и разобрать JSON из localStorage.
 *
 * Возвращает `null` при любой проблеме: хранилище недоступно, записи нет,
 * запись повреждена. Повреждённые данные не должны ломать экран — это
 * пользовательские настройки, а не источник истины.
 */
export function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Записать JSON в localStorage. Ошибка записи не прерывает работу экрана. */
export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Переполнение хранилища или приватный режим: настройки просто не сохранятся.
  }
}
