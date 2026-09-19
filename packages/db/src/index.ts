/**
 * Единая точка доступа к Prisma Client.
 * Импортируется прикладным кодом API — не создавайте отдельные экземпляры.
 */

import { PrismaClient } from '@prisma/client';
// `Prisma` нужен только для типов (Prisma.TransactionClient и др.).
import type { Prisma } from '@prisma/client';
import { connectionLimit } from '@app/shared';

/** Настройки логирования: в dev полезны запросы, в prod — только ошибки. */
const logLevels =
  process.env.NODE_ENV === 'development'
    ? (['query', 'warn', 'error'] as const)
    : (['warn', 'error'] as const);

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
