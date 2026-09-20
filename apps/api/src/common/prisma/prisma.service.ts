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
   * ## Почему принимается НАБОР областей, а не одна (дефект 65)
   *
   * Области видимости не вложены: `PRODUCTION` показывает только заказы в
   * производстве и логистике, а заказы магазина (в том числе «Готов к выдаче»)
   * в неё не входят. Пока система выбирала ОДНУ «самую широкую» область, это
   * было незаметно — но приёмщик со второй ролью `LOGISTICIAN` (задача 7.7)
   * получал `PRODUCTION` и переставал видеть заказы своего магазина.
   *
   * Поэтому фильтры всех областей объединяются через `OR`: сотрудник видит то,
   * что видно по ЛЮБОЙ из его ролей. Если хотя бы одна область неограниченная
   * (`ALL_STORES`, `READ_ALL`) — фильтр пуст.
   *
   * @param scopes    области видимости ролей сотрудника
   * @param storeIds  магазины пользователя
   * @param userId    пользователь (для фильтра «мои заказы»)
   *
   * Возвращает условие, которое ОБЯЗАТЕЛЬНО добавляется к каждому запросу списка.
   */
  buildOrderScopeFilter(params: {
    scopes: readonly string[];
    storeIds: readonly string[];
    userId: string;
  }): Prisma.OrderWhereInput {
    const { scopes, storeIds } = params;

    /*
     * Неограниченная область снимает фильтр целиком: складывать её с другими
     * условиями через `OR` значило бы получить «всё ИЛИ своё», то есть тот же
     * «всё», но с лишним условием в запросе.
     */
    if (scopes.includes('ALL_STORES') || scopes.includes('READ_ALL')) return {};

    const branches: Prisma.OrderWhereInput[] = [];

    /*
     * Магазинные области дают заказы своих точек. `STORE_PLUS_GLOBAL_SEARCH`
     * отличается от `STORE` только наличием права на глобальный поиск
     * (отдельный запрос), поэтому фильтр у них одинаковый.
     */
    if (scopes.includes('STORE') || scopes.includes('STORE_PLUS_GLOBAL_SEARCH')) {
      branches.push({
        OR: [{ createdStoreId: { in: [...storeIds] } }, { pickupStoreId: { in: [...storeIds] } }],
      });
    }

    if (scopes.includes('PRODUCTION')) {
      /*
       * Всё, что в производстве, логистике или ожидает их.
       *
       * Список ведётся строками, а не константой из домена: у этого фильтра
       * тип Prisma, и строка перечисления здесь — часть запроса. Поэтому при
       * добавлении статуса производства его нужно внести и сюда; тест
       * `prisma-scope.spec.ts` сверяет список с `IN_PRODUCTION_STATUSES`,
       * чтобы «забытый статус» ловился, а не прятался.
       */
      branches.push({
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
      });
    }

    /*
     * Ни одной знакомой области (пустой список или неизвестный код) —
     * запрещаем всё. Fail closed, не fail open.
     */
    if (branches.length === 0) {
      this.logger.error(
        `Нет ни одной известной области видимости: ${scopes.join(', ')}. Доступ запрещён.`,
      );
      return { id: '__none__' };
    }

    if (branches.length === 1) return branches[0] as Prisma.OrderWhereInput;
    return { OR: branches };
  }

  /**
   * Проверить, что заказ доступен пользователю, и вернуть его.
   * Бросает NotFoundException, если заказ вне области видимости —
   * НЕ раскрываем существование чужих заказов (docs/10-nfr-security.md §3.2).
   */
  async findOrderInScope(params: {
    orderId: string;
    scopes: readonly string[];
    storeIds: readonly string[];
    userId: string;
  }): Promise<Prisma.OrderGetPayload<Record<string, never>> | null> {
    const scopeFilter = this.buildOrderScopeFilter(params);
    return this.order.findFirst({
      where: { AND: [{ id: params.orderId }, scopeFilter] },
    });
  }
}
