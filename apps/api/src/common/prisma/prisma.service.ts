import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { connectionLimit } from '@app/shared';

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
      /*
       * Пул соединений ОГРАНИЧИВАЕТСЯ, и это критично для эксплуатации.
       *
       * В продакшне база — СУЩЕСТВУЮЩИЙ сервер PostgreSQL предприятия, общий с
       * другими системами (ответ A1). Без `connection_limit` Prisma открывает
       * соединения по числу ядер × 2 + 1 на КАЖДЫЙ процесс, и три процесса
       * (две реплики API и воркер) могли занять весь `max_connections` сервера —
       * тогда встали бы 1С и остальные системы, а причина искалась бы где угодно,
       * кроме нашего приложения.
       *
       * Логика ограничения живёт в `@app/db` и применяется там к общим клиентам.
       * `PrismaService` создаёт СВОЙ экземпляр и раньше её не использовал:
       * `DATABASE_POOL_SIZE` была объявлена, задокументирована как «применяется
       * автоматически» (docs/14 §3.2) и проверялась скриптом `preflight.sh` —
       * но на реально работающий API не влияла. Тот же класс дефекта, что
       * «Дефект 41» и далее: настройка объявлена, эффекта нет.
       */
      datasources: { db: { url: connectionLimit(process.env.DATABASE_URL) } },
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
        /*
         * Всё, что в производстве, логистике или ожидает их.
         *
         * Список ведётся строками, а не константой из домена: у этого фильтра
         * тип Prisma, и строка перечисления здесь — часть запроса. Поэтому при
         * добавлении статуса производства его нужно внести и сюда; тест
         * `prisma-scope.spec.ts` сверяет список с `IN_PRODUCTION_STATUSES`,
         * чтобы «забытый статус» ловился, а не прятался.
         */
        return {
          OR: [
            {
              status: {
                in: [
                  'QUEUED_FOR_DISPATCH',
                  'IN_TRANSIT_TO_PRODUCTION',
                  'IN_PRODUCTION',
                  'ACCEPTED_BY_WORKSHOP',
                  'IN_WORK',
                  'WORK_COMPLETED',
                  'REWORK',
                  'IN_TRANSIT_TO_STORE',
                ],
              },
            },
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
