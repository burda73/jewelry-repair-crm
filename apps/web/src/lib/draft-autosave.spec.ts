/**
 * Тесты автосохранения черновика (задача 1.7.3).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ЭТО ВАЖНО. Черновик заказа содержит ФИО и
 * телефон клиента, то есть персональные данные (152-ФЗ). На торговой точке
 * часто один общий компьютер, поэтому правила разделения и очистки черновиков —
 * не удобство, а требование:
 *
 *  * черновик одного сотрудника НЕ должен открываться у другого;
 *  * при выходе из системы черновики сотрудника удаляются;
 *  * черновик старше недели не восстанавливается;
 *  * черновик другой версии схемы не применяется вслепую.
 *
 * Хранилище подменяется минимальной реализацией: `jsdom` для этих проверок не
 * нужен, потому что проверяются чистые функции, а не рендеринг.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_MAX_AGE_MS,
  DRAFT_SCHEMA_VERSION,
  clearAllDraftsForUser,
  clearDraft,
  readDraft,
} from './draft-autosave';

/** Минимальная реализация Storage: те же методы, что использует код. */
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

  clear(): void {
    this.map.clear();
  }

  /** Для проверок: все ключи хранилища. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

const USER_A = 'cmu4cpwbg000bdl0ubltmh740';
const USER_B = 'cmu4cpwbg000bdl0ubltmh741';
const SCOPE = 'order-new';

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Записать черновик так, как это делает автосохранение. */
function putDraft(
  userId: string,
  data: unknown,
  options: { scope?: string; version?: number; savedAt?: Date } = {},
): void {
  storage.setItem(
    `repair:draft:${options.scope ?? SCOPE}:${userId}`,
    JSON.stringify({
      version: options.version ?? DRAFT_SCHEMA_VERSION,
      savedAt: (options.savedAt ?? new Date()).toISOString(),
      data,
    }),
  );
}

describe('Черновик: чтение', () => {
  it('возвращает сохранённые данные', () => {
    putDraft(USER_A, { step: 3, phone: '+79001112233' });

    const draft = readDraft<{ step: number; phone: string }>(SCOPE, USER_A);

    expect(draft?.data.step).toBe(3);
    expect(draft?.data.phone).toBe('+79001112233');
  });

  it('возвращает время сохранения', () => {
    /*
     * Дата берётся относительно «сейчас», а не жёстко: черновик старше
     * `DRAFT_MAX_AGE_MS` (7 дней) чтение отбрасывает, поэтому фиксированная дата
     * превращала тест в мину, срабатывающую через неделю после написания — так и
     * произошло с прежним значением `2026-09-18`.
     */
    const savedAt = new Date(Date.now() - 60_000);
    putDraft(USER_A, { step: 1 }, { savedAt });

    expect(readDraft(SCOPE, USER_A)?.savedAt.toISOString()).toBe(savedAt.toISOString());
  });

  it('возвращает null, когда черновика нет', () => {
    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });

  it('НЕ возвращает черновик другого сотрудника', () => {
    // Общий компьютер на точке: иначе приёмщик увидел бы ФИО и телефон
    // клиента, которого вёл коллега.
    putDraft(USER_B, { phone: '+79001112233' });

    expect(readDraft(SCOPE, USER_A)).toBeNull();
    expect(readDraft(SCOPE, USER_B)).not.toBeNull();
  });

  it('НЕ возвращает черновик другой формы', () => {
    putDraft(USER_A, { step: 1 }, { scope: 'other-form' });

    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });

  it('НЕ возвращает черновик старше недели', () => {
    // Недельной давности ввод почти наверняка потерял актуальность.
    const old = new Date(Date.now() - DRAFT_MAX_AGE_MS - 60_000);
    putDraft(USER_A, { step: 2 }, { savedAt: old });

    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });

  it('возвращает черновик на границе срока годности', () => {
    // Проверка, что условие именно «старше недели», а не «старше суток»:
    // иначе черновик терялся бы уже на следующий день.
    const recent = new Date(Date.now() - DRAFT_MAX_AGE_MS + 60_000);
    putDraft(USER_A, { step: 2 }, { savedAt: recent });

    expect(readDraft(SCOPE, USER_A)).not.toBeNull();
  });

  it('НЕ возвращает черновик другой версии схемы', () => {
    // После обновления приложения состав полей мог измениться: применять
    // старый черновик вслепую — значит получить форму с несуществующими полями.
    putDraft(USER_A, { step: 2 }, { version: DRAFT_SCHEMA_VERSION + 1 });

    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });

  it('НЕ падает на повреждённой записи', () => {
    storage.setItem(`repair:draft:${SCOPE}:${USER_A}`, 'не json');

    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });

  it('НЕ падает на записи без обязательных полей', () => {
    storage.setItem(
      `repair:draft:${SCOPE}:${USER_A}`,
      JSON.stringify({ version: DRAFT_SCHEMA_VERSION }),
    );

    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });

  it('НЕ падает на некорректной дате', () => {
    storage.setItem(
      `repair:draft:${SCOPE}:${USER_A}`,
      JSON.stringify({ version: DRAFT_SCHEMA_VERSION, savedAt: 'вчера', data: {} }),
    );

    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });

  it('НЕ падает, когда localStorage недоступен', () => {
    // Приватный режим браузера выбрасывает исключение на доступ к хранилищу:
    // форма обязана работать, просто без автосохранения.
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('Storage недоступен');
      },
    });

    expect(() => readDraft(SCOPE, USER_A)).not.toThrow();
    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });
});

describe('Черновик: удаление', () => {
  it('clearDraft удаляет черновик сотрудника', () => {
    putDraft(USER_A, { step: 1 });

    clearDraft(SCOPE, USER_A);

    expect(readDraft(SCOPE, USER_A)).toBeNull();
  });

  it('clearDraft НЕ трогает черновик другого сотрудника', () => {
    // Иначе создание заказа одним приёмщиком стирало бы незаконченный ввод
    // другого — на общем компьютере это потеря реальной работы.
    putDraft(USER_A, { step: 1 });
    putDraft(USER_B, { step: 2 });

    clearDraft(SCOPE, USER_A);

    expect(readDraft(SCOPE, USER_B)).not.toBeNull();
  });

  it('clearAllDraftsForUser удаляет ВСЕ черновики сотрудника', () => {
    // При выходе из системы: иначе следующий сотрудник получил бы предложение
    // восстановить чужой черновик с персональными данными клиента.
    putDraft(USER_A, { step: 1 });
    putDraft(USER_A, { step: 2 }, { scope: 'other-form' });

    clearAllDraftsForUser(USER_A);

    expect(readDraft(SCOPE, USER_A)).toBeNull();
    expect(readDraft('other-form', USER_A)).toBeNull();
  });

  it('clearAllDraftsForUser не удаляет чужие черновики', () => {
    putDraft(USER_A, { step: 1 });
    putDraft(USER_B, { step: 1 });

    clearAllDraftsForUser(USER_A);

    expect(readDraft(SCOPE, USER_B)).not.toBeNull();
  });

  it('clearAllDraftsForUser не трогает посторонние ключи хранилища', () => {
    // Префикс ключа уникален: иначе выход из системы чистил бы настройки
    // интерфейса или токены, хранящиеся рядом.
    storage.setItem('repair:theme', 'dark');
    storage.setItem(`repair:draft:${SCOPE}:${USER_A}`, 'x');

    clearAllDraftsForUser(USER_A);

    expect(storage.getItem('repair:theme')).toBe('dark');
  });

  it('clearAllDraftsForUser НЕ удаляет черновик сотрудника с похожим id', () => {
    // Идентификаторы куид-подобные; проверка «оканчивается на :userId» должна
    // не совпасть с другим пользователем, чей id заканчивается так же.
    putDraft(USER_A, { step: 1 });
    storage.setItem(`repair:draft:${SCOPE}:${USER_A}extra`, 'чужой');

    clearAllDraftsForUser(USER_A);

    expect(storage.getItem(`repair:draft:${SCOPE}:${USER_A}extra`)).toBe('чужой');
  });

  it('clearAllDraftsForUser не падает, когда хранилище недоступно', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('Storage недоступен');
      },
    });

    expect(() => clearAllDraftsForUser(USER_A)).not.toThrow();
  });

  it('удаление идемпотентно', () => {
    clearDraft(SCOPE, USER_A);
    clearDraft(SCOPE, USER_A);

    expect(storage.keys()).toEqual([]);
  });
});
