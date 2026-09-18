/**
 * Тесты сохранённых представлений списка заказов (задача 1.7.4).
 *
 * ЧТО ПРОВЕРЯЕТСЯ И ПОЧЕМУ. Представление содержит фильтр по телефону клиента
 * или номеру заказа, то есть данные клиента, а компьютер на точке часто общий.
 * Ключевые правила, ошибка в которых приводит к утечке или к непредсказуемой
 * выборке:
 *
 *  * представления одного сотрудника не видны другому;
 *  * данные из хранилища — недоверенный ввод: неизвестные поля отбрасываются,
 *    а не уходят в запрос к API;
 *  * дубли по содержимому не создаются;
 *  * ссылка на один срез не подменяется другим.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SAVED_VIEWS,
  MAX_VIEW_NAME_LENGTH,
  VIEW_SCHEMA_VERSION,
  filtersEqual,
  hasAnyCondition,
  normalizeFilters,
  normalizeView,
  filtersToQuery,
  queryToFilters,
  readViews,
  writeViews,
  type SavedView,
} from './saved-views';
import type { OrderFilters } from './api-types';

class FakeStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const USER_A = 'cmu4cpwbg000bdl0ubltmh740';
const USER_B = 'cmu4cpwbg000bdl0ubltmh741';

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal('window', { localStorage: storage });
  // Идентификаторы представлений берутся из crypto, если он есть.
  vi.stubGlobal('crypto', { randomUUID: (): string => 'view-fixed-id' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeView(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: 'v1',
    name: 'Просроченные',
    filters: { overdue: true },
    search: '',
    createdAt: '2026-09-18T10:00:00.000Z',
    ...overrides,
  };
}

describe('Представления: чтение и запись', () => {
  it('сохраняет и читает представление', () => {
    writeViews(USER_A, [makeView()]);

    const views = readViews(USER_A);

    expect(views).toHaveLength(1);
    expect(views[0]?.name).toBe('Просроченные');
    expect(views[0]?.filters.overdue).toBe(true);
  });

  it('возвращает пустой список, когда ничего не сохранено', () => {
    expect(readViews(USER_A)).toEqual([]);
  });

  it('НЕ читает представления другого сотрудника', () => {
    // Общий компьютер: фильтр с телефоном клиента не должен открываться
    // у коллеги.
    writeViews(USER_B, [makeView({ name: 'Чужое' })]);

    expect(readViews(USER_A)).toEqual([]);
    expect(readViews(USER_B)).toHaveLength(1);
  });

  it('НЕ читает набор другой версии схемы', () => {
    storage.setItem(
      `repair:view:order-list:${USER_A}`,
      JSON.stringify({ version: VIEW_SCHEMA_VERSION + 1, items: [makeView()] }),
    );

    expect(readViews(USER_A)).toEqual([]);
  });

  it('НЕ падает на повреждённой записи', () => {
    storage.setItem(`repair:view:order-list:${USER_A}`, 'не json');

    expect(readViews(USER_A)).toEqual([]);
  });

  it('НЕ падает, когда localStorage недоступен', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('Storage недоступен');
      },
    });

    expect(() => readViews(USER_A)).not.toThrow();
    expect(readViews(USER_A)).toEqual([]);
  });

  it('пропускает записи без идентификатора или имени', () => {
    writeViews(USER_A, [] as SavedView[]);
    storage.setItem(
      `repair:view:order-list:${USER_A}`,
      JSON.stringify({
        version: VIEW_SCHEMA_VERSION,
        items: [{ name: 'Без id' }, { id: 'x', name: '' }, makeView()],
      }),
    );

    expect(readViews(USER_A)).toHaveLength(1);
  });

  it('ограничивает число представлений', () => {
    const many = Array.from({ length: MAX_SAVED_VIEWS + 5 }, (_, index) =>
      makeView({ id: `v${index}`, name: `Срез ${index}` }),
    );
    writeViews(USER_A, many);

    expect(readViews(USER_A)).toHaveLength(MAX_SAVED_VIEWS);
  });
});

describe('Представления: нормализация недоверенного ввода', () => {
  it('отбрасывает неизвестные поля фильтров', () => {
    // Иначе лишний параметр ушёл бы в запрос к API и дал непредсказуемую
    // выборку — вместо понятного «фильтр не применён».
    const filters = normalizeFilters({ overdue: true, неведомое: 'значение', ещё: 42 });

    expect(filters).toEqual({ overdue: true });
    expect(Object.keys(filters)).not.toContain('неведомое');
  });

  it('отбрасывает фильтры неверного типа', () => {
    const filters = normalizeFilters({
      overdue: 'да',
      isWarranty: 1,
      priority: 42,
      status: 'DRAFT',
    });

    expect(filters.overdue).toBeUndefined();
    expect(filters.isWarranty).toBeUndefined();
    expect(filters.priority).toBeUndefined();
    expect(filters.status).toBeUndefined();
  });

  it('оставляет только строковые статусы', () => {
    const filters = normalizeFilters({ status: ['DRAFT', 42, null, 'READY_FOR_PICKUP'] });

    expect(filters.status).toEqual(['DRAFT', 'READY_FOR_PICKUP']);
  });

  it('не оставляет пустой массив статусов', () => {
    // Пустой массив в запросе означал бы «ничего не показывать» вместо
    // «показать все» — разные вещи.
    expect(normalizeFilters({ status: [] }).status).toBeUndefined();
  });

  it('НЕ применяет черновик-представление другой версии вслепую', () => {
    const view = normalizeView({ ...makeView(), лишнее: true });

    expect(view).not.toBeNull();
    expect(Object.keys(view!)).not.toContain('лишнее');
  });

  it('обрезает слишком длинное название', () => {
    const view = normalizeView(makeView({ name: 'я'.repeat(200) }));

    expect(view?.name).toHaveLength(MAX_VIEW_NAME_LENGTH);
  });

  it('возвращает null на не-объекте', () => {
    expect(normalizeView(null)).toBeNull();
    expect(normalizeView('строка')).toBeNull();
    expect(normalizeView(42)).toBeNull();
  });
});

describe('Представления: сравнение срезов', () => {
  it('считает одинаковые срезы равными', () => {
    expect(filtersEqual({ overdue: true }, { overdue: true })).toBe(true);
  });

  it('не зависит от порядка статусов', () => {
    // Порядок выбора статусов не влияет на выборку, поэтому одно и то же
    // представление не должно считаться разным.
    expect(
      filtersEqual(
        { status: ['DRAFT', 'READY_FOR_PICKUP'] },
        { status: ['READY_FOR_PICKUP', 'DRAFT'] },
      ),
    ).toBe(true);
  });

  it('различает разные срезы', () => {
    expect(filtersEqual({ overdue: true }, { overdue: false })).toBe(false);
    expect(filtersEqual({ priority: 'HIGH' }, { priority: 'LOW' })).toBe(false);
    expect(filtersEqual({ priority: 'HIGH' }, {})).toBe(false);
  });

  it('различает срезы по строке поиска', () => {
    expect(filtersEqual({}, {}, '+79001112233', '+79001112233')).toBe(true);
    expect(filtersEqual({}, {}, '+79001112233', '+79004445566')).toBe(false);
    expect(filtersEqual({}, {}, '  заказ  ', 'заказ')).toBe(true);
  });

  it('считает отсутствие условия и явный false одинаковыми', () => {
    // `overdue: false` и отсутствие поля означают одно и то же — фильтр не
    // применён; иначе одно представление считалось бы двумя разными.
    expect(filtersEqual({ overdue: false }, {})).toBe(true);
  });
});

describe('Представления: что имеет смысл сохранять', () => {
  it('пустой срез не сохраняется', () => {
    // Представление «все заказы без фильтров» бесполезно: это и есть
    // исходный экран, а место в меню оно занимает.
    expect(hasAnyCondition({}, '')).toBe(false);
  });

  it('срез с любым условием сохраняется', () => {
    expect(hasAnyCondition({ overdue: true }, '')).toBe(true);
    expect(hasAnyCondition({}, 'заказ')).toBe(true);
    expect(hasAnyCondition({ status: ['DRAFT'] }, '')).toBe(true);
    expect(hasAnyCondition({ isWarranty: true }, '')).toBe(true);
    expect(hasAnyCondition({ priority: 'HIGH' }, '')).toBe(true);
  });

  it('пробелы в поиске не считаются условием', () => {
    expect(hasAnyCondition({}, '   ')).toBe(false);
  });
});

describe('Представления: сохранение и слияние', () => {
  it('новое представление встаёт в начало', () => {
    writeViews(USER_A, [makeView({ id: 'старое', name: 'Старое' })]);
    const views = readViews(USER_A);
    const next = [makeView({ id: 'новое', name: 'Новое' }), ...views];

    expect(next[0]?.name).toBe('Новое');
    expect(next).toHaveLength(2);
  });
});

describe('Представления: срез в адресе страницы', () => {
  it('переносит срез в адрес и обратно без потерь', () => {
    // Ссылку на срез передают коллеге: потеря по дороге означала бы, что
    // коллега видит не тот список, о котором его попросили.
    const filters: OrderFilters = {
      status: ['DRAFT', 'READY_FOR_PICKUP'],
      overdue: true,
      isWarranty: true,
      priority: 'HIGH',
    };
    const search = '+79001112233';

    const restored = queryToFilters(new URLSearchParams(filtersToQuery(filters, search)));

    expect(filtersEqual(restored.filters, filters, restored.search, search)).toBe(true);
    expect(restored.search).toBe(search);
  });

  it('НЕ пишет в адрес пустые условия', () => {
    // `?overdue=false` и отсутствие параметра значат одно и то же, но
    // захламляют ссылку.
    const query = filtersToQuery({ overdue: false, status: [] }, '');

    expect(query).toBe('');
  });

  it('отбрасывает неизвестные параметры адреса', () => {
    // Адрес правит пользователь: лишний параметр не должен уходить в API.
    const { filters } = queryToFilters(
      new URLSearchParams('overdue=true&неведомое=значение&drop=1'),
    );

    expect(filters).toEqual({ overdue: true });
  });

  it('пустая строка статуса не превращается в фильтр', () => {
    // Иначе `?status=` дал бы выборку «ничего» вместо «все».
    const { filters } = queryToFilters(new URLSearchParams('status='));

    expect(filters.status).toBeUndefined();
  });

  it('игнорирует overdue со значением, отличным от true', () => {
    const { filters } = queryToFilters(new URLSearchParams('overdue=1'));

    expect(filters.overdue).toBeUndefined();
  });

  it('обрезает пробелы в строке поиска', () => {
    const { search } = queryToFilters(new URLSearchParams('q=+%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7+'));

    expect(search).toBe('заказ');
  });
});
