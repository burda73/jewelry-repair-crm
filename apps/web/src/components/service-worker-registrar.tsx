'use client';

import { useEffect } from 'react';

/**
 * Регистрация Service Worker (задача 1.7.5).
 *
 * ЗАЧЕМ. Воркер кэширует статику сборки, поэтому приложение открывается при
 * кратком пропадании сети — на торговой точке это обычная ситуация (перезагрузка
 * точки доступа, обрыв у провайдера).
 *
 * ЧТО ВОРКЕР НЕ КЭШИРУЕТ, см. `public/sw.js`: ответы API и HTML страниц с
 * данными клиента. Регистрация об этом знать не должна — это правило воркера,
 * и оно намеренно живёт в одном месте.
 *
 * Регистрация только в production: в режиме разработки воркер кэшировал бы
 * статику dev-сборки и мешал горячей перезагрузке, а расхождение между
 * поведением в разработке и в проде здесь особенно опасно — речь о том, какие
 * данные застревают на устройстве.
 */
export function ServiceWorkerRegistrar(): null {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    /*
     * Регистрация после загрузки страницы: воркер не участвует в первой
     * отрисовке, и его установка не должна отнимать канал у запросов API,
     * от которых зависит показанный экран.
     */
    const register = (): void => {
      void navigator.serviceWorker.register('/sw.js').catch(() => {
        /*
         * Неудача регистрации не должна влиять на работу: без воркера
         * приложение полностью работоспособно, теряется только офлайн-оболочка.
         * Поэтому ошибка гасится, а не показывается пользователю.
         */
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }

    window.addEventListener('load', register);
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}

/**
 * Попросить Service Worker удалить кэши.
 *
 * Вызывается при выходе из системы. Воркер кэширует только статику, не данные
 * клиента, поэтому утечки здесь нет; очистка нужна, чтобы после выхода на общем
 * компьютере не осталось ничего, что воркер мог бы отдать следующему сотруднику,
 * — правило «выход очищает устройство» должно выполняться целиком, а не
 * наполовину.
 *
 * Вызов намеренно не ожидается: выход из системы не должен зависеть от того,
 * успел ли ответить воркер.
 */
export function clearServiceWorkerCaches(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) => {
      const worker = registration.active ?? navigator.serviceWorker.controller;
      worker?.postMessage({ type: 'clear-caches' });
    })
    .catch(() => {
      // Воркера нет или он ещё не активировался — чистить нечего.
    });
}
