/**
 * Единая точка доступа к Prisma Client.
 * Импортируется прикладным кодом API — не создавайте отдельные экземпляры.
 */

import { PrismaClient } from '@prisma/client';
// `Prisma` нужен только для типов (Prisma.TransactionClient и др.).
import type { Prisma } from '@prisma/client';

/** Настройки логирования: в dev полезны запросы, в prod — только ошибки. */
const logLevels =
  process.env.NODE_ENV === 'development'
    ? (['query', 'warn', 'error'] as const)
    : (['warn', 'error'] as const);

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
function connectionLimit(url: string | undefined): string | undefined {
  if (!url) return url;
  const size = Number(process.env.DATABASE_POOL_SIZE ?? 0);
  if (!Number.isFinite(size) || size <= 0) return url;
  // Не перезаписываем уже заданное в строке значение.
  if (/[?&]connection_limit=/.test(url)) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}connection_limit=${size}`;
}

export const prisma = new PrismaClient({
  datasources: { db: { url: connectionLimit(process.env.DATABASE_URL) } },
  log: [...logLevels],
  errorFormat: 'minimal',
});

/** Клиент для отчётных запросов. При наличии реплики — читает с неё (docs/01-architecture.md §6). */
export const prismaReplica = process.env.DATABASE_REPLICA_URL
  ? new PrismaClient({
      datasources: { db: { url: connectionLimit(process.env.DATABASE_REPLICA_URL) } },
      log: ['warn', 'error'],
      errorFormat: 'minimal',
    })
  : prisma;

/**
 * Выполнить код в транзакции.
 *
 * Правило (docs/01-architecture.md §3): изменение заказа, запись истории статуса,
 * аудит и запись в outbox выполняются в ОДНОЙ транзакции.
 */
export async function transaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  return prisma.$transaction(fn, {
    timeout: options?.timeout ?? 15_000,
    isolationLevel: options?.isolationLevel,
  });
}

/** Корректное завершение работы — вызывается при остановке приложения. */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
  if (prismaReplica !== prisma) {
    await prismaReplica.$disconnect();
  }
}

export type { PrismaClient };
export * from '@prisma/client';