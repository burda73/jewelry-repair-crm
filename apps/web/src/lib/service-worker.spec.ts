/**
 * Тесты Service Worker PWA (задача 1.7.5).
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ. Воркер может закэшировать данные клиента — и тогда на
 * общем компьютере торговой точки после выхода из системы следующий сотрудник
 * увидит чужой экран, а устаревший статус оплаты будет показан как актуальный.
 * Поэтому проверяются именно РЕШЕНИЯ ВОРКЕРА о том, что кэшировать нельзя, а не
 * факт наличия файла.
 *
 * `public/sw.js` — обычный скрипт, не модуль: он регистрирует обработчики через
 * `self.addEventListener`. Поэтому он исполняется в `vm` с поддельным `self`,
 * который записывает обработчики. Это позволяет вызвать `fetch`-обработчик и
 * проверить, перехватывает ли воркер запрос.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Handlers {
  install?: (event: unknown) => void;
  activate?: (event: unknown) => void;
  fetch?: (event: unknown) => void;
  message?: (event: unknown) => void;
}

let handlers: Handlers;

/** Поддельные кэши и сеть: нужны, чтобы проверить, ЧТО вернул воркер. */
let cachesMock: {
  open: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let fetchMock: ReturnType<typeof vi.fn>;

/** Загрузить sw.js и получить его обработчики. */
function loadWorker(): Handlers {
  const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
  const recorded: Handlers = {};

  const self = {
    location: { origin: 'https://repair.local' },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
    addEventListener: (type: keyof Handlers, handler: (event: unknown) => void) => {
      recorded[type] = handler;
    },
  };

  cachesMock = {
    open: vi.fn(async () => ({
      add: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      match: vi.fn(async () => undefined),
    })),
    keys: vi.fn(async () => []),
    match: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
  };
  fetchMock = vi.fn(async () => new Response('из сети', { status: 200 }));

  const context = vm.createContext({
    self,
    caches: cachesMock,
    fetch: fetchMock,
    Request: class {},
    Response,
    URL,
    Promise,
    console,
  });

  vm.runInContext(source, context);
  return recorded;
}

/** Вызвать обработчик `fetch` и узнать, перехватил ли он запрос. */
function intercepts(options: { url: string; method?: string; mode?: string }): boolean {
  let intercepted = false;
  const event = {
    request: {
      url: options.url,
      method: options.method ?? 'GET',
      mode: options.mode ?? 'no-cors',
    },
    respondWith: () => {
      intercepted = true;
    },
  };
  handlers.fetch?.(event);
  return intercepted;
}

/**
 * Вызвать обработчик `fetch` и получить ответ воркера.
 *
 * Нужно там, где важно не «перехватил ли», а ЧТО именно вернул: отдать данные
 * из кэша и сходить в сеть — разные ответы. Проверка одного факта перехвата
 * пропустила бы подмену сети кэшем.
 */
async function respond(options: {
  url: string;
  mode?: string;
  network?: () => Promise<Response>;
  cached?: Response | undefined;
}): Promise<Response> {
  let promise: Promise<Response> | undefined;
  const event = {
    request: {
      url: options.url,
      method: 'GET',
      mode: options.mode ?? 'no-cors',
    },
    respondWith: (value: Promise<Response>) => {
      promise = value;
    },
  };
  handlers.fetch?.(event);
  return promise!;
}

beforeEach(() => {
  handlers = loadWorker();
});

describe('Service Worker: запрет кэширования данных', () => {
  it('НЕ перехватывает запросы небезопасными методами', () => {
    // Ответ на POST зависит от тела запроса: кэш по URL вернул бы чужой
    // результат — например, ответ на создание другого заказа.
    expect(intercepts({ url: 'https://repair.local/api/v1/orders', method: 'POST' })).toBe(false);
    expect(intercepts({ url: 'https://repair.local/api/v1/orders/1', method: 'PATCH' })).toBe(
      false,
    );
    expect(intercepts({ url: 'https://repair.local/api/v1/orders/1', method: 'DELETE' })).toBe(
      false,
    );
  });

  it('НЕ перехватывает запросы к другим источникам', () => {
    // У чужого источника свои правила кэширования, и вмешиваться в них нельзя.
    expect(intercepts({ url: 'https://example.com/api/v1/orders' })).toBe(false);
  });
});

describe('Service Worker: что кэшируется', () => {
  it('перехватывает статику сборки', () => {
    // Имя файла содержит хэш содержимого, поэтому устаревание невозможно.
    expect(intercepts({ url: 'https://repair.local/_next/static/chunks/main.js' })).toBe(true);
    expect(intercepts({ url: 'https://repair.local/_next/static/css/app.css' })).toBe(true);
  });

  it('не перехватывает прочие GET-запросы', () => {
    // Всё, что не статика и не переход, идёт в сеть без вмешательства.
    expect(intercepts({ url: 'https://repair.local/favicon.ico' })).toBe(false);
    expect(intercepts({ url: 'https://repair.local/manifest.webmanifest' })).toBe(false);
  });
});

describe('Service Worker: жизненный цикл', () => {
  it('регистрирует все нужные обработчики', () => {
    expect(handlers.install).toBeTypeOf('function');
    expect(handlers.activate).toBeTypeOf('function');
    expect(handlers.fetch).toBeTypeOf('function');
    expect(handlers.message).toBeTypeOf('function');
  });

  it('регистрирует обработчик очистки кэша по сообщению', () => {
    // Вызывается при выходе из системы: правило «выход очищает устройство»
    // должно выполняться целиком.
    expect(handlers.message).toBeTypeOf('function');
  });

  it('обработчик очистки принимает сообщение и не падает', () => {
    const waits: Array<Promise<unknown>> = [];
    const event = {
      data: { type: 'clear-caches' },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    };

    expect(() => handlers.message?.(event)).not.toThrow();
    expect(waits).toHaveLength(1);
  });

  it('обработчик очистки игнорирует посторонние сообщения', () => {
    const waits: Array<Promise<unknown>> = [];
    const event = {
      data: { type: 'что-то-другое' },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    };

    handlers.message?.(event);

    expect(waits).toHaveLength(0);
  });
});

describe('Service Worker: что именно возвращается', () => {
  it('запрос API не перехватывается вовсе — он всегда идёт в сеть', () => {
    /*
     * Воркер не вмешивается в запросы API: их обрабатывает сеть напрямую.
     * Именно поэтому устаревший ответ не может быть показан как актуальный.
     * Если воркер когда-нибудь начнёт их перехватывать, тест упадёт — и это
     * правильный сигнал, потому что кэш данных клиента и денег недопустим.
     */
    expect(intercepts({ url: 'https://repair.local/api/v1/orders' })).toBe(false);
    expect(intercepts({ url: 'https://repair.local/api/v1/orders/1/payments' })).toBe(false);
    expect(intercepts({ url: 'https://repair.local/api/v1/customers?q=Иванов' })).toBe(false);
  });

  it('для перехода при доступной сети ответ берётся из сети, даже если страница есть в кэше', async () => {
    /*
     * Ключевая проверка. Если воркер начнёт отдавать HTML из кэша, на общем
     * компьютере торговой точки после выхода из системы следующий сотрудник
     * увидит чужой экран с ФИО и суммами. Поэтому кэш намеренно содержит
     * «чужую» страницу, а воркер обязан её проигнорировать и сходить в сеть.
     */
    cachesMock.match.mockResolvedValue(
      new Response('<html>чужая страница</html>', { status: 200 }),
    );
    fetchMock.mockResolvedValue(new Response('<html>свежая страница</html>', { status: 200 }));

    const response = await respond({
      url: 'https://repair.local/orders',
      mode: 'navigate',
    });

    expect(await response.text()).toBe('<html>свежая страница</html>');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('для перехода без сети возвращается заглушка, а не страница из кэша', async () => {
    /*
     * Самый важный случай. При отсутствии сети воркер НЕ должен доставать
     * страницу из кэша: в ней данные другого пользователя. Вместо неё
     * отдаётся offline.html.
     */
    fetchMock.mockRejectedValue(new Error('сеть недоступна'));
    const offline = new Response('<html>нет сети</html>', { status: 200 });
    cachesMock.open.mockResolvedValue({
      add: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      match: vi.fn(async (key: unknown) => {
        // Отдаём заглушку только для offline.html; любую страницу приложения —
        // ничего, чтобы воркер не смог её подставить.
        return String(key).includes('offline') ? offline : undefined;
      }),
    });

    const response = await respond({
      url: 'https://repair.local/orders',
      mode: 'navigate',
    });

    expect(await response.text()).toBe('<html>нет сети</html>');
  });

  it('для перехода без сети и без заглушки возвращается 503, а не чужая страница', async () => {
    fetchMock.mockRejectedValue(new Error('сеть недоступна'));
    cachesMock.open.mockResolvedValue({
      add: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      match: vi.fn(async () => undefined),
    });

    const response = await respond({
      url: 'https://repair.local/orders',
      mode: 'navigate',
    });

    expect(response.status).toBe(503);
  });

  it('статика берётся из кэша, если она там есть', async () => {
    // Обратная сторона: статика сборки неизменяема, её кэш безопасен и
    // позволяет приложению открыться без сети.
    const cached = new Response('статика из кэша', { status: 200 });
    cachesMock.match.mockResolvedValue(cached);

    const response = await respond({
      url: 'https://repair.local/_next/static/chunks/main.js',
    });

    expect(await response.text()).toBe('статика из кэша');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('отсутствующая в кэше статика загружается из сети и кладётся в кэш', async () => {
    cachesMock.match.mockResolvedValue(undefined);
    const put = vi.fn(async () => undefined);
    cachesMock.open.mockResolvedValue({
      add: vi.fn(async () => undefined),
      put,
      match: vi.fn(async () => undefined),
    });
    fetchMock.mockResolvedValue(new Response('свежая статика', { status: 200 }));

    const response = await respond({
      url: 'https://repair.local/_next/static/chunks/main.js',
    });

    expect(await response.text()).toBe('свежая статика');
    expect(put).toHaveBeenCalled();
  });

  it('ошибочный ответ статики в кэш не кладётся', async () => {
    // Сохранённая в кэш ошибка 404 сломала бы приложение и после обновления:
    // воркер отдавал бы её вместо файла.
    cachesMock.match.mockResolvedValue(undefined);
    const put = vi.fn(async () => undefined);
    cachesMock.open.mockResolvedValue({
      add: vi.fn(async () => undefined),
      put,
      match: vi.fn(async () => undefined),
    });
    fetchMock.mockResolvedValue(new Response('нет файла', { status: 404 }));

    await respond({ url: 'https://repair.local/_next/static/chunks/gone.js' });

    expect(put).not.toHaveBeenCalled();
  });
});

describe('Service Worker: конфигурация', () => {
  const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');

  it('версия кэша входит в его имя', () => {
    // Иначе на планшете годами лежала бы статика первой версии.
    expect(source).toMatch(/repair-shell-\$\{SW_VERSION\}/);
  });

  it('в предзагрузку входит только оболочка, без HTML страниц приложения', () => {
    // Страницы приложения содержат данные пользователя и в предзагрузку
    // попадать не должны.
    const match = source.match(/const PRECACHE_URLS = \[(.*?)\];/s);
    expect(match).not.toBeNull();
    const list = match![1]!;

    expect(list).toContain('OFFLINE_URL');
    expect(list).not.toContain("'/orders'");
    expect(list).not.toContain("'/dashboard'");
    expect(list).not.toContain("'/api");
  });

  it('при активации удаляются старые кэши приложения', () => {
    expect(source).toContain("name.startsWith('repair-')");
    expect(source).toContain('caches.delete');
  });
});

describe('PWA: файлы, на которые ссылается манифест', () => {
  /*
   * Манифест объявлял иконки, которых не было на диске (дефект 27): на проде
   * оба адреса отдавали 404, и приложение не устанавливалось на домашний
   * экран. Ошибка не видна ни в сборке, ни в дымовых проверках, потому что
   * ссылки манифеста никто не разрешает. Здесь это проверяется.
   */
  const publicDir = resolve(__dirname, '../../public');
  const manifest = JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8')) as {
    icons?: Array<{ src: string }>;
    start_url?: string;
  };

  it('иконки манифеста существуют', () => {
    expect(manifest.icons?.length).toBeGreaterThan(0);
    for (const icon of manifest.icons ?? []) {
      const path = resolve(publicDir, `.${icon.src}`);
      expect(existsSync(path), `нет файла иконки ${icon.src}`).toBe(true);
    }
  });

  it('каждая иконка непустая', () => {
    // Пустой файл браузер тоже считает негодным, а 404 и «0 байт» выглядят
    // одинаково в списке файлов.
    for (const icon of manifest.icons ?? []) {
      const path = resolve(publicDir, `.${icon.src}`);
      expect(statSync(path).size, `иконка ${icon.src} пуста`).toBeGreaterThan(0);
    }
  });

  it('все файлы предзагрузки Service Worker существуют', () => {
    // `cache.add` на отсутствующий файл молча ничего не положит, и оболочка
    // останется без заглушки — а именно она показывается без сети.
    for (const url of ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png']) {
      expect(existsSync(resolve(publicDir, `.${url}`)), `нет файла ${url}`).toBe(true);
    }
  });

  it('Service Worker лежит по адресу, который регистрирует приложение', () => {
    // Область действия воркера ограничена каталогом файла: переезд сломал бы
    // перехват запросов, причём без ошибки в интерфейсе.
    expect(existsSync(resolve(publicDir, 'sw.js'))).toBe(true);
  });
});
