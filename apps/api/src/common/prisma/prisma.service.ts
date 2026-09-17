import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Обёртка над Prisma Client с управлением жизненным циклом.
 *
 * Также предоставляет `scopeFilter` — построение фильтра области видимости.
 * ЭТО КРИТИЧНО ДЛЯ БЕЗОПАСНОСТИ (docs/02-domain-and-roles.md §3):
 * каждый запрос списка заказов обязан применять scope-фильтр, иначе приёмщик
 * одного магазина увидит заказы другого. Прямая загрузка по id без проверки
 * scope запрещена — защита от IDOR.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ],
      errorFormat: 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Подключение к базе данных установлено');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Подключение к базе данных закрыто');
  }

  /** Транзакция с настройками по умолчанию (docs/01-architecture.md §3). */
  async runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    return this.$transaction(fn, {
      timeout: options?.timeout ?? 15_000,
      isolationLevel: options?.isolationLevel,
    });
  }

  /**
   * Построить фильтр области видимости для заказов.
   *
   * @param scope     область видимости роли
   * @param storeIds  магазины пользователя
   * @param userId    пользователь (для фильтра «мои заказы»)
   *
   * Возвращает условие, которое ОБЯЗАТЕЛЬНО добавляется к каждому запросу списка.
   */
  buildOrderScopeFilter(params: {
    scope: string;
    storeIds: readonly string[];
    userId: string;
  }): Prisma.OrderWhereInput {
    const { scope, storeIds } = params;

    switch (scope) {
      case 'STORE':
        // Только заказы своих магазинов (и принятые, и выдача).
        return {
          OR: [{ createdStoreId: { in: [...storeIds] } }, { pickupStoreId: { in: [...storeIds] } }],
        };

      case 'STORE_PLUS_GLOBAL_SEARCH':
        // Основная выборка — свои магазины. Глобальный поиск по точному номеру
        // выполняется отдельным запросом, который проверяет право ORDER_SEARCH_GLOBAL.
        return {
          OR: [{ createdStoreId: { in: [...storeIds] } }, { pickupStoreId: { in: [...storeIds] } }],
        };

      case 'PRODUCTION':
        // Всё, что в производстве, логистике или ожидает их.
        return {
          OR: [
            { status: { in: ['QUEUED_FOR_DISPATCH', 'IN_TRANSIT_TO_PRODUCTION', 'IN_PRODUCTION', 'REWORK', 'IN_TRANSIT_TO_STORE'] } },
            { productionManagerId: params.userId },
          ],
        };

      case 'ALL_STORES':
      case 'READ_ALL':
        // Полный доступ — фильтр не ограничивает.
        return {};

      default:
        // Неизвестная область видимости — запрещаем всё. Fail closed, не fail open.
        this.logger.error(`Неизвестная область видимости: ${scope}. Доступ запрещён.`);
        return { id: '__none__' };
    }
  }

  /**
   * Проверить, что заказ доступен пользователю, и вернуть его.
   * Бросает NotFoundException, если заказ вне области видимости —
   * НЕ раскрываем существование чужих заказов (docs/10-nfr-security.md §3.2).
   */
  async findOrderInScope(params: {
    orderId: string;
    scope: string;
    storeIds: readonly string[];
    userId: string;
  }): Promise<Prisma.OrderGetPayload<Record<string, never>> | null> {
    const scopeFilter = this.buildOrderScopeFilter(params);
    return this.order.findFirst({
      where: { AND: [{ id: params.orderId }, scopeFilter] },
    });
  }
}