/*
 * Service Worker PWA (задача 1.7.5).
 *
 * ГЛАВНОЕ РЕШЕНИЕ: что НЕ кэшируется.
 *
 * Это CRM с персональными данными клиентов и деньгами, работающая на общем
 * компьютере торговой точки. Наивное «кэшировать всё» здесь опаснее отсутствия
 * кэша, поэтому запрещено кэшировать:
 *
 *  1. Ответы API (`/api/`). Устаревший статус заказа или неподтверждённая
 *     оплата, показанные как актуальные, — прямой путь к выдаче изделия без
 *     денег. Сеть для API обязательна; при её отсутствии экран честно сообщает
 *     об ошибке.
 *  2. HTML-страницы приложения. Они отрисованы с данными конкретного
 *     пользователя (ФИО клиента, суммы). Кэш страницы на общем компьютере
 *     означал бы, что после выхода из системы следующий сотрудник увидит
 *     чужой экран (152-ФЗ).
 *
 * Кэшируется только ОБОЛОЧКА: статика сборки с хэшем в имени и иконки. Это
 * позволяет приложению открыться при кратком пропадании сети, но не подменяет
 * данные устаревшими.
 *
 * Версия кэша в имени (`SHELL_CACHE`) означает, что новая сборка получает новый
 * кэш, а старый удаляется при активации: иначе на планшете годами лежала бы
 * статика первой версии.
 */

const SW_VERSION = 'v1';

/** Кэш оболочки. Имя содержит версию: новая сборка — новый кэш. */
const SHELL_CACHE = `repair-shell-${SW_VERSION}`;

/** Страница, показываемая, когда сеть недоступна, а страницы в кэше нет. */
const OFFLINE_URL = '/offline.html';

/**
 * Что кладём в кэш при установке.
 *
 * Только статические файлы без данных: страница-заглушка и иконки. Разметка
 * приложения (HTML страниц) сюда не входит намеренно — см. комментарий выше.
 */
const PRECACHE_URLS = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      /*
       * `addAll` падает целиком, если хотя бы один файл недоступен, и тогда
       * воркер не установится вовсе — приложение осталось бы без PWA из-за
       * одной отсутствующей иконки. Поэтому файлы кладутся по одному.
       */
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            // Файл недоступен — оболочка обойдётся без него.
          }
        }),
      );
      // Новый воркер начинает работать сразу, не дожидаясь закрытия вкладок:
      // иначе исправление в кэше не доехало бы до приёмщика до конца смены.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      /*
       * Удаляем все кэши, кроме текущего. Это убирает и старые версии
       * оболочки, и — что важнее — любые кэши, оставшиеся от предыдущих
       * версий воркера, которые могли кэшировать данные.
       */
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('repair-') && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  /*
   * Очистка по требованию страницы. Вызывается при выходе из системы:
   * после выхода на общем компьютере не должно остаться ничего, что воркер
   * мог бы отдать следующему сотруднику.
   */
  if (event.data === 'clear-caches' || event.data?.type === 'clear-caches') {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(
          names.filter((name) => name.startsWith('repair-')).map((name) => caches.delete(name)),
        );
      })(),
    );
  }
});

/** Запрос к API — данные клиента и денег. Кэш запрещён. */
function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

/** Статика сборки Next.js: имя содержит хэш содержимого, поэтому неизменяема. */
function isImmutableAsset(url) {
  return url.pathname.startsWith('/_next/static/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Кэшируем и перехватываем только безопасные методы: ответ на POST/PATCH
  // зависит от тела запроса, и кэш по URL вернул бы чужой результат.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Чужие источники (если появятся) не перехватываем: у них свои правила.
  if (url.origin !== self.location.origin) return;

  /*
   * API — только сеть. Ни `cache-first`, ни `stale-while-revalidate`: показать
   * устаревший статус оплаты как актуальный нельзя. При отсутствии сети запрос
   * отклоняется, и интерфейс показывает ошибку загрузки.
   */
  if (isApiRequest(url)) return;

  /*
   * Статика сборки — из кэша, с дозагрузкой в фоне. Здесь устаревание
   * невозможно: имя файла содержит хэш содержимого.
   */
  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached !== undefined) return cached;

        const response = await fetch(request);
        /*
         * Кладём в кэш только успешный ответ: `opaque` или ошибка 404,
         * сохранённые как файл, сломали бы приложение после обновления.
         */
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  /*
   * Переходы между страницами и остальные запросы — только сеть, с заглушкой
   * при её отсутствии. HTML страниц не кэшируется: он содержит данные
   * пользователя (см. комментарий в начале файла).
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const offline = await cache.match(OFFLINE_URL);
          return (
            offline ??
            new Response('Нет подключения к сети', {
              status: 503,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
          );
        }
      })(),
    );
  }
});
