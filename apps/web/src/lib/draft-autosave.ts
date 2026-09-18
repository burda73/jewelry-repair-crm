'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Автосохранение черновика формы (задача 1.7.3).
 *
 * ЗАЧЕМ. Приёмщика может отвлечь клиент посреди оформления заказа: он уходит
 * на склад за изделием, отвечает на звонок, закрывает ноутбук. Без сохранения
 * введённые данные теряются, и заказ приходится начинать заново — при том что
 * на шаге 4 уже выбраны работы и посчитана сумма.
 *
 * ГДЕ ХРАНИТСЯ. `localStorage` браузера, ключ включает идентификатор
 * сотрудника. Это принципиально, а не деталь:
 *
 *  * на одной точке может быть один общий компьютер, и черновик одного
 *    приёмщика с ФИО и телефоном клиента не должен открываться у другого
 *    (ТЗ п. 2.4, 152-ФЗ). Ключ по `userId` это разделяет;
 *  * `sessionStorage` не годится: он умирает вместе с вкладкой, то есть ровно
 *    в том случае, когда приёмщик закрыл ноутбук и вернулся, — а это и есть
 *    основной сценарий;
 *  * на сервере черновик не хранится намеренно: незавершённый ввод не должен
 *    становиться сущностью БД. Заказ создаётся один раз и целиком, а мусорные
 *    `DRAFT`-заказы от брошенных форм — это уже другой класс проблем (их надо
 *    было бы чистить и отслеживать).
 *
 * ВЕРСИЯ СХЕМЫ. Черновик содержит номер версии формы. Если состав полей
 * изменится, старый черновик не будет применён вслепую: неподходящие данные
 * молча отбрасываются. Иначе после обновления приложения приёмщик получил бы
 * форму с полями, которых больше нет, и ошибки в неожиданных местах.
 *
 * СРОК ГОДНОСТИ. Черновик старше `MAX_AGE_MS` не восстанавливается: недельной
 * давности ввод почти наверняка потерял актуальность (клиент уже приходил или
 * отказался), и подстановка его в новую форму только запутала бы.
 */

/** Версия схемы черновика. Меняется при изменении состава полей формы. */
export const DRAFT_SCHEMA_VERSION = 1;

/** Черновик старше недели считается неактуальным. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Задержка автосохранения: приёмщик печатает, запись на каждую букву не нужна. */
const SAVE_DEBOUNCE_MS = 800;

interface StoredDraft<T> {
  version: number;
  savedAt: string;
  data: T;
}

/** Состояние восстановления, показываемое в интерфейсе. */
export interface RestorableDraft<T> {
  data: T;
  savedAt: Date;
}

function storageKey(scope: string, userId: string): string {
  return `repair:draft:${scope}:${userId}`;
}

/**
 * Прочитать черновик из localStorage.
 *
 * Любая ошибка чтения или разбора трактуется как «черновика нет»: хранилище
 * может быть недоступно (приватный режим выбрасывает исключение на доступ к
 * `localStorage`), а повреждённая запись не должна ломать форму.
 */
export function readDraft<T>(scope: string, userId: string): RestorableDraft<T> | null {
  try {
    const raw = window.localStorage.getItem(storageKey(scope, userId));
    if (raw === null) return null;

    const parsed = JSON.parse(raw) as Partial<StoredDraft<T>>;
    if (parsed.version !== DRAFT_SCHEMA_VERSION) return null;
    if (typeof parsed.savedAt !== 'string' || parsed.data === undefined) return null;

    const savedAt = new Date(parsed.savedAt);
    if (Number.isNaN(savedAt.getTime())) return null;
    if (Date.now() - savedAt.getTime() > DRAFT_MAX_AGE_MS) return null;

    return { data: parsed.data, savedAt };
  } catch {
    return null;
  }
}

/** Удалить черновик. Вызывается после успешного создания заказа и при выходе. */
export function clearDraft(scope: string, userId: string): void {
  try {
    window.localStorage.removeItem(storageKey(scope, userId));
  } catch {
    // Хранилище недоступно — удалять нечего.
  }
}

/**
 * Удалить ВСЕ черновики сотрудника, независимо от области (`scope`).
 *
 * Нужно при выходе из системы: иначе на общем компьютере следующий сотрудник
 * получил бы предложение восстановить чужой черновик с персональными данными
 * клиента. Перечислять области по именам нельзя — новая форма была бы
 * пропущена, поэтому ключи перебираются по префиксу сотрудника.
 */
export function clearAllDraftsForUser(userId: string): void {
  try {
    const suffix = `:${userId}`;
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key !== null && key.startsWith('repair:draft:') && key.endsWith(suffix)) {
        keys.push(key);
      }
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Хранилище недоступно — чистить нечего.
  }
}

/**
 * Автосохранение черновика.
 *
 * Возвращает:
 *  * `restorable` — найденный при открытии формы черновик (или `null`);
 *  * `savedAt` — время последнего сохранения (для подписи «сохранено в …»);
 *  * `dismiss` — «начать заново»: удаляет черновик и скрывает предложение;
 *  * `forget` — забыть черновик (после успешного создания заказа).
 *
 * ЧЕРНОВИК НЕ ВОССТАНАВЛИВАЕТСЯ АВТОМАТИЧЕСКИ. Форма открывается пустой, а
 * найденный черновик показывается отдельным предложением с временем сохранения.
 * Иначе приёмщик, начавший новый заказ через день, увидел бы в форме данные
 * прошлого клиента и мог принять новый заказ на чужое изделие — молчаливая
 * подстановка здесь опаснее потери черновика.
 *
 * @param scope   область черновика (например, `order-new`)
 * @param userId  сотрудник: разделяет черновики на общем компьютере
 * @param snapshot текущее состояние формы; `null` — сохранять нечего
 * @param enabled включено ли сохранение (например, после создания заказа — нет)
 */
export function useDraftAutosave<T>(params: {
  scope: string;
  userId: string | null;
  snapshot: T | null;
  enabled: boolean;
}): {
  restorable: RestorableDraft<T> | null;
  savedAt: Date | null;
  dismiss: () => void;
  forget: () => void;
} {
  const { scope, userId, snapshot, enabled } = params;

  const [restorable, setRestorable] = useState<RestorableDraft<T> | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  /*
   * Проверка найденного черновика выполняется ОДИН раз при появлении
   * пользователя. Если бы она выполнялась на каждое изменение `snapshot`,
   * то после первого же автосохранения предложение «восстановить» появлялось
   * бы снова — то есть форма предлагала бы восстановить то, что пользователь
   * только что ввёл сам.
   */
  const checkedFor = useRef<string | null>(null);
  useEffect(() => {
    if (userId === null) {
      checkedFor.current = null;
      setRestorable(null);
      setSavedAt(null);
      return;
    }
    if (checkedFor.current === userId) return;
    checkedFor.current = userId;
    setRestorable(readDraft<T>(scope, userId));
  }, [scope, userId]);

  /*
   * Сохранение с задержкой. Зависимость — сериализованный снимок: сравнивать
   * объект по ссылке бессмысленно, он новый на каждый рендер, и запись шла бы
   * постоянно. Сериализация также отсекает сохранение, когда ничего не
   * изменилось.
   */
  const serialized = snapshot === null ? null : safeStringify(snapshot);
  useEffect(() => {
    if (!enabled || userId === null || serialized === null) return;
    const timer = window.setTimeout(() => {
      try {
        const payload: StoredDraft<unknown> = {
          version: DRAFT_SCHEMA_VERSION,
          savedAt: new Date().toISOString(),
          data: JSON.parse(serialized) as unknown,
        };
        window.localStorage.setItem(storageKey(scope, userId), JSON.stringify(payload));
        setSavedAt(new Date(payload.savedAt));
      } catch {
        // Переполнение хранилища или приватный режим: форма продолжает
        // работать, автосохранение просто не срабатывает.
      }
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [scope, userId, serialized, enabled]);

  const dismiss = useCallback(() => {
    if (userId !== null) clearDraft(scope, userId);
    setRestorable(null);
  }, [scope, userId]);

  const forget = useCallback(() => {
    if (userId !== null) clearDraft(scope, userId);
    setRestorable(null);
    setSavedAt(null);
  }, [scope, userId]);

  return { restorable, savedAt, dismiss, forget };
}

/**
 * Сериализация снимка.
 *
 * `JSON.stringify` выбрасывает исключение на циклических ссылках, а снимок
 * формы собирается из состояния и справочников — там легко получить цикл
 * (например, объект клиента со вложенным заказом). Возврат `null` означает
 * «сохранять нечего», а не «сохранить пустоту».
 */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
