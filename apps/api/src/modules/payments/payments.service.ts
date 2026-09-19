import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  paymentSchema,
  reversePaymentSchema,
  isPrepaymentSatisfied,
  isTerminalStatus,
  remainingToPay,
  DATA_SCOPE,
  ROLE,
  REPORT_NAME,
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReportsCacheService } from '../../common/cache/reports-cache.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Prisma } from '@prisma/client';

/**
 * Поля платежа, отдаваемые наружу.
 *
 * `idempotencyKey` в ответ НЕ включается: ключ — техническая деталь защиты от
 * дублей, клиенту он не нужен и не должен попадать в интерфейс.
 */
const PAYMENT_SELECT = Prisma.validator<Prisma.PaymentSelect>()({
  id: true,
  orderId: true,
  kind: true,
  method: true,
  status: true,
  amountMinor: true,
  currency: true,
  storeId: true,
  cashierId: true,
  receiptNo: true,
  kktShiftNo: true,
  paidAt: true,
  comment: true,
  reversedById: true,
  reversedAt: true,
  createdAt: true,
});

const PAYMENT_LIST_SELECT = Prisma.validator<Prisma.PaymentSelect>()({
  ...PAYMENT_SELECT,
  store: { select: { id: true, code: true, name: true } },
  cashier: { select: { id: true, fullName: true } },
  order: { select: { id: true, orderNo: true, totalAmountMinor: true, paidAmountMinor: true } },
});

/** Платёж в том виде, в котором его возвращает API. */
export type PaymentDto = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/** Платёж для реестра — с магазином, кассиром и краткой ссылкой на заказ. */
export type PaymentListItem = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_LIST_SELECT }>;

/**
 * Состояние оплаты заказа после операции.
 *
 * Возвращается вместе с платежом, потому что клиенту нужно сразу понять,
 * снялась ли блокировка старта работ и можно ли выдавать заказ. Без этих полей
 * фронтенд был бы вынужден делать второй запрос и рисковал бы показать
 * устаревшее состояние.
 */
export interface OrderPaymentState {
  orderId: string;
  totalAmountMinor: number;
  paidAmountMinor: number;
  prepaymentRequiredMinor: number;
  requiresPrepayment: boolean;
  remainingMinor: number;
  canStartWork: boolean;
  isPaidInFull: boolean;
}

/** Результат приёма платежа или сторно. */
export interface PaymentResult {
  payment: PaymentDto;
  order: OrderPaymentState;
}

/** Параметры реестра платежей. */
export interface PaymentListQuery {
  limit?: number;
  orderId?: string;
  storeId?: string[];
  status?: string[];
  kind?: string[];
  from?: Date;
  to?: Date;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ReportsCacheService,
  ) {}

  /**
   * Принять платёж по заказу.
   *
   * ИДЕМПОТЕНТНОСТЬ (docs/07-api-spec.md §1.3). Ключ обязателен: без него
   * повторный запрос (двойной клик кассира, повторная отправка при обрыве связи)
   * создал бы второй платёж и исказил `paidAmountMinor`. При повторе с тем же
   * ключом возвращается результат первой операции, а не новый платёж.
   *
   * Реализация опирается на уникальный индекс `Payment.idempotencyKey`: сначала
   * ищем существующий платёж, а гонку двух одновременных запросов ловим по
   * ошибке уникальности `P2002` — в этом случае возвращаем уже созданный платёж.
   */
  async createPayment(
    orderId: string,
    input: unknown,
    idempotencyKey: string | undefined,
    user: AuthenticatedUser,
  ): Promise<PaymentResult> {
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Заголовок Idempotency-Key обязателен для операции с деньгами',
      });
    }

    const key = idempotencyKey.trim();

    // Повтор запроса: отдаём результат первой операции, ничего не создавая.
    const existing = await this.prisma.payment.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, orderId: true },
    });
    if (existing !== null) {
      this.logger.log(`Повторный платёж по ключу ${key}: возвращён существующий ${existing.id}`);
      return this.buildResult(existing.orderId, existing.id);
    }

    const parsed = paymentSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    // Магазин приёма оплаты: платить можно в любом магазине (ТЗ п. 2.5),
    // поэтому storeId приходит из запроса, а не берётся из заказа.
    if (user.scope !== DATA_SCOPE.ALL_STORES && !user.storeIds.includes(data.storeId)) {
      throw new ForbiddenException({
        code: 'STORE_NOT_ALLOWED',
        message: 'Приём оплаты доступен только в вашем магазине',
      });
    }

    // Сторно и возврат оформляются отдельными операциями: они должны быть
    // связаны с исходным платежом. Приём «отрицательного платежа» здесь
    // запрещён — иначе в реестре появились бы записи без основания.
    if (data.kind === 'REVERSAL') {
      throw new BadRequestException({
        code: 'USE_REVERSE_ENDPOINT',
        message: 'Сторно выполняется через POST /payments/:id/reverse',
      });
    }

    try {
      const paymentId = await this.prisma.runInTransaction(async (tx) => {
        // Заказ читаем в транзакции: сумма платежа проверяется против
        // актуального состояния, а не против прочитанного ранее.
        const order = await tx.order.findFirst({
          where: this.orderScope(orderId, user),
          select: {
            id: true,
            status: true,
            totalAmountMinor: true,
            paidAmountMinor: true,
          },
        });

        if (order === null) {
          // Не найдено ИЛИ вне области видимости — 404, не 403 (защита от IDOR).
          throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
        }

        // Терминальные статусы (COMPLETED, REFUSED, CANCELLED) — деньги уже
        // не принимаются: заказ закрыт. Проверка идёт через доменную функцию,
        // а не по списку строк: список терминальных статусов меняется в одном
        // месте — packages/shared, и расхождение с ним исключено.
        if (isTerminalStatus(order.status)) {
          throw new ConflictException({
            code: 'ORDER_FINAL',
            message: 'Нельзя принять оплату по закрытому заказу',
          });
        }

        // Переплата — это почти всегда ошибка ввода суммы. Разрешаем только
        // возврат (REFUND), который уменьшает внесённую сумму.
        const isRefund = data.kind === 'REFUND';
        if (isRefund && data.amountMinor > order.paidAmountMinor) {
          throw new ConflictException({
            code: 'REFUND_EXCEEDS_PAID',
            message: 'Сумма возврата превышает внесённую по заказу',
          });
        }
        if (
          !isRefund &&
          data.amountMinor > remainingToPay(order.totalAmountMinor, order.paidAmountMinor)
        ) {
          throw new ConflictException({
            code: 'OVERPAYMENT',
            message: 'Сумма превышает остаток к оплате по заказу',
          });
        }

        const created = await tx.payment.create({
          data: {
            orderId: order.id,
            kind: data.kind,
            method: data.method,
            status: 'CONFIRMED',
            amountMinor: data.amountMinor,
            storeId: data.storeId,
            cashierId: user.id,
            receiptNo: data.receiptNo ?? null,
            kktShiftNo: data.kktShiftNo ?? null,
            idempotencyKey: key,
            paidAt: data.paidAt,
            comment: data.comment ?? null,
            createdById: user.id,
          },
          select: { id: true },
        });

        await this.recalculatePaidAmount(tx, order.id);

        await tx.auditLog.create({
          data: {
            actorId: user.id,
            actorRole: user.primaryRole,
            action: 'PAYMENT_CREATE',
            entity: 'Payment',
            entityId: created.id,
            storeId: data.storeId,
            after: {
              orderId: order.id,
              kind: data.kind,
              method: data.method,
              amountMinor: data.amountMinor,
            },
            reason: data.comment ?? null,
          },
        });

        return created.id;
      });

      this.logger.log(
        `Платёж ${paymentId}: ${data.kind} ${data.amountMinor} коп. по заказу ${orderId}`,
      );

      /*
       * Сброс кэша отчётов о ДЕНЬГАХ (задача 5.7). Платёж меняет выручку и
       * предоплаты, но не сроки этапов и не загрузку цеха — сбрасывать их
       * значило бы заставлять следующий запрос считать заново без причины.
       *
       * Сброс идёт после успешной записи: при гонке по ключу идемпотентности
       * платёж создан первым запросом, и он уже сбросил кэш.
       */
      this.cache.invalidate([REPORT_NAME.REVENUE, REPORT_NAME.PREPAYMENTS]);

      return this.buildResult(orderId, paymentId);
    } catch (error: unknown) {
      // Гонка двух одновременных запросов с одним ключом: второй ловит
      // нарушение уникальности. Это не ошибка — отдаём результат первого.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.payment.findUnique({
          where: { idempotencyKey: key },
          select: { id: true, orderId: true },
        });
        if (winner !== null) {
          this.logger.log(`Гонка по ключу ${key}: возвращён платёж ${winner.id}`);
          return this.buildResult(winner.orderId, winner.id);
        }
      }
      throw error;
    }
  }

  /**
   * Сторно платежа (docs/07-api-spec.md §7).
   *
   * Исходный платёж не удаляется и не правится: он получает статус `REVERSED`,
   * а причина уходит в аудит. Это требование к финансовому учёту — история
   * движений денег должна оставаться неизменной.
   */
  async reversePayment(
    paymentId: string,
    input: unknown,
    user: AuthenticatedUser,
  ): Promise<PaymentResult> {
    const parsed = reversePaymentSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const orderId = await this.prisma.runInTransaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          orderId: true,
          status: true,
          amountMinor: true,
          kind: true,
          storeId: true,
        },
      });

      if (payment === null) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Платёж не найден' });
      }

      if (payment.status === 'REVERSED') {
        throw new ConflictException({
          code: 'ALREADY_REVERSED',
          message: 'Платёж уже отменён',
        });
      }

      // Кассир может отменить платёж только своего магазина; руководитель и
      // администратор — любой (docs/07-api-spec.md §7).
      const isPrivileged = user.primaryRole === ROLE.MANAGER || user.primaryRole === ROLE.ADMIN;
      if (!isPrivileged && !user.storeIds.includes(payment.storeId)) {
        throw new ForbiddenException({
          code: 'STORE_NOT_ALLOWED',
          message: 'Сторно доступно только по платежам вашего магазина',
        });
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'REVERSED',
          reversedById: user.id,
          reversedAt: new Date(),
        },
      });

      // Сторно — это не отдельный платёж, а изменение состояния исходного,
      // поэтому `paidAmountMinor` пересчитывается по тем же правилам:
      // в сумму входят только CONFIRMED-платежи.
      await this.recalculatePaidAmount(tx, payment.orderId);

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'PAYMENT_REVERSE',
          entity: 'Payment',
          entityId: payment.id,
          storeId: payment.storeId,
          before: { status: payment.status },
          after: { status: 'REVERSED' },
          reason: parsed.data.reason,
        },
      });

      return payment.orderId;
    });

    this.logger.warn(`Сторно платежа ${paymentId} по заказу ${orderId}`);
    return this.buildResult(orderId, paymentId);
  }

  /** Платежи по заказу. */
  async findByOrder(orderId: string, user: AuthenticatedUser): Promise<PaymentDto[]> {
    const order = await this.prisma.order.findFirst({
      where: this.orderScope(orderId, user),
      select: { id: true },
    });
    if (order === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    return this.prisma.payment.findMany({
      where: { orderId: order.id },
      orderBy: { paidAt: 'desc' },
      select: PAYMENT_SELECT,
    });
  }

  /**
   * Реестр платежей с фильтрами.
   *
   * Область видимости применяется к магазину приёма оплаты: кассир видит
   * платежи своих магазинов.
   */
  async findAll(query: PaymentListQuery, user: AuthenticatedUser): Promise<PaymentListItem[]> {
    const limit = Math.min(query.limit ?? 100, 500);

    const storeIds =
      user.scope === DATA_SCOPE.ALL_STORES
        ? (query.storeId ?? undefined)
        : user.storeIds.filter((id) => query.storeId === undefined || query.storeId.includes(id));

    const where: Prisma.PaymentWhereInput = {
      ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
      ...(storeIds === undefined ? {} : { storeId: { in: [...storeIds] } }),
      ...(query.status === undefined ? {} : { status: { in: query.status as never } }),
      ...(query.kind === undefined ? {} : { kind: { in: query.kind as never } }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            paidAt: {
              ...(query.from === undefined ? {} : { gte: query.from }),
              ...(query.to === undefined ? {} : { lte: query.to }),
            },
          }),
    };

    return this.prisma.payment.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      take: limit,
      select: PAYMENT_LIST_SELECT,
    });
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  /**
   * Пересчёт `paidAmountMinor` по фактическим платежам.
   *
   * Формула из `docs/03-data-model.md` §3.2:
   * `paidAmountMinor = SUM(amountMinor) WHERE status = 'CONFIRMED'`.
   *
   * Считаем агрегатом в БД, а не инкрементом `paid + amount`: инкремент
   * расходится с реальностью после любой операции сторно. Пересчёт от
   * источника истины всегда даёт согласованную сумму, и его стоимость
   * пренебрежимо мала на одном заказе.
   */
  private async recalculatePaidAmount(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<number> {
    const confirmed = await tx.payment.findMany({
      where: { orderId, status: 'CONFIRMED' },
      select: { amountMinor: true, kind: true },
    });

    // REFUND уменьшает внесённую сумму, поэтому учитывается со знаком минус.
    const paid = confirmed.reduce(
      (acc, p) => (p.kind === 'REFUND' ? acc - p.amountMinor : acc + p.amountMinor),
      0,
    );
    const safePaid = Math.max(0, paid);

    await tx.order.update({
      where: { id: orderId },
      data: { paidAmountMinor: safePaid },
    });

    return safePaid;
  }

  /** Актуальное состояние оплаты заказа — то, что нужно интерфейсу сразу после операции. */
  private async buildResult(orderId: string, paymentId: string): Promise<PaymentResult> {
    const [payment, order] = await Promise.all([
      this.prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: PAYMENT_SELECT,
      }),
      this.prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          id: true,
          totalAmountMinor: true,
          paidAmountMinor: true,
          prepaymentRequiredMinor: true,
          requiresPrepayment: true,
        },
      }),
    ]);

    return {
      payment,
      order: {
        orderId: order.id,
        totalAmountMinor: order.totalAmountMinor,
        paidAmountMinor: order.paidAmountMinor,
        prepaymentRequiredMinor: order.prepaymentRequiredMinor,
        requiresPrepayment: order.requiresPrepayment,
        remainingMinor: remainingToPay(order.totalAmountMinor, order.paidAmountMinor),
        // Старт работ разрешён, если предоплата не требуется или уже внесена.
        canStartWork: isPrepaymentSatisfied(
          order.paidAmountMinor,
          order.requiresPrepayment ? order.prepaymentRequiredMinor : 0,
        ),
        isPaidInFull: order.paidAmountMinor >= order.totalAmountMinor,
      },
    };
  }

  /**
   * Фильтр области видимости заказа для приёма оплаты.
   *
   * ВНИМАНИЕ: здесь область видимости НЕ ограничивает приём оплаты магазином
   * заказа. По ТЗ п. 2.5 оплату принимают в любой точке сети (клиент может
   * прийти в удобный магазин), поэтому приёмщик с правом глобального поиска
   * находит заказ по точному номеру и принимает платёж. Ограничение
   * накладывается на магазин ПРИЁМА денег, а не на заказ.
   *
   * Для остальных областей (PRODUCTION, READ_ALL) правило обычное. Это место
   * осознанно отличается от `buildOrderScopeFilter` — при рефакторинге его
   * легко «унифицировать» и тем самым сломать основной сценарий кассы.
   */
  private orderScope(orderId: string, user: AuthenticatedUser): Prisma.OrderWhereInput {
    if (user.scope === DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH) {
      // Заказ доступен по точному id; право на глобальный поиск уже проверено
      // гвардом (PERMISSION.ORDER_SEARCH_GLOBAL).
      return { id: orderId };
    }

    return {
      AND: [
        { id: orderId },
        this.prisma.buildOrderScopeFilter({
          scope: user.scope,
          storeIds: user.storeIds,
          userId: user.id,
        }),
      ],
    };
  }
}
