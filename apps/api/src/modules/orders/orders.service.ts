import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createOrderSchema,
  approvalSchema,
  calcAdjustmentSchema,
  normalizePhone,
  normalizeScanInput,
  buildOrderQrPayload,
  calcOrderTotal,
  discountForTotal,
  sumMinor,
  statusLabel,
  resolveItemPrice,
  isTerminalStatus,
  addWorkingDays,
  formatPhone,
  ORDER_STATUS,
  type OrderStatus,
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
// `Prisma` нужен как значение: `Prisma.validator` вызывается при объявлении
// констант запросов, поэтому import без `type`.
import { Prisma } from '@prisma/client';
import type { CreateOrderInput, OrderWorkInput, CalcAdjustmentInput } from '@app/shared';
import type { ReceiptContext } from './receipt.service';

/**
 * Русское название канала согласования — попадает в причину корректировки,
 * которую читает человек в истории заказа.
 */
function approvalChannelLabel(channel: string): string {
  const labels: Record<string, string> = {
    IN_PERSON: 'лично в магазине',
    PHONE_VERBAL: 'устно по телефону',
    SMS: 'SMS',
    MESSENGER: 'мессенджер',
    EMAIL: 'e-mail',
  };
  return labels[channel] ?? channel;
}

/** Работа после проверки цены: исходные поля плюс индекс изделия. */
interface VerifiedWork extends OrderWorkInput {
  /** Индекс изделия в массиве `items`, к которому относится работа. */
  itemIndex: number;
}

/**
 * Константы запросов с связанными данными.
 *
 * Объявлены через `Prisma.validator`, чтобы из них можно было вывести типы
 * (`Prisma.OrderGetPayload<...>`). Это единый источник истины: тип ответа
 * вычисляется из самого запроса, поэтому добавленное в `include` поле
 * автоматически появляется в типе, а удалённое — исчезает. Рукописный
 * интерфейс здесь разошёлся бы с реальным ответом API при первом изменении.
 */
const ORDER_CARD_INCLUDE = Prisma.validator<Prisma.OrderInclude>()({
  customer: true,
  createdStore: true,
  pickupStore: true,
  workshop: true,
  createdBy: { select: { id: true, fullName: true } },
  productionManager: { select: { id: true, fullName: true } },
  items: { include: { photos: { include: { file: true } } } },
  works: { orderBy: { createdAt: 'asc' } },
  stones: true,
  adjustments: {
    orderBy: { createdAt: 'desc' },
    include: { adjustedBy: { select: { fullName: true } } },
  },
  approvals: {
    orderBy: { createdAt: 'desc' },
    include: { createdBy: { select: { fullName: true } }, recordings: true },
  },
  payments: { orderBy: { paidAt: 'desc' } },
  statusHistory: {
    orderBy: { createdAt: 'desc' },
    include: { changedBy: { select: { fullName: true } } },
  },
  assignments: { include: { performer: true } },
  claims: true,
  callRecordings: { orderBy: { startedAt: 'desc' } },
});

/**
 * Поля, нужные для печати квитанции.
 *
 * Отдельная выборка, а не `ORDER_CARD_INCLUDE`: в квитанцию не попадают
 * платежи целиком, история статусов и записи звонков — печатать их не нужно,
 * а тянуть из базы на каждую печать дороже.
 */
const RECEIPT_SELECT = Prisma.validator<Prisma.OrderSelect>()({
  id: true,
  orderNo: true,
  qrPayload: true,
  status: true,
  createdAt: true,
  dueAt: true,
  description: true,
  isWarranty: true,
  requiresPrepayment: true,
  prepaymentRequiredMinor: true,
  worksTotalMinor: true,
  stonesTotalMinor: true,
  discountMinor: true,
  totalAmountMinor: true,
  paidAmountMinor: true,
  receiptPrintCount: true,
  receiptLastPrintedAt: true,
  customer: { select: { fullName: true, phoneNormalized: true } },
  createdStore: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  items: { select: { name: true, metal: true } },
  works: { select: { name: true, amountMinor: true }, orderBy: { createdAt: 'asc' } },
  stones: { select: { name: true, amountMinor: true } },
});

const ORDER_LIST_SELECT = Prisma.validator<Prisma.OrderSelect>()({
  id: true,
  orderNo: true,
  status: true,
  priority: true,
  totalAmountMinor: true,
  paidAmountMinor: true,
  dueAt: true,
  promisedAt: true,
  readyAt: true,
  createdAt: true,
  isWarranty: true,
  customer: { select: { id: true, fullName: true, phoneNormalized: true } },
  createdStore: { select: { id: true, code: true, name: true } },
});

const ORDER_SEARCH_SELECT = Prisma.validator<Prisma.OrderSelect>()({
  id: true,
  orderNo: true,
  status: true,
  totalAmountMinor: true,
  paidAmountMinor: true,
  dueAt: true,
  createdAt: true,
  customer: { select: { fullName: true, phoneNormalized: true } },
  createdStore: { select: { code: true, name: true } },
});

const CREATED_ORDER_INCLUDE = Prisma.validator<Prisma.OrderInclude>()({
  items: true,
  works: true,
  stones: true,
  customer: true,
  createdStore: true,
  pickupStore: true,
});

/**
 * Карточка заказа (ТЗ п. 2.1) — данные заказа плюс вычисляемые поля.
 *
 * Вычисляемые поля (`statusLabel`, `remainingMinor`, `availableTransitions`)
 * в БД не хранятся: они считаются в `findOne` из статуса, суммы и матрицы
 * переходов. UI использует `availableTransitions` вместо собственной копии
 * матрицы прав — иначе правила расходились бы между фронтендом и бэкендом.
 */
export type OrderCard = Prisma.OrderGetPayload<{ include: typeof ORDER_CARD_INCLUDE }> & {
  statusLabel: string;
  isOverdue: boolean;
  remainingMinor: number;
  canStartWork: boolean;
  availableTransitions: readonly {
    to: OrderStatus;
    label: string;
    requiresReason: boolean;
  }[];
};

/** Элемент списка заказов (`findAll`): только поля, нужные таблице и карточкам. */
export type OrderListItem = Prisma.OrderGetPayload<{ select: typeof ORDER_LIST_SELECT }> & {
  statusLabel: string;
  isOverdue: boolean;
  remainingMinor: number;
};

/** Страница списка заказов с курсором для keyset-пагинации. */
export interface OrderListResult {
  items: OrderListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Результат глобального поиска.
 *
 * `outsideScope` — заказ найден по точному номеру, но лежит вне области
 * видимости пользователя. Поиск намеренно не ограничен магазинами (оплату
 * принимают в любой точке), однако UI обязан предупредить об этом.
 */
export type OrderSearchItem = Prisma.OrderGetPayload<{ select: typeof ORDER_SEARCH_SELECT }> & {
  statusLabel: string;
  outsideScope: boolean;
};

/** Запись единой ленты событий заказа: статусы, платежи, согласования, корректировки. */
export interface TimelineEntry {
  type: 'STATUS' | 'PAYMENT' | 'APPROVAL' | 'ADJUSTMENT';
  at: Date;
  title: string;
  actor: string | null;
  details: Record<string, unknown>;
}

/** Заказ в том виде, в котором его возвращает создание (без вычисляемых полей карточки). */
export type CreatedOrder = Prisma.OrderGetPayload<{ include: typeof CREATED_ORDER_INCLUDE }>;

/** Параметры пагинации и фильтрации списка заказов. */
export interface OrderListQuery {
  limit?: number;
  cursor?: string;
  status?: OrderStatus[];
  storeId?: string[];
  overdue?: boolean;
  customerPhone?: string;
  orderNo?: string;
  isWarranty?: boolean;
  priority?: string;
}

/** Сводка для дашборда: счётчики по группам статусов. */
export interface OrderSummary {
  total: number;
  overdue: number;
  unclaimed: number;
  awaitingPrepayment: number;
  awaitingApproval: number;
  inProduction: number;
  readyForPickup: number;
  inTransit: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: OrderWorkflowService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Создать заказ.
   *
   * Реализует требования ТЗ:
   *  * п. 2.1 — регистрация заказа в любом магазине;
   *  * п. 2.2 — фиксация цены прейскуранта на момент приёма;
   *  * п. 2.4 — обязательное согласие на запись разговоров;
   *  * п. 2.3 — калькуляция: работы + камни отдельными строками.
   */
  async create(input: unknown, user: AuthenticatedUser): Promise<CreatedOrder> {
    const parsed = createOrderSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    // ТЗ п. 2.4: без согласия на запись разговоров заказ создать нельзя.
    if (data.customer && !data.customer.consentCallRecording) {
      throw new ConflictException({
        code: 'CONSENT_REQUIRED',
        message: 'Необходимо согласие клиента на запись разговора',
      });
    }

    const stonesTotal = sumMinor(...data.stones.map((s) => s.unitPriceMinor * s.quantity));

    return this.prisma.runInTransaction(async (tx) => {
      // Клиент: найти существующего по телефону или создать нового.
      const customerId = data.customerId ?? (await this.resolveCustomer(tx, data, user));

      // Фиксируем действующую версию прейскуранта (ТЗ п. 2.2): цены в принятых
      // заказах не должны меняться при пересмотре прейскуранта.
      const activePriceList = await tx.priceListVersion.findFirst({
        where: { status: 'APPROVED', effectiveFrom: { lte: new Date() } },
        orderBy: { effectiveFrom: 'desc' },
      });

      /*
       * Проверка цены на сервере.
       *
       * До этой проверки цена принималась такой, какой её прислал клиент.
       * Это дефект денежного пути: цену можно было занизить правкой запроса
       * из браузера, и заказ уходил бы в производство с неверной суммой.
       * Проверка закрывает и ошибку интерфейса (например, выбран не тот
       * металл), и намеренную подмену.
       *
       * Нетиповые работы (`isCustom`) не проверяются — их цену назначает
       * сотрудник, и прейскуранта для них не существует.
       */
      const verifiedWorks = await this.verifyWorkPrices(tx, data, activePriceList?.id ?? null);

      /*
       * Итог считается по ПРОВЕРЕННЫМ ценам, а не по присланным: иначе
       * проверка не имела бы смысла — заказ сохранялся бы с исходной
       * (возможно, поддельной) суммой.
       */
      const worksTotal = sumMinor(
        ...verifiedWorks.map((work) => Math.round(work.unitPriceMinor * work.quantity)),
      );
      const total = calcOrderTotal({
        worksTotalMinor: worksTotal,
        stonesTotalMinor: stonesTotal,
        discountMinor: data.discountMinor,
      });

      /*
       * Номер генерируется ДО создания, потому что от него зависит QR-код
       * квитанции (`qrPayload`). Сгенерировать номер внутри `data` и взять
       * его для другого поля того же `create` нельзя — пришлось бы делать
       * второй запрос на обновление, а окно, в котором заказ существует без
       * кода, не нужно.
       */
      const orderNo = await this.generateOrderNo(tx, data.createdStoreId);

      const order = await tx.order.create({
        data: {
          orderNo,
          qrPayload: buildOrderQrPayload(orderNo),
          status: ORDER_STATUS.DRAFT,
          customerId,
          createdStoreId: data.createdStoreId,
          pickupStoreId: data.pickupStoreId,
          workshopId: data.workshopId ?? null,
          createdById: user.id,
          priority: data.priority,
          worksTotalMinor: worksTotal,
          stonesTotalMinor: stonesTotal,
          discountMinor: data.discountMinor,
          totalAmountMinor: total,
          requiresPrepayment: data.requiresPrepayment,
          prepaymentRequiredMinor: data.requiresPrepayment ? data.prepaymentRequiredMinor : 0,
          description: data.description ?? null,
          isWarranty: data.isWarranty,
          parentOrderId: data.parentOrderId ?? null,
          priceListVersionId: activePriceList?.id ?? null,
          priceFixedAt: activePriceList ? new Date() : null,
          items: {
            create: data.items.map((item) => ({
              name: item.name,
              metal: item.metal ?? null,
              weightGram: item.weightGram ?? null,
              size: item.size ?? null,
              hallmark: item.hallmark ?? null,
              defects: item.defects ?? null,
              completeness: item.completeness ?? null,
              inventoryNo: item.inventoryNo ?? null,
            })),
          },
        },
        include: { items: true },
      });

      // Строки калькуляции привязываем к созданным изделиям по порядку.
      /*
       * Каждая работа привязывается к СВОЕМУ изделию по `itemIndex`.
       *
       * Раньше все работы привязывались к первому изделию. Для заказа с одним
       * изделием это незаметно, но в заказе «золотое кольцо + серебряная
       * цепочка» цена подбирается по металлу изделия, поэтому неверная
       * привязка = неверная цена.
       */
      if (verifiedWorks.length > 0) {
        await tx.orderWork.createMany({
          data: verifiedWorks.map((work) => ({
            orderId: order.id,
            itemId: order.items[work.itemIndex]?.id ?? null,
            priceListItemId: work.priceListItemId ?? null,
            code: work.code,
            name: work.name,
            quantity: work.quantity,
            unit: work.unit,
            unitPriceMinor: work.unitPriceMinor,
            amountMinor: Math.round(work.unitPriceMinor * work.quantity),
            durationHours: work.durationHours ?? null,
            warrantyMonths: work.warrantyMonths,
            isCustom: work.isCustom,
            comment: work.comment ?? null,
            createdById: user.id,
          })),
        });
      }

      if (data.stones.length > 0) {
        await tx.orderStone.createMany({
          data: data.stones.map((stone) => ({
            orderId: order.id,
            // Камни, как и работы, привязываются к своему изделию.
            itemId: order.items[stone.itemIndex]?.id ?? null,
            stoneTypeId: stone.stoneTypeId ?? null,
            name: stone.name,
            quantity: stone.quantity,
            caratWeight: stone.caratWeight ?? null,
            unitPriceMinor: stone.unitPriceMinor,
            amountMinor: stone.unitPriceMinor * stone.quantity,
            comment: stone.comment ?? null,
            createdById: user.id,
          })),
        });
      }

      // История: фиксируем создание заказа.
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: null,
          toStatus: ORDER_STATUS.DRAFT,
          stage: 'INTAKE',
          changedById: user.id,
          reason: 'Заказ создан',
        },
      });

      // Аудит (ТЗ п. 4).
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'CREATE',
          entity: 'Order',
          entityId: order.id,
          storeId: data.createdStoreId,
          after: { orderNo: order.orderNo, totalAmountMinor: total },
        },
      });

      this.logger.log(`Заказ создан: ${order.orderNo} (${worksTotal + stonesTotal} коп.)`);

      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: CREATED_ORDER_INCLUDE,
      });
    });
  }

  /**
   * Проверить цены работ по действующему прейскуранту.
   *
   * Зачем проверка существует. Прейскурант задаёт цену в разрезе металла
   * (золото/серебро), а металл известен только из изделия, которое сдал
   * клиент. Интерфейс подставляет цену сам, и без серверной проверки именно
   * присланное число попадало бы в заказ и в квитанцию. Значит, любые
   * расхождения — ошибка в интерфейсе, устаревший прейскурант в открытой
   * вкладке или намеренная подмена — приводили бы к неверной сумме.
   *
   * Цена НЕ подменяется молча: заказ либо принимается с ценой из прейскуранта
   * (когда расхождения нет), либо отклоняется с указанием, что именно не
   * совпало. Молчаливая замена скрыла бы дефекты интерфейса и лишила бы
   * приёмщика возможности объяснить клиенту итоговую сумму.
   *
   * Исключения:
   *  * `isCustom` — нетиповая работа, цены в прейскуранте нет по определению;
   *  * позиция, не найденная в действующей версии прейскуранта, — считаем
   *    нетиповой (например, позицию вывели из прейскуранта, а заказ ещё
   *    оформляют по старой вкладке).
   */
  private async verifyWorkPrices(
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
    data: CreateOrderInput,
    activePriceListId: string | null,
  ): Promise<VerifiedWork[]> {
    const works: VerifiedWork[] = data.works.map((work) => ({
      ...work,
      itemIndex: Math.min(work.itemIndex, Math.max(data.items.length - 1, 0)),
    }));

    if (activePriceListId === null) {
      // Действующего прейскуранта нет — сверять не с чем. Заказ всё равно
      // можно создать: цена в этом случае фиксируется как есть.
      return works;
    }

    const pricedIds = works
      .filter((work) => !work.isCustom && work.priceListItemId !== undefined)
      .map((work) => work.priceListItemId as string);

    if (pricedIds.length === 0) return works;

    const items = await tx.priceListItem.findMany({
      where: { id: { in: pricedIds }, priceListId: activePriceListId },
      select: {
        id: true,
        code: true,
        name: true,
        priceMinor: true,
        priceFrom: true,
        metalCostSeparate: true,
        rates: { select: { metal: true, priceMinor: true, isFrom: true } },
      },
    });
    const byId = new Map(items.map((item) => [item.id, item]));

    const mismatches: { code: string; expectedMinor: number; gotMinor: number }[] = [];

    for (const work of works) {
      if (work.isCustom || work.priceListItemId === undefined) continue;

      const priced = byId.get(work.priceListItemId);
      if (priced === undefined) continue;

      /*
       * Металл берём у изделия, к которому относится работа: прейскурант
       * задаёт отдельную цену по золоту и серебру.
       *
       * Текст передаём как есть: `resolveItemPrice` сам приводит «Серебро 925»
       * к коду `SILVER`. Нормализация живёт внутри общей функции, а не здесь,
       * потому что ровно на этом уже была ошибка — сравнение свободного текста
       * с кодом не совпадало, и серебряный заказ молча считался по золотому
       * тарифу. Если металл не распознан, функция вернёт цену по умолчанию.
       */
      const resolved = resolveItemPrice(priced, data.items[work.itemIndex]?.metal ?? null);

      if (resolved.priceMinor !== work.unitPriceMinor) {
        mismatches.push({
          code: priced.code,
          expectedMinor: resolved.priceMinor,
          gotMinor: work.unitPriceMinor,
        });
      }
    }

    if (mismatches.length > 0) {
      /*
       * 409, а не 400: запрос синтаксически корректен, конфликт в том, что
       * присланная цена не совпадает с действующим прейскурантом. Приёмщику
       * нужно обновить страницу и повторить — данные в порядке.
       */
      throw new ConflictException({
        code: 'PRICE_MISMATCH',
        message:
          'Цена работы не совпадает с действующим прейскурантом. Обновите страницу и повторите приём.',
        details: { mismatches },
      });
    }

    return works;
  }

  /** Найти клиента по телефону или создать нового (ТЗ п. 2.1: поиск по телефону). */
  private async resolveCustomer(
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
    data: { customer?: { fullName: string; phone: string; consentCallRecording: boolean; consentMarketing: boolean; email?: string; notes?: string } },
    user: AuthenticatedUser,
  ): Promise<string> {
    if (!data.customer) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Укажите клиента: выберите существующего или заполните данные',
      });
    }

    const phoneNormalized = normalizePhone(data.customer.phone);
    if (!phoneNormalized) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Укажите корректный телефон клиента',
      });
    }

    const existing = await tx.customer.findFirst({ where: { phoneNormalized } });

    if (existing) {
      // Клиент найден: обновляем согласие, если оно появилось.
      if (data.customer.consentCallRecording && !existing.consentCallRecording) {
        await tx.customer.update({
          where: { id: existing.id },
          data: { consentCallRecording: true },
        });
      }
      return existing.id;
    }

    const created = await tx.customer.create({
      data: {
        fullName: data.customer.fullName,
        phone: data.customer.phone,
        phoneNormalized,
        email: data.customer.email || null,
        consentCallRecording: data.customer.consentCallRecording,
        consentMarketing: data.customer.consentMarketing,
        notes: data.customer.notes ?? null,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'CREATE',
        entity: 'Customer',
        entityId: created.id,
        after: { fullName: created.fullName },
      },
    });

    return created.id;
  }

  /**
   * Генерация человекочитаемого номера заказа.
   * Формат: {КодМагазина}-{ГГ}{ММ}-{6 цифр} (docs/03-data-model.md §6).
   * Счётчик инкрементируется в транзакции с блокировкой строки.
   */
  private async generateOrderNo(
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
    storeId: string,
  ): Promise<string> {
    const store = await tx.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { code: true },
    });

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const scope = `ORDER:${store.code}:${year}`;

    const counter = await tx.counter.upsert({
      where: { scope },
      update: { value: { increment: 1 } },
      create: { scope, value: 1 },
    });

    return `${store.code}-${String(year).slice(2)}${month}-${String(counter.value).padStart(6, '0')}`;
  }

  /**
   * Список заказов с фильтрами и keyset-пагинацией.
   *
   * КРИТИЧНО: scope-фильтр применяется всегда. Без него приёмщик одного магазина
   * увидел бы заказы другого — прямое нарушение ответа на вопрос 4 ТЗ.
   */
  async findAll(query: OrderListQuery, user: AuthenticatedUser): Promise<OrderListResult> {
    const limit = Math.min(query.limit ?? 50, 200);

    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scope: user.scope,
      storeIds: user.storeIds,
      userId: user.id,
    });

    const conditions: Record<string, unknown>[] = [scopeFilter];

    if (query.status?.length) conditions.push({ status: { in: query.status } });
    if (query.storeId?.length) {
      conditions.push({
        OR: [{ createdStoreId: { in: query.storeId } }, { pickupStoreId: { in: query.storeId } }],
      });
    }
    if (query.overdue) conditions.push({ dueAt: { lt: new Date() } });
    if (query.isWarranty !== undefined) conditions.push({ isWarranty: query.isWarranty });
    if (query.priority) conditions.push({ priority: query.priority });
    if (query.orderNo) conditions.push({ orderNo: { contains: query.orderNo, mode: 'insensitive' } });
    if (query.customerPhone) {
      const phoneNormalized = normalizePhone(query.customerPhone);
      if (phoneNormalized) conditions.push({ customer: { phoneNormalized } });
    }

    // Keyset-пагинация вместо OFFSET: на больших объёмах OFFSET деградирует
    // (docs/01-architecture.md §6).
    if (query.cursor) {
      const cursor = this.decodeCursor(query.cursor);
      if (cursor) {
        conditions.push({
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        });
      }
    }

    const orders = await this.prisma.order.findMany({
      where: { AND: conditions },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // +1 чтобы понять, есть ли следующая страница
      select: ORDER_LIST_SELECT,
    });

    const hasMore = orders.length > limit;
    const page = hasMore ? orders.slice(0, limit) : orders;
    const last = page[page.length - 1];

    return {
      items: page.map((order) => ({
        ...order,
        statusLabel: statusLabel(order.status),
        isOverdue: order.dueAt != null && order.dueAt < new Date(),
        remainingMinor: Math.max(0, order.totalAmountMinor - order.paidAmountMinor),
      })),
      nextCursor: hasMore && last ? this.encodeCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }

  /**
   * Глобальный поиск по номеру заказа (ответ на вопрос 4 ТЗ).
   *
   * Приёмщик видит только свои заказы, но принять оплату может в любой точке —
   * поэтому поиск по ТОЧНОМУ номеру выполняется без ограничения по магазинам.
   */
  async searchGlobal(term: string, user: AuthenticatedUser): Promise<OrderSearchItem[]> {
    /*
     * Разбор ввода сканера выполняется и здесь, а не только в интерфейсе.
     *
     * Сканер «печатает» в поле содержимое QR-кода (`repair://order/MSK1-…`).
     * Интерфейс нормализует ввод, но поиск — общий вход: к нему обращаются
     * мобильные экраны и будущие интеграции, и любой из них, отправив URI
     * целиком, получил бы НОЛЬ заказов вместо одного. Дефект уже случался
     * на экране приёма оплаты; нормализация в домене не даёт ему повториться.
     */
    const trimmed = normalizeScanInput(term);
    if (trimmed.length < 3) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Введите минимум 3 символа для поиска',
      });
    }

    const OR: Record<string, unknown>[] = [
      { orderNo: { equals: trimmed, mode: 'insensitive' } },
      { orderNo: { contains: trimmed, mode: 'insensitive' } },
    ];

    const phoneNormalized = normalizePhone(trimmed);
    if (phoneNormalized) {
      OR.push({ customer: { phoneNormalized } });
    } else {
      OR.push({ customer: { fullName: { contains: trimmed, mode: 'insensitive' } } });
    }

    const orders = await this.prisma.order.findMany({
      where: { OR },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: ORDER_SEARCH_SELECT,
    });

    // Помечаем, какие заказы вне основной области видимости пользователя —
    // UI показывает предупреждение, но не блокирует приём оплаты.
    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scope: user.scope,
      storeIds: user.storeIds,
      userId: user.id,
    });
    const inScope = await this.prisma.order.findMany({
      where: { AND: [{ id: { in: orders.map((o) => o.id) } }, scopeFilter] },
      select: { id: true },
    });
    const inScopeIds = new Set(inScope.map((o) => o.id));

    return orders.map((order) => ({
      ...order,
      statusLabel: statusLabel(order.status),
      outsideScope: !inScopeIds.has(order.id),
    }));
  }

  /** Карточка заказа со всеми связанными данными (ТЗ п. 2.1). */
  async findOne(orderId: string, user: AuthenticatedUser): Promise<OrderCard> {
    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scope: user.scope,
      storeIds: user.storeIds,
      userId: user.id,
    });

    const order = await this.prisma.order.findFirst({
      where: { AND: [{ id: orderId }, scopeFilter] },
      include: ORDER_CARD_INCLUDE,
    });

    // Не найдено ИЛИ вне области видимости → 404, не 403.
    if (!order) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    // Доступные действия для текущего пользователя — UI не дублирует матрицу прав.
    const availableActions = this.workflow.getAvailableTransitions(
      order.status,
      user.primaryRole,
    );

    return {
      ...order,
      statusLabel: statusLabel(order.status),
      isOverdue: order.dueAt != null && order.dueAt < new Date(),
      remainingMinor: Math.max(0, order.totalAmountMinor - order.paidAmountMinor),
      canStartWork:
        !order.requiresPrepayment || order.paidAmountMinor >= order.prepaymentRequiredMinor,
      availableTransitions: availableActions.map((rule) => ({
        to: rule.to,
        label: rule.label,
        requiresReason: rule.requiresReason,
      })),
    };
  }

  /** Единая лента событий заказа: статусы, платежи, согласования, корректировки. */
  async getTimeline(orderId: string, user: AuthenticatedUser): Promise<TimelineEntry[]> {
    const order = await this.findOne(orderId, user);

    const entries: TimelineEntry[] = [
      ...order.statusHistory.map((h) => ({
        type: 'STATUS' as const,
        at: h.createdAt,
        title: `Статус: ${statusLabel(h.toStatus)}`,
        actor: h.changedBy?.fullName ?? (h.isSystem ? 'Система' : null),
        details: { from: h.fromStatus, to: h.toStatus, reason: h.reason },
      })),
      ...order.payments.map((p) => ({
        type: 'PAYMENT' as const,
        at: p.paidAt,
        title: `Платёж: ${(p.amountMinor / 100).toFixed(2)} ₽`,
        actor: null,
        details: { kind: p.kind, method: p.method, status: p.status },
      })),
      ...order.approvals.map((a) => ({
        type: 'APPROVAL' as const,
        at: a.approvedAt ?? a.createdAt,
        title: a.isVerbal ? 'Согласовано устно' : 'Согласование',
        actor: a.createdBy?.fullName ?? null,
        details: { amountMinor: a.amountMinor, result: a.result, channel: a.channel },
      })),
      ...order.adjustments.map((adj) => ({
        type: 'ADJUSTMENT' as const,
        at: adj.createdAt,
        title: `Корректировка: ${(adj.deltaMinor / 100).toFixed(2)} ₽`,
        actor: adj.adjustedBy?.fullName ?? null,
        details: { reason: adj.reason, before: adj.amountBeforeMinor, after: adj.amountAfterMinor },
      })),
    ];

    return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  /**
   * Сводка для дашборда: количество заказов по группам статусов.
   *
   * Считается на сервере, а не на клиенте: список ограничен областью
   * видимости роли и первой страницей, поэтому подсчёт по загруженным
   * строкам дал бы неверные числа (например, «просрочено: 1» вместо 40).
   * Один `groupBy` вместо нескольких запросов — дашборд открывается быстрее.
   */
  async getSummary(user: AuthenticatedUser): Promise<OrderSummary> {
    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scope: user.scope,
      storeIds: user.storeIds,
      userId: user.id,
    });

    const now = new Date();

    const [aggregate, byStatus, overdueCount, unclaimedCount, awaitingPrepaymentCount] =
      await Promise.all([
        this.prisma.order.aggregate({ where: scopeFilter, _count: { _all: true } }),
        this.prisma.order.groupBy({
          by: ['status'],
          where: scopeFilter,
          _count: { _all: true },
        }),
        this.prisma.order.count({ where: { AND: [scopeFilter, { dueAt: { lt: now } }] } }),
        this.prisma.order.count({
          where: { AND: [scopeFilter, { status: ORDER_STATUS.UNCLAIMED }] },
        }),
        this.prisma.order.count({
          where: { AND: [scopeFilter, { status: ORDER_STATUS.AWAITING_PREPAYMENT }] },
        }),
      ]);

    const counts = new Map<OrderStatus, number>();
    for (const row of byStatus) {
      counts.set(row.status, row._count._all);
    }

    return {
      total: aggregate._count._all,
      overdue: overdueCount,
      unclaimed: unclaimedCount,
      awaitingPrepayment: awaitingPrepaymentCount,
      inProduction: counts.get(ORDER_STATUS.IN_PRODUCTION) ?? 0,
      readyForPickup: counts.get(ORDER_STATUS.READY_FOR_PICKUP) ?? 0,
      awaitingApproval: counts.get(ORDER_STATUS.AWAITING_APPROVAL) ?? 0,
      inTransit:
        (counts.get(ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION) ?? 0) +
        (counts.get(ORDER_STATUS.IN_TRANSIT_TO_STORE) ?? 0) +
        (counts.get(ORDER_STATUS.QUEUED_FOR_DISPATCH) ?? 0),
    };
  }

  /**
   * Зафиксировать согласование клиента по сумме и сроку (ТЗ п. 2.4).
   *
   * Зачем это отдельная операция, а не поле заказа: согласование — это факт
   * разговора с клиентом, у него есть канал, автор и время. Переход
   * `AWAITING_APPROVAL → AWAITING_PREPAYMENT` заблокирован guard-условием
   * `APPROVAL_EXISTS`, поэтому без этой операции заказ навсегда оставался бы
   * в статусе «ожидает согласования».
   *
   * Результат `REJECTED`/`NO_ANSWER` тоже сохраняется: важно знать, что клиенту
   * звонили и он отказался, а не что ему не звонили вовсе.
   */
  async createApproval(
    orderId: string,
    input: unknown,
    user: AuthenticatedUser,
  ): Promise<OrderCard> {
    const parsed = approvalSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    /*
     * Терминальные статусы: согласовывать закрытый заказ бессмысленно, а запись
     * в истории вводила бы в заблуждение — «согласовано» после выдачи изделия.
     */
    await this.prisma.runInTransaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: {
          AND: [
            { id: orderId },
            this.prisma.buildOrderScopeFilter({
              scope: user.scope,
              storeIds: user.storeIds,
              userId: user.id,
            }),
          ],
        },
        select: { id: true, status: true, totalAmountMinor: true },
      });

      if (order === null) {
        // Не найдено ИЛИ вне области видимости → 404, не 403 (защита от IDOR).
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
      }

      if (isTerminalStatus(order.status)) {
        throw new ConflictException({
          code: 'ORDER_FINAL',
          message: 'Заказ закрыт — согласование невозможно',
        });
      }

      /*
       * Для устного согласия `isVerbal` выставляется автоматически по каналу,
       * а не принимается от клиента: это не отдельный флаг, а следствие канала.
       * Иначе интерфейс мог бы прислать `channel: SMS, isVerbal: true` и получить
       * бейдж «согласовано устно» без устного разговора.
       */
      const isVerbal = data.channel === 'PHONE_VERBAL';
      const isApproved = data.result === 'APPROVED';

      /*
       * Обещанный срок считает СЕРВЕР по рабочему календарю. Если положиться на
       * присланную клиентом дату, срок можно поставить на выходной или задним
       * числом, и нормативы этапов (ТЗ п. 2.7) посчитают дедлайн неверно.
       */
      let promisedAt: Date | null = null;
      if (isApproved && data.termDays !== undefined) {
        const calendar = await this.workflow.loadCalendar();
        promisedAt = addWorkingDays(new Date(), data.termDays, calendar);
      }

      const created = await tx.approval.create({
        data: {
          orderId: order.id,
          channel: data.channel,
          result: data.result,
          isVerbal,
          amountMinor: data.amountMinor,
          termDays: data.termDays ?? null,
          promisedAt,
          comment: data.comment ?? null,
          createdById: user.id,
          // Момент согласия фиксируется только для состоявшегося согласования:
          // для `NO_ANSWER` его нет, и подставлять «сейчас» было бы ложью.
          approvedAt: isApproved ? new Date() : null,
        },
        select: { id: true },
      });

      /*
       * Согласованная сумма может отличаться от суммы заказа: клиент вправе
       * попросить удешевить ремонт. Тогда расхождение фиксируется как
       * корректировка — иначе сумма заказа и согласованная сумма разошлись бы
       * молча, а именно согласованную сумму клиент подтвердил.
       */
      if (isApproved && data.amountMinor !== order.totalAmountMinor) {
        await this.applyAdjustment(tx, {
          orderId: order.id,
          targetType: 'TOTAL',
          targetId: null,
          amountBeforeMinor: order.totalAmountMinor,
          amountAfterMinor: data.amountMinor,
          reason: `Согласование с клиентом (${approvalChannelLabel(data.channel)})`,
          userId: user.id,
        });
      }

      if (isApproved) {
        await tx.order.update({
          where: { id: order.id },
          data: { approvedAt: new Date() },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'APPROVAL_CREATE',
          entity: 'Approval',
          entityId: created.id,
          storeId: null,
          after: {
            orderId: order.id,
            channel: data.channel,
            result: data.result,
            amountMinor: data.amountMinor,
            termDays: data.termDays ?? null,
          },
        },
      });
    });

    return this.findOne(orderId, user);
  }

  /**
   * Данные для печати квитанции и учёт перепечатки (ответ A4, ТЗ п. 2.1).
   *
   * Печать — это действие, а не чтение: каждый вызов увеличивает
   * `receiptPrintCount`. Это защищает от ситуации «клиент принёс квитанцию,
   * а по ней уже выдали другое изделие» — перепечатки видны в истории заказа,
   * и подозрительная вторая копия не остаётся незамеченной.
   *
   * Номер копии (`copyNumber`) — это НОВОЕ значение счётчика, а не текущее:
   * первая печать даёт «Копия № 1».
   */
  async getReceiptData(orderId: string, user: AuthenticatedUser): Promise<ReceiptContext> {
    /*
     * Область видимости проверяется тем же фильтром, что и карточка заказа:
     * печатать чужой заказ нельзя. Отдельная проверка здесь разошлась бы с
     * карточкой — и один из двух путей однажды открыл бы лишнее.
     *
     * Счётчик увеличивается ТОЛЬКО после успешной проверки: иначе неудачная
     * попытка напечатать чужой заказ оставила бы след в его истории.
     */
    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scope: user.scope,
      storeIds: user.storeIds,
      userId: user.id,
    });

    const visible = await this.prisma.order.findFirst({
      where: { AND: [{ id: orderId }, scopeFilter] },
      select: { id: true },
    });
    if (visible === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    const order = await this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          receiptPrintCount: { increment: 1 },
          receiptLastPrintedAt: new Date(),
        },
        select: RECEIPT_SELECT,
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'RECEIPT_PRINT',
          entity: 'Order',
          entityId: orderId,
          after: { copyNumber: updated.receiptPrintCount },
        },
      });

      return updated;
    });

    return {
      orderNo: order.orderNo,
      createdAt: order.createdAt,
      dueAt: order.dueAt,
      status: order.status,
      statusLabel: statusLabel(order.status),
      storeName: order.createdStore.name,
      customerName: order.customer.fullName,
      customerPhone: formatPhone(order.customer.phoneNormalized),
      items: order.items.map((i) => ({ name: i.name, metal: i.metal })),
      works: order.works.map((w) => ({ name: w.name, amountMinor: w.amountMinor })),
      stones: order.stones.map((s) => ({ name: s.name, amountMinor: s.amountMinor })),
      worksTotalMinor: order.worksTotalMinor,
      stonesTotalMinor: order.stonesTotalMinor,
      discountMinor: order.discountMinor,
      totalAmountMinor: order.totalAmountMinor,
      paidAmountMinor: order.paidAmountMinor,
      prepaymentRequiredMinor: order.prepaymentRequiredMinor,
      requiresPrepayment: order.requiresPrepayment,
      isWarranty: order.isWarranty,
      description: order.description,
      companyName: this.config.get<string>('COMPANY_NAME') ?? 'РЕМИКС ГОЛД',
      acceptedBy: order.createdBy.fullName,
      copyNumber: order.receiptPrintCount,
    };
  }

  /**
   * Скорректировать калькуляцию с обязательной причиной (ТЗ п. 2.3).
   *
   * Сумма заказа меняется ТОЛЬКО здесь: прямого API «поставить totalAmountMinor»
   * не существует, иначе причина правки терялась бы, и в истории осталось бы
   * необъяснимое изменение суммы.
   */
  async createAdjustment(
    orderId: string,
    input: unknown,
    user: AuthenticatedUser,
  ): Promise<OrderCard> {
    const parsed = calcAdjustmentSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    await this.prisma.runInTransaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: {
          AND: [
            { id: orderId },
            this.prisma.buildOrderScopeFilter({
              scope: user.scope,
              storeIds: user.storeIds,
              userId: user.id,
            }),
          ],
        },
        select: {
          id: true,
          status: true,
          worksTotalMinor: true,
          stonesTotalMinor: true,
          discountMinor: true,
          totalAmountMinor: true,
          paidAmountMinor: true,
        },
      });

      if (order === null) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
      }

      if (isTerminalStatus(order.status)) {
        throw new ConflictException({
          code: 'ORDER_FINAL',
          message: 'Заказ закрыт — корректировка невозможна',
        });
      }

      /*
       * Текущее значение цели: для строки калькуляции — её сумма, для итога —
       * итог заказа. «Было» обязан посчитать сервер: если принять его от
       * клиента, в истории окажется сумма, которой в заказе не было.
       */
      const before = await this.resolveAdjustmentTarget(tx, order, data);

      /*
       * Уменьшение ниже уже внесённой суммы — это фактически возврат денег,
       * который оформляется отдельной операцией (`REFUND`) с фиксацией кассира
       * и кассы. Проведя его как корректировку, мы получили бы заказ, где
       * «оплачено» больше «итога», и расхождение при сверке с 1С.
       */
      if (data.amountAfterMinor < order.paidAmountMinor) {
        throw new ConflictException({
          code: 'ADJUSTMENT_BELOW_PAID',
          message: 'Новая сумма меньше уже внесённой. Оформите возврат отдельной операцией.',
          details: { paidMinor: order.paidAmountMinor, requestedMinor: data.amountAfterMinor },
        });
      }

      await this.applyAdjustment(tx, {
        orderId: order.id,
        targetType: data.targetType,
        targetId: data.targetId ?? null,
        amountBeforeMinor: before,
        amountAfterMinor: data.amountAfterMinor,
        reason: data.reason,
        userId: user.id,
      });
    });

    return this.findOne(orderId, user);
  }

  /**
   * Применить корректировку: запись в историю + пересчёт заказа.
   *
   * Вынесено отдельной функцией, потому что вызывается из двух мест —
   * ручной корректировки и согласования суммы с клиентом. Дублирование этой
   * логики означало бы, что один из путей однажды забудет пересчитать итог.
   */
  private async applyAdjustment(
    tx: Prisma.TransactionClient,
    params: {
      orderId: string;
      targetType: string;
      targetId: string | null;
      amountBeforeMinor: number;
      amountAfterMinor: number;
      reason: string;
      userId: string;
    },
  ): Promise<void> {
    const delta = params.amountAfterMinor - params.amountBeforeMinor;

    await tx.calcAdjustment.create({
      data: {
        orderId: params.orderId,
        targetType: params.targetType,
        targetId: params.targetId,
        amountBeforeMinor: params.amountBeforeMinor,
        amountAfterMinor: params.amountAfterMinor,
        deltaMinor: delta,
        reason: params.reason,
        adjustedById: params.userId,
      },
    });

    /*
     * Пересчёт итога. Строка калькуляции меняет свою сумму, поэтому сначала
     * обновляется она, а `worksTotalMinor`/`stonesTotalMinor` пересчитываются
     * как сумма строк — иначе итог заказа разошёлся бы с суммой строк.
     * Для `TOTAL` меняется только итог (это скидка или её отмена).
     */
    const order = await tx.order.findFirstOrThrow({
      where: { id: params.orderId },
      select: { worksTotalMinor: true, stonesTotalMinor: true, discountMinor: true },
    });

    let worksTotal = order.worksTotalMinor;
    let stonesTotal = order.stonesTotalMinor;
    let discount = order.discountMinor;

    if (params.targetType === 'TOTAL') {
      /*
       * Скидка подбирается так, чтобы итог стал заданным. Может оказаться
       * ОТРИЦАТЕЛЬНОЙ: клиент вправе согласовать сумму больше суммы строк
       * (надбавка за срочность, доплата за сложность). Схема это допускает
       * (`discountMinor` — обычный Int), а инвариант
       * `итог = работы + камни − скидка` остаётся точным при любом знаке.
       *
       * Обнулять скидку и присваивать итог напрямую нельзя: при надбавке
       * `работы + камни − скидка` перестало бы равняться итогу, и ночная
       * сверка итогов с платежами дала бы расхождение. Именно эта ошибка
       * здесь и была — расчёт вынесен в `discountForTotal` и покрыт тестом.
       */
      discount = discountForTotal({
        worksTotalMinor: worksTotal,
        stonesTotalMinor: stonesTotal,
        targetTotalMinor: params.amountAfterMinor,
      });
    } else {
      const amount = params.amountAfterMinor;
      if (params.targetType === 'WORK' && params.targetId !== null) {
        await tx.orderWork.update({
          where: { id: params.targetId },
          data: { amountMinor: amount },
        });
        const rows = await tx.orderWork.aggregate({
          where: { orderId: params.orderId },
          _sum: { amountMinor: true },
        });
        worksTotal = rows._sum.amountMinor ?? 0;
      } else if (params.targetType === 'STONE' && params.targetId !== null) {
        await tx.orderStone.update({
          where: { id: params.targetId },
          data: { amountMinor: amount },
        });
        const rows = await tx.orderStone.aggregate({
          where: { orderId: params.orderId },
          _sum: { amountMinor: true },
        });
        stonesTotal = rows._sum.amountMinor ?? 0;
      }
    }

    /*
     * Итог всегда вычисляется из строк и скидки — даже для `TOTAL`.
     * Для `TOTAL` это даёт ровно `amountAfterMinor` (скидка подобрана так,
     * чтобы так вышло), но запись идёт через общую формулу: если однажды
     * появится третий слагаемый итог, он не будет забыт в одной из веток.
     */
    const newTotal = calcOrderTotal({
      worksTotalMinor: worksTotal,
      stonesTotalMinor: stonesTotal,
      discountMinor: discount,
    });

    await tx.order.update({
      where: { id: params.orderId },
      data: {
        worksTotalMinor: worksTotal,
        stonesTotalMinor: stonesTotal,
        discountMinor: discount,
        totalAmountMinor: newTotal,
        // Оптимистичная блокировка: карточка, открытая до корректировки,
        // не сможет перевести заказ по устаревшей версии.
        version: { increment: 1 },
      },
    });
  }

  /** Текущее значение цели корректировки — считает сервер, не клиент. */
  private async resolveAdjustmentTarget(
    tx: Prisma.TransactionClient,
    order: {
      id: string;
      worksTotalMinor: number;
      stonesTotalMinor: number;
      discountMinor: number;
      totalAmountMinor: number;
    },
    data: CalcAdjustmentInput,
  ): Promise<number> {
    if (data.targetType === 'TOTAL') {
      return order.totalAmountMinor;
    }

    if (data.targetId === undefined) {
      throw new BadRequestException({
        code: 'TARGET_ID_REQUIRED',
        message: 'Для корректировки строки калькуляции укажите targetId',
      });
    }

    /*
     * Строка ищется вместе с `orderId`: без этого условия чужой `targetId`
     * изменил бы строку другого заказа, а «было» было бы взято не оттуда.
     * Несовпадение отдаёт 404 — не подтверждаем существование чужой строки.
     */
    if (data.targetType === 'WORK') {
      const work = await tx.orderWork.findFirst({
        where: { id: data.targetId, orderId: order.id },
        select: { amountMinor: true },
      });
      if (work === null) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Работа не найдена' });
      }
      return work.amountMinor;
    }

    const stone = await tx.orderStone.findFirst({
      where: { id: data.targetId, orderId: order.id },
      select: { amountMinor: true },
    });
    if (stone === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Камень не найден' });
    }
    return stone.amountMinor;
  }

  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id })).toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
        c: string;
        i: string;
      };
      return { createdAt: new Date(parsed.c), id: parsed.i };
    } catch {
      return null;
    }
  }
}