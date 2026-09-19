/**
 * Ограничение пула соединений.
 *
 * В продакшне БД — СУЩЕСТВУЮЩИЙ сервер PostgreSQL предприятия (ответ A1),
 * общий с другими системами. Поэтому пул нельзя оставлять неограниченным:
 * PostgreSQL допускает `max_connections` соединений на ВЕСЬ сервер, и если
 * наше приложение займёт их все, встанут другие системы (включая 1С).
 *
 * Значение берётся из DATABASE_POOL_SIZE. Учитывайте, что всего соединений
 * будет `pool_size × число процессов`: API (2 реплики) + воркер, каждый
 * со своим пулом. Пример: 10 × 3 = 30 — безопасно при типовом
 * `max_connections = 100`.
 */
export function connectionLimit(url: string | undefined): string | undefined {
  if (!url) return url;
  const size = Number(process.env.DATABASE_POOL_SIZE ?? 0);
  if (!Number.isFinite(size) || size <= 0) return url;
  // Не перезаписываем уже заданное в строке значение.
  if (/[?&]connection_limit=/.test(url)) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}connection_limit=${size}`;
}
