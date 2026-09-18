'use client';

import { useCallback, useMemo, useState } from 'react';
import type { OrderFilters } from '@/lib/api-types';
import { readJson, userStorageKey, writeJson } from './user-storage';

/**
 * Сохранённые представления списка заказов (задача 1.7.4).
 *
 * ЗАЧЕМ. Приёмщик, руководитель и мастер смотрят на одни и те же заказы, но
 * разными срезами: приёмщик — «мои новые за сегодня», руководитель —
 * «просроченные», мастер — «в работе». Каждый раз выставлять фильтры заново
 * долго, а фильтров четыре плюс поиск.
 *
 * ГДЕ ХРАНЯТСЯ. В браузере, под ключом сотрудника. На сервере представления
 * намеренно не хранятся:
 *
 *  * состав фильтров — вопрос удобства, а не бизнес-правило; таблица ради него
 *    не оправдана;
 *  * представления содержат телефон или номер заказа в фильтре, то есть
 *    данные клиента, — на общем компьютере они не должны открываться у другого
 *    (152-ФЗ). Ключ по `userId` это разделяет, очистка — при выходе.
 *
 * Ссылку с представлением можно передать коллеге: набор фильтров лежит в
 * адресе страницы (`?status=...&overdue=true`). Это и есть причина хранить
 * представления как фильтры, а не как «идентификатор сохранённого поиска».
 *
 * СХЕМА ВЕРСИОНИРУЕТСЯ. Если состав фильтров изменится, старые представления
 * не применяются вслепую: иначе представление с исчезнувшим полем дало бы
 * непонятный результат вместо ошибки.
 */

/** Версия схемы сохранённых представлений. Меняется при изменении состава. */
export const VIEW_SCHEMA_VERSION = 1;

/** Сколько представлений допускается на сотрудника. */
export const MAX_SAVED_VIEWS = 20;

/** Максимальная длина названия представления. */
export const MAX_VIEW_NAME_LENGTH = 40;

/** Сохранённое представление. */
export interface SavedView {
  /** Устойчивый идентификатор внутри набора сотрудника. */
  id: string;
  name: string;
  filters: OrderFilters;
  /** Строка поиска: сохраняется вместе с фильтрами, это часть среза. */
  search: string;
  createdAt: string;
}

interface StoredViews {
  version: number;
  items: SavedView[];
}

const SCOPE = 'order-list';

/**
 * Идентификатор представления.
 *
 * `crypto.randomUUID` доступен не во всех браузерах конторских компьютеров,
 * поэтому есть запасной вариант. Идентификатор нужен лишь для различения
 * записей внутри одного браузера, криптостойкость не требуется.
 */
function newId(): string {
  const cryptoApi = typeof crypto === 'undefined' ? undefined : crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Проверить и нормализовать прочитанное представление.
 *
 * Данные из хранилища — недоверенный ввод: их мог записать прежний (или
 * другой) пользователь того же браузера, а состав фильтров с тех пор мог
 * измениться. Неизвестные поля отбрасываются, а не пробрасываются в запрос
 * к API: лишний параметр в адресе привёл бы к непредсказуемой выборке.
 */
export function normalizeView(raw: unknown): SavedView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<SavedView>;
  if (typeof candidate.id !== 'string' || candidate.id === '') return null;
  if (typeof candidate.name !== 'string' || candidate.name === '') return null;

  const filters = normalizeFilters(candidate.filters);

  return {
    id: candidate.id,
    name: candidate.name.slice(0, MAX_VIEW_NAME_LENGTH),
    filters,
    search: typeof candidate.search === 'string' ? candidate.search : '',
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
  };
}

/**
 * Нормализовать фильтры списка.
 *
 * Проверяются и типы, и состав: поле, которого больше нет в `OrderFilters`,
 * в объект не попадает.
 */
export function normalizeFilters(raw: unknown): OrderFilters {
  if (typeof raw !== 'object' || raw === null) return {};
  const input = raw as Record<string, unknown>;

  const filters: OrderFilters = {};

  if (Array.isArray(input.status)) {
    const statuses = input.status.filter((value): value is string => typeof value === 'string');
    if (statuses.length > 0) filters.status = statuses as OrderFilters['status'];
  }
  if (Array.isArray(input.storeId)) {
    const stores = input.storeId.filter((value): value is string => typeof value === 'string');
    if (stores.length > 0) filters.storeId = stores;
  }
  if (input.overdue === true) filters.overdue = true;
  if (input.isWarranty === true) filters.isWarranty = true;
  if (typeof input.priority === 'string' && input.priority !== '') {
    filters.priority = input.priority;
  }
  if (typeof input.orderNo === 'string' && input.orderNo !== '') filters.orderNo = input.orderNo;
  if (typeof input.customerPhone === 'string' && input.customerPhone !== '') {
    filters.customerPhone = input.customerPhone;
  }

  return filters;
}

/** Прочитать набор представлений сотрудника. */
export function readViews(userId: string): SavedView[] {
  const stored = readJson<Partial<StoredViews>>(userStorageKey('view', SCOPE, userId));
  if (stored === null || stored.version !== VIEW_SCHEMA_VERSION) return [];
  if (!Array.isArray(stored.items)) return [];
  return stored.items
    .map(normalizeView)
    .filter((view): view is SavedView => view !== null)
    .slice(0, MAX_SAVED_VIEWS);
}

export function writeViews(userId: string, items: SavedView[]): void {
  const payload: StoredViews = { version: VIEW_SCHEMA_VERSION, items };
  writeJson(userStorageKey('view', SCOPE, userId), payload);
}

/**
 * Сравнить фильтры на равенство.
 *
 * Нужно, чтобы понять, соответствует ли текущий срез какому-то представлению,
 * и чтобы не создавать второе представление с тем же содержимым под другим
 * именем. Сравнение по значимым полям, а не по `JSON.stringify`: порядок
 * ключей в объекте не определён, и строковое сравнение давало бы ложные
 * расхождения.
 */
export function filtersEqual(
  a: OrderFilters,
  b: OrderFilters,
  searchA = '',
  searchB = '',
): boolean {
  if (searchA.trim() !== searchB.trim()) return false;

  const statusesA = [...(a.status ?? [])].sort().join(',');
  const statusesB = [...(b.status ?? [])].sort().join(',');
  if (statusesA !== statusesB) return false;

  const storesA = [...(a.storeId ?? [])].sort().join(',');
  const storesB = [...(b.storeId ?? [])].sort().join(',');
  if (storesA !== storesB) return false;

  if ((a.overdue === true) !== (b.overdue === true)) return false;
  if ((a.isWarranty === true) !== (b.isWarranty === true)) return false;
  if ((a.priority ?? '') !== (b.priority ?? '')) return false;
  if ((a.orderNo ?? '') !== (b.orderNo ?? '')) return false;
  if ((a.customerPhone ?? '') !== (b.customerPhone ?? '')) return false;

  return true;
}

/** Есть ли в срезе хоть что-то, что имеет смысл сохранять. */
export function hasAnyCondition(filters: OrderFilters, search: string): boolean {
  return (
    search.trim() !== '' ||
    (filters.status?.length ?? 0) > 0 ||
    (filters.storeId?.length ?? 0) > 0 ||
    filters.overdue === true ||
    filters.isWarranty === true ||
    (filters.priority ?? '') !== '' ||
    (filters.orderNo ?? '') !== '' ||
    (filters.customerPhone ?? '') !== ''
  );
}

/**
 * Сохранённые представления сотрудника.
 *
 * Возвращает список, признак «загружено» и операции. `loaded` нужен, чтобы не
 * мигать пустым списком до чтения из хранилища: чтение синхронное, но
 * происходит в эффекте, то есть после первого рендера.
 */
export function useSavedViews(userId: string | null): {
  views: SavedView[];
  loaded: boolean;
  save: (name: string, filters: OrderFilters, search: string) => SavedView | null;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
} {
  const [views, setViews] = useState<SavedView[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  /*
   * Чтение выполняется в рендере, а не в эффекте: так список представлений
   * появляется сразу, без промежуточного кадра с пустым меню. Побочных
   * эффектов у чтения нет — только `localStorage`.
   */
  const current = useMemo(() => {
    if (userId === null) return [];
    return readViews(userId);
  }, [userId]);

  /*
   * Синхронизация состояния с прочитанным. Сравнение по сотруднику, а не по
   * содержимому: иначе запись представления (которая сама меняет `current`)
   * немедленно перезаписывала бы состояние прочитанным и отменяла изменение.
   */
  if (userId !== null && loadedFor !== userId) {
    setLoadedFor(userId);
    setViews(current);
  } else if (userId === null && loadedFor !== null) {
    setLoadedFor(null);
    setViews([]);
  }

  const persist = useCallback(
    (next: SavedView[]) => {
      if (userId === null) return;
      writeViews(userId, next);
      setViews(next);
    },
    [userId],
  );

  const save = useCallback(
    (name: string, filters: OrderFilters, search: string): SavedView | null => {
      if (userId === null) return null;
      const trimmed = name.trim().slice(0, MAX_VIEW_NAME_LENGTH);
      if (trimmed === '') return null;

      const view: SavedView = {
        id: newId(),
        name: trimmed,
        filters: normalizeFilters(filters),
        search: search.trim(),
        createdAt: new Date().toISOString(),
      };

      /*
       * Новое представление встаёт в начало: последнее сохранённое — самое
       * нужное. Дубли по содержимому не создаются, иначе в меню появились бы
       * две одинаковые записи с разными именами.
       */
      const others = views.filter(
        (existing) => !filtersEqual(existing.filters, view.filters, existing.search, view.search),
      );
      const next = [view, ...others].slice(0, MAX_SAVED_VIEWS);
      persist(next);
      return view;
    },
    [userId, views, persist],
  );

  const remove = useCallback(
    (id: string) => {
      persist(views.filter((view) => view.id !== id));
    },
    [views, persist],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim().slice(0, MAX_VIEW_NAME_LENGTH);
      if (trimmed === '') return;
      persist(views.map((view) => (view.id === id ? { ...view, name: trimmed } : view)));
    },
    [views, persist],
  );

  return { views, loaded: loadedFor === userId && userId !== null, save, remove, rename };
}

// ---------------------------------------------------------------------------
// Срез в адресе страницы
// ---------------------------------------------------------------------------

/**
 * Собрать параметры адреса из фильтров.
 *
 * ЗАЧЕМ. Ссылку на срез нужно передать коллеге: «посмотри просроченные по
 * первому магазину». Без этого представления остаются личными и помогают
 * только своему автору, а руководитель не может отправить срез мастеру.
 *
 * Пустые условия в адрес не попадают: `?overdue=false` и отсутствие параметра
 * означают одно и то же, но захламляют ссылку и ломают сравнение срезов.
 */
export function filtersToQuery(filters: OrderFilters, search: string): string {
  const params = new URLSearchParams();

  if (search.trim() !== '') params.set('q', search.trim());
  if ((filters.status?.length ?? 0) > 0) params.set('status', filters.status!.join(','));
  if ((filters.storeId?.length ?? 0) > 0) params.set('storeId', filters.storeId!.join(','));
  if (filters.overdue === true) params.set('overdue', 'true');
  if (filters.isWarranty === true) params.set('isWarranty', 'true');
  if ((filters.priority ?? '') !== '') params.set('priority', filters.priority!);
  if ((filters.orderNo ?? '') !== '') params.set('orderNo', filters.orderNo!);
  if ((filters.customerPhone ?? '') !== '') params.set('customerPhone', filters.customerPhone!);

  return params.toString();
}

/**
 * Разобрать фильтры из параметров адреса.
 *
 * Значения приходят из адресной строки, то есть являются недоверенным вводом:
 * ссылку мог отредактировать пользователь. Поэтому вместо разбора «как есть»
 * строится объект, который затем проходит ту же нормализацию, что и
 * представления из хранилища, — набор допустимых полей один и тот же.
 */
export function queryToFilters(params: URLSearchParams): {
  filters: OrderFilters;
  search: string;
} {
  const splitList = (value: string | null): string[] | undefined => {
    if (value === null) return undefined;
    const items = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    return items.length === 0 ? undefined : items;
  };

  const raw: Record<string, unknown> = {
    status: splitList(params.get('status')),
    storeId: splitList(params.get('storeId')),
    overdue: params.get('overdue') === 'true' ? true : undefined,
    isWarranty: params.get('isWarranty') === 'true' ? true : undefined,
    priority: params.get('priority') ?? undefined,
    orderNo: params.get('orderNo') ?? undefined,
    customerPhone: params.get('customerPhone') ?? undefined,
  };

  return { filters: normalizeFilters(raw), search: (params.get('q') ?? '').trim() };
}
