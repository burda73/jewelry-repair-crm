/**
 * Тесты поиска партии по отсканированному коду (задача 2.7).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Номер партии — кириллический (`П-250916-001`), а код из
 * QR-кода заказа — URI (`repair://order/MSK1-2609-000001`). Оба значения уходят
 * в строку запроса, и оба содержат символы, которые нельзя передавать как есть:
 * кириллица требует процентного кодирования, а `//` и `:` исказят путь.
 *
 * Ошибка здесь не выглядит как ошибка: сервер получит обрезанный или
 * перекодированный код и ответит «партия не найдена». Курьер решит, что
 * наклейка стёрлась, и будет сканировать снова — вместо того чтобы получить
 * свой рейс. Проверяется именно то, что уходит на сервер.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** Ответ сервера: минимальная партия, достаточная для разбора. */
const BATCH = {
  id: 'b-1',
  batchNo: 'П-250916-001',
  direction: 'TO_PRODUCTION',
  status: 'IN_TRANSIT',
  items: [],
};

/** Подменить `fetch` и вернуть перехваченный URL. */
function stubFetch(captured: { url?: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      captured.url = url;
      return new Response(JSON.stringify(BATCH), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Поиск партии по скану: кодирование запроса (задача 2.7)', () => {
  it('кириллический номер партии кодируется', async () => {
    // «П» — не ASCII: без кодирования сервер получит её как есть, и в HTTP-строке
    // это либо ошибка, либо искажённый символ.
    const captured: { url?: string } = {};
    stubFetch(captured);
    const { findBatchByScan } = await import('./queries');
    await findBatchByScan('П-250916-001');
    expect(captured.url).toBeDefined();
    const url = captured.url as string;
    expect(url).toContain('/batches/scan');
    // Кириллица уходит в процентном виде, а не сырыми байтами.
    expect(url).toContain('%D0%9F');
    expect(url).not.toContain('П');
  });

  it('URI из QR-кода заказа не ломает путь запроса', async () => {
    /*
     * `repair://order/MSK1-…` содержит `//` и `:`. Если передать его без
     * кодирования, путь запроса станет `/batches/scan?code=repair://order/…`, и
     * серверная часть пути будет разобрана неверно.
     */
    const captured: { url?: string } = {};
    stubFetch(captured);
    const { findBatchByScan } = await import('./queries');

    await findBatchByScan('repair://order/MSK1-2609-000001');

    const url = captured.url as string;
    expect(url).toContain('/batches/scan?code=');
    // Слэши внутри значения закодированы: иначе они попали бы в путь.
    expect(url.split('?')[1]).not.toContain('/');
    expect(url).toContain('%2F%2F');
  });

  it('код уходит ровно один раз, в параметре code', async () => {
    // Дубль параметра (`code=a&code=b`) сервер прочитает как первый, и поиск
    // вернёт не тот рейс.
    const captured: { url?: string } = {};
    stubFetch(captured);
    const { findBatchByScan } = await import('./queries');

    await findBatchByScan('П-250916-004');

    const query = (captured.url as string).split('?')[1] ?? '';
    expect(query.match(/code=/g)?.length).toBe(1);
  });

  it('перевод строки сканера не попадает в запрос как разрыв', async () => {
    /*
     * USB-сканер завершает ввод переводом строки. Он должен уехать
     * закодированным: сырой перевод строки в URL — это либо ошибка, либо начало
     * новой строки HTTP-запроса.
     */
    const captured: { url?: string } = {};
    stubFetch(captured);
    const { findBatchByScan } = await import('./queries');

    await findBatchByScan('П-250916-001\n');

    expect(captured.url).not.toContain('\n');
  });
});
