import {
  Logger,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  BATCH_DIRECTION,
  BATCH_STATUS,
  ROLE,
  buildBatchNo,
  batchCompositionLockReason,
  buildBatchActNo,
  buildBatchActSnapshot,
  checkBatchEligibility,
  documentDateParts,
  normalizeScanInput,
  parseOrderNoFromScan,
  exceedsBatchLimit,
  partitionBatchCandidates,
  batchDispatchLockReason,
  batchSenderKind,
  batchSourceWorkshopMessage,
  resolveBatchSourceWorkshop,
  BATCH_SENDER,
  batchListQuerySchema,
  batchOrderTargetStatus,
  batchPhotoDeleteLockReason,
  batchPhotoUploadLockReason,
  batchReceiveLockReason,
  canDeleteBatchPhoto,
  canDispatchBatch,
  canReceiveBatch,
  canUploadBatchPhoto,
  createBatchSchema,
  batchOrdersSchema,
  removeBatchOrderSchema,
  signBatchActSchema,
  assessTransit,
  DEFAULT_TRANSIT_NORM_HOURS,
  type BatchActSnapshot,
  type BatchDirection,
  type BatchSenderKind,
  type BatchStatus,
  type TransitState,
} from '@app/shared';

import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { BatchActPdfService } from './batch-act-pdf.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import { NotificationsService, TEMPLATE_CODE } from '../notifications/notifications.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Партия так, как её видит интерфейс.
 *
 * `itemsCount` берётся из поля, а не считается по `items`: состав может быть
 * исключён (`removedAt`), и «сколько заказов сейчас в партии» — это число
 * активных строк, а не всех когда-либо добавленных.
 */
export interface BatchDto {
  id: string;
  batchNo: string;
  direction: BatchDirection;
  status: string;
  fromStoreId: string | null;
  fromStoreName: string | null;
  /**
   * Цех-отправитель партии «в магазин» (дефект 76).
   *
   * Нужен интерфейсу и акту: отправку из цеха прежде можно было записать только
   * как «из магазина», и документ называл не того, кто передал изделия.
   */
  fromWorkshopId: string | null;
  fromWorkshopName: string | null;
  /**
   * Кто отправитель по направлению партии: магазин или цех.
   *
   * Вычисляется, а не хранится: это следствие маршрута, и отдельное поле могло
   * бы разойтись с `direction` после правки направления.
   */
  senderKind: BatchSenderKind;
  toStoreId: string | null;
  toStoreName: string | null;
  toWorkshopId: string | null;
  toWorkshopName: string | null;
  courierId: string | null;
  plannedAt: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
  itemsCount: number;
  comment: string | null;
  createdAt: string;
  /*
   * Отслеживание «в пути» (задача 2.6). Считается на чтение, а не хранится:
   * «в пути 6 часов» — это разница между текущим моментом и отправкой, и
   * записанное в базу значение устарело бы сразу после записи.
   */
  transit: TransitState;
}

/** Фотофиксация партии (задача 2.4). */
export interface BatchPhotoDto {
  id: string;
  batchId: string;
  caption: string | null;
  createdAt: string;
  mimeType: string;
  sizeBytes: number;
  /** Адрес для показа. Ключ хранилища наружу не отдаётся. */
  url: string;
  thumbnailUrl: string;
}

/** Заказ в составе партии. */
export interface BatchItemDto {
  orderId: string;
  orderNo: string;
  status: string;
  customerName: string;
  totalAmountMinor: number;
  /**
   * Заказ возвращён из цеха БЕЗ работ (отказ клиента, дефект 67).
   *
   * При приёмке рейса «в магазин» такой заказ закроется статусом «Отказ до
   * начала работ», а не станет «Готов к выдаче».
   */
  returnedWithoutWork: boolean;
  addedAt: string;
  addedById: string;
}

export interface BatchDetailDto extends BatchDto {
  items: BatchItemDto[];
}

/** Акт приёма-передачи так, как его видит интерфейс. */
export interface BatchActDto {
  id: string;
  actNo: string;
  batchId: string;
  batchNo: string;
  itemsCount: number;
  totalAmountMinor: number;
  formedAt: string;
  signedByFromId: string | null;
  signedByToId: string | null;
  signedFromAt: string | null;
  signedToAt: string | null;
  /** Подписан ли акт обеими сторонами. */
  isFullySigned: boolean;
  /** Есть ли PDF для скачивания. */
  hasPdf: boolean;
  snapshot: BatchActSnapshot;
}

/**
 * Статусы партии, при которых заказ считается «занятым».
 *
 * `RECEIVED` и `CANCELLED` в этот список НЕ входят: принятая партия выполнила
 * свою задачу, а отменённая — не состоялась. Заказ из них можно включить в
 * новую партию (например, возврат в цех после приёмки или повторная отправка
 * после отмены рейса). Если бы эти статусы блокировали, заказ навсегда остался
 * бы «в партии», которой уже нет.
 */
const ACTIVE_BATCH_STATUSES = [
  BATCH_STATUS.DRAFT,
  BATCH_STATUS.ACT_FORMED,
  BATCH_STATUS.IN_TRANSIT,
] as const;

/**
 * Название организации в шапке акта.
 *
 * Вынесено константой, а не берётся из настроек: реквизиты организации не
 * меняются в ходе работы, а в акте они обязательны. Когда появится справочник
 * организации (этап 5), значение переедет туда.
 */
const COMPANY_NAME = 'Ремонт ювелирных изделий';

/** Лимит состава партии по умолчанию: не ограничен (решение по задаче 2.1). */
const DEFAULT_MAX_ITEMS: number | null = null;

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly actPdf: BatchActPdfService,
    private readonly workflow: OrderWorkflowService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Список партий с фильтрами и keyset-пагинацией.
   *
   * Курсор — `id` последней строки: сортировка по `createdAt` неустойчива при
   * совпадении времени, и часть партий могла бы выпасть между страницами.
   */
  async list(
    rawQuery: unknown,
    actor: AuthenticatedUser,
  ): Promise<{ items: BatchDto[]; nextCursor: string | null }> {
    const query = parseOrThrow(batchListQuerySchema, normalizeQuery(rawQuery));
    const where: Prisma.BatchWhereInput = {};

    if (query.status !== undefined && query.status.length > 0) {
      where.status = { in: query.status };
    }
    if (query.direction !== undefined) where.direction = query.direction;
    if (query.fromStoreId !== undefined) where.fromStoreId = query.fromStoreId;
    if (query.toWorkshopId !== undefined) where.toWorkshopId = query.toWorkshopId;
    if (query.plannedOn !== undefined) {
      /*
       * Плановая дата сравнивается по ГРАНИЦАМ МОСКОВСКИХ СУТОК, а не как
       * «начало суток UTC». `plannedAt` хранится моментом времени, а рабочий
       * день точки — московский: при сравнении с UTC партия, назначенная на
       * 1 октября 01:00 МСК, попала бы в выборку за 30 сентября.
       */
      where.plannedAt = {
        gte: moscowDayStart(query.plannedOn),
        lt: moscowDayStart(nextDayKey(query.plannedOn)),
      };
    }

    const scopeFilter = this.buildScopeFilter(actor);
    const rows = await this.prisma.batch.findMany({
      where: { AND: [where, scopeFilter] },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      include: {
        fromStore: { select: { name: true } },
        fromWorkshop: { select: { name: true } },
        toStore: { select: { name: true } },
        toWorkshop: { select: { name: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    // Норматив читается один раз на страницу, а не в каждой строке: значение
    // одно и то же, а запрос на строку превратил бы список в N+1.
    const normHours = await this.transitNormHours(this.prisma);
    const now = new Date();

    return {
      items: page.map((row) => this.toDto(row, normHours, now)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Партии, которые сейчас в пути (задача 2.6).
   *
   * Отдельно от `list`, потому что сортировка здесь другая: сначала те, чей
   * норматив превышен сильнее. В обычном списке партии идут по дате создания, и
   * пропавшая сутки назад машина оказалась бы ниже вчерашней городской — то
   * есть ровно то, что требует вмешательства, логист увидел бы последним.
   *
   * Сортировка выполняется в памяти: состояние считается от текущего момента,
   * а не хранится в базе, и `ORDER BY` по нему невозможен. Число партий «в
   * пути» ограничено числом машин в рейсе, поэтому полная выборка здесь
   * допустима.
   */
  async listInTransit(actor: AuthenticatedUser): Promise<BatchDto[]> {
    const rows = await this.prisma.batch.findMany({
      where: { AND: [{ status: BATCH_STATUS.IN_TRANSIT }, this.buildScopeFilter(actor)] },
      include: {
        fromStore: { select: { name: true } },
        fromWorkshop: { select: { name: true } },
        toStore: { select: { name: true } },
        toWorkshop: { select: { name: true } },
      },
    });

    const normHours = await this.transitNormHours(this.prisma);
    const now = new Date();

    return rows
      .map((row) => this.toDto(row, normHours, now))
      .sort((a, b) => (b.transit.elapsedHours ?? 0) - (a.transit.elapsedHours ?? 0));
  }

  /**
   * Доставки курьера: рейсы, назначенные на него (задача 2.7, ТЗ п. 2.6).
   *
   * ЗАЧЕМ ОТДЕЛЬНЫЙ МЕТОД. `listInTransit` отвечает на вопрос «что сейчас в
   * пути» и доступен всем логистам и руководителю — это управленческий взгляд.
   * Курьеру нужен свой узкий список: только его рейсы и только незавершённые
   * (плюс, для истории, недавно завершённые). Показывать ему все рейсы сети
   * бессмысленно, а на телефоне ещё и неудобно.
   *
   * Фильтр по `courierId` обязателен и стоит первым: без него курьер увидел бы
   * чужие рейсы, а вместе с ними — адреса, состав и суммы чужих заказов.
   */
  async listMyDeliveries(actor: AuthenticatedUser): Promise<BatchDto[]> {
    /*
     * Роль решает, что видно.
     *
     * Отдельной роли «курьер» в системе нет: по матрице ролей
     * (docs/02 §4) доставку ведёт `LOGISTICIAN` — «Логист / курьер». Поэтому
     * «свой список» определяется не ролью, а НАЗНАЧЕНИЕМ: логист-курьер видит
     * рейсы, назначенные на него, а руководитель производства, который рейсы
     * распределяет, — все незавершённые, включая ещё не назначенные: иначе он
     * не смог бы раздать то, чего не видит.
     */
    const seesAll =
      actor.roles.includes(ROLE.PRODUCTION_MANAGER) || actor.roles.includes(ROLE.ADMIN);

    const where: Prisma.BatchWhereInput = seesAll ? {} : { courierId: actor.id };

    const rows = await this.prisma.batch.findMany({
      where: {
        AND: [
          where,
          // Завершённые рейсы в списке не нужны: курьеру важно то, что он ещё
          // должен отвезти. История доступна в карточке партии.
          { status: { notIn: [BATCH_STATUS.RECEIVED, BATCH_STATUS.CANCELLED] } },
          this.buildScopeFilter(actor),
        ],
      },
      include: {
        fromStore: { select: { name: true } },
        fromWorkshop: { select: { name: true } },
        toStore: { select: { name: true } },
        toWorkshop: { select: { name: true } },
      },
      take: 100,
    });

    const normHours = await this.transitNormHours(this.prisma);
    const now = new Date();

    /*
     * Порядок: сначала то, что уже в пути (и дольше всех — сверху), затем
     * назначенное. Курьер должен видеть задержку раньше плана.
     */
    return rows
      .map((row) => this.toDto(row, normHours, now))
      .sort((a, b) => {
        const aTransit = a.status === BATCH_STATUS.IN_TRANSIT ? 1 : 0;
        const bTransit = b.status === BATCH_STATUS.IN_TRANSIT ? 1 : 0;
        if (aTransit !== bTransit) return bTransit - aTransit;
        return (b.transit.elapsedHours ?? 0) - (a.transit.elapsedHours ?? 0);
      });
  }

  /**
   * Найти партию по отсканированному коду (задача 2.7).
   *
   * ЗАЧЕМ НА СЕРВЕРЕ, А НЕ В ИНТЕРФЕЙСЕ. Номер партии (`П-250916-001`) — не
   * номер заказа, и `normalizeScanInput` его не распознаёт: она ищет формат
   * заказа (`MSK1-2509-000001`), потому что квитанция клиента содержит именно
   * его. Курьер сканирует НАКЛАДНУЮ рейса, и её номер надо разобрать отдельно.
   *
   * Разбор идёт на сервере, потому что сканер «печатает» содержимое QR в поле:
   * туда может попасть и полный URI, и номер с переводом строки, и лишние
   * пробелы. Мобильный экран отправляет то, что получил, а приводит в порядок
   * та сторона, где правила уже описаны и покрыты тестами.
   *
   * Поиск идёт по точному номеру и, если он не найден, по номеру ЗАКАЗА из
   * состава: курьер может сканировать не накладную, а квитанцию изделия,
   * чтобы понять, в каком рейсе оно едет.
   */
  async findByScan(raw: string, actor: AuthenticatedUser): Promise<BatchDetailDto> {
    const term = normalizeScanInput(raw);
    if (term.length < 3) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Введите минимум 3 символа для поиска',
      });
    }

    const scopeFilter = this.buildScopeFilter(actor);

    // 1. Точный номер партии (без учёта регистра: «п-250916-001» тоже годится).
    const byNumber = await this.prisma.batch.findFirst({
      where: { AND: [{ batchNo: { equals: term, mode: 'insensitive' } }, scopeFilter] },
      select: { id: true },
    });
    if (byNumber !== null) return this.findOne(byNumber.id, actor);

    // 2. Номер заказа из состава рейса.
    const orderNo = parseOrderNoFromScan(raw) ?? term;
    const byOrder = await this.prisma.batch.findFirst({
      where: {
        AND: [
          {
            items: {
              some: {
                removedAt: null,
                order: { orderNo: { equals: orderNo, mode: 'insensitive' } },
              },
            },
          },
          scopeFilter,
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (byOrder !== null) return this.findOne(byOrder.id, actor);

    /*
     * Ничего не найдено — 404, а не пустой объект. Курьер должен увидеть, что
     * код не распознан, и повторить сканирование; пустой ответ выглядел бы как
     * «рейс есть, но пустой».
     */
    throw new NotFoundException({
      code: 'BATCH_NOT_FOUND',
      message: `Партия по коду «${term}» не найдена`,
    });
  }

  /** Партия с составом. */
  async findOne(id: string, actor: AuthenticatedUser): Promise<BatchDetailDto> {
    const scopeFilter = this.buildScopeFilter(actor);
    const batch = await this.prisma.batch.findFirst({
      where: { AND: [{ id }, scopeFilter] },
      include: {
        fromStore: { select: { name: true } },
        fromWorkshop: { select: { name: true } },
        toStore: { select: { name: true } },
        toWorkshop: { select: { name: true } },
        items: {
          where: { removedAt: null },
          orderBy: { addedAt: 'asc' },
          include: {
            order: {
              select: {
                orderNo: true,
                status: true,
                totalAmountMinor: true,
                /*
                 * Отметка «вернулся без работ» (дефект 67). Интерфейс по ней
                 * сообщает, что часть заказов рейса закроется отказом, а не
                 * станет «Готов к выдаче»: без неё обещание «заказы перейдут в
                 * такой-то статус» было бы неверным для смешанного рейса.
                 */
                returnedWithoutWorkAt: true,
                customer: { select: { fullName: true } },
              },
            },
          },
        },
      },
    });

    if (batch === null) throw new NotFoundException('Партия не найдена');

    return {
      ...this.toDto(batch, await this.transitNormHours(this.prisma)),
      items: batch.items.map((item) => ({
        orderId: item.orderId,
        orderNo: item.order.orderNo,
        status: item.order.status,
        customerName: item.order.customer.fullName,
        totalAmountMinor: item.order.totalAmountMinor,
        returnedWithoutWork: item.order.returnedWithoutWorkAt !== null,
        addedAt: item.addedAt.toISOString(),
        addedById: item.addedById,
      })),
    };
  }

  /**
   * Создать партию.
   *
   * Номер генерируется в той же транзакции, что и запись: иначе два логиста,
   * нажавшие «создать» одновременно, получили бы один номер, и второй запрос
   * упал бы на уникальном индексе вместо понятной ошибки.
   */
  /**
   * Цех-отправитель партии «в магазин» (дефект 76).
   *
   * Определяется АВТОМАТИЧЕСКИ по цеху заказов партии: привязки «пользователь →
   * цех» в системе нет (`user_store` есть, `user_workshop` нет), а изделия
   * физически находятся там, где их ремонтировали. Это и надёжнее привязки
   * сотрудника: даже если менеджер переведён в другой цех, документ назовёт цех,
   * откуда изделия действительно уехали.
   *
   * Для партии «в цех» возвращается `null`: там отправляет магазин, и цех
   * появится только как получатель.
   *
   * Если цех определить нельзя, партия НЕ создаётся. Подставить произвольный
   * цех значило бы снова напечатать в акте не того отправителя — ровно то, на
   * что жаловался заказчик.
   */
  private async resolveSenderWorkshop(
    tx: Prisma.TransactionClient,
    input: { direction: BatchDirection },
    orderIds: readonly string[],
  ): Promise<string | null> {
    if (batchSenderKind(input.direction) !== BATCH_SENDER.WORKSHOP) return null;

    /*
     * Партию можно создать ПУСТОЙ и наполнить её в карточке — это штатный
     * сценарий (логист формирует рейс, затем подбирает изделия). Цех в этот
     * момент определить не по чему, и это не ошибка: он появится, когда в партию
     * попадёт первый заказ. Требовать заказы при создании значило бы сломать
     * существующий порядок работы.
     */
    if (orderIds.length === 0) return null;

    const orders = await tx.order.findMany({
      where: { id: { in: [...orderIds] } },
      select: { workshopId: true },
    });

    const resolved = resolveBatchSourceWorkshop(orders.map((order) => order.workshopId));
    if (!resolved.ok) {
      throw new ConflictException({
        code: 'BATCH_SENDER_UNKNOWN',
        message: batchSourceWorkshopMessage(resolved.reason),
        details: { reason: resolved.reason },
      });
    }

    return resolved.workshopId;
  }

  async create(rawInput: unknown, actor: AuthenticatedUser): Promise<BatchDetailDto> {
    const input = parseOrThrow(createBatchSchema, rawInput);
    const orderIds = input.orderIds ?? [];

    const created = await this.prisma.runInTransaction(async (tx) => {
      /*
       * Дата в номере партии — ПЛАНОВАЯ ДАТА ОТПРАВКИ, а не момент создания
       * записи. Партия формируется по графику (ТЗ п. 2.6): рейс на 16 сентября
       * логист планирует заранее, и номер `П-250916-…` означает «партия рейса
       * 16 сентября». Номер по дате создания говорил бы о другом дне и не
       * совпадал бы ни с актом, ни с графиком курьера.
       *
       * Если плановая дата не задана, берётся текущий момент — тогда партия
       * отправляется «сейчас», и обе даты совпадают.
       */
      const plannedAt = input.plannedAt ?? new Date();
      const { year, month, day } = documentDateParts(plannedAt);

      /*
       * Счётчик партий — на КАЛЕНДАРНЫЙ ДЕНЬ по Москве, и область счётчика
       * привязана к ТОЙ ЖЕ дате, что стоит в номере. Иначе два рейса разных
       * дней получали бы номера из общей последовательности, и «четвёртая
       * партия за 16 сентября» перестала бы быть четвёртой.
       */
      const scope = `BATCH:${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
      const counter = await tx.counter.upsert({
        where: { scope },
        update: { value: { increment: 1 } },
        create: { scope, value: 1 },
      });

      const batchNo = buildBatchNo(plannedAt, counter.value);

      /*
       * ОТПРАВИТЕЛЬ ОПРЕДЕЛЯЕТСЯ ПО НАПРАВЛЕНИЮ, а не выбирается сотрудником
       * (дефект 76). Прежде `fromStoreId` приходил из формы независимо от
       * направления, и отправка из цеха в магазин записывалась как «из
       * магазина»: в акте приёма-передачи отправителем значился магазин, хотя
       * изделия передал цех. Это документ, который подписывают обе стороны.
       */
      const sourceWorkshopId = await this.resolveSenderWorkshop(tx, input, orderIds);

      const batch = await tx.batch.create({
        data: {
          batchNo,
          direction: input.direction,
          status: BATCH_STATUS.DRAFT,
          /*
           * Магазин-отправитель остаётся только у партии «в цех». Для партии «в
           * магазин» он принудительно пуст: иначе в базе оказалось бы и «из
           * магазина», и «из цеха» одновременно, и любой отчёт выбрал бы одно
           * из двух произвольно.
           */
          fromStoreId:
            batchSenderKind(input.direction) === BATCH_SENDER.STORE
              ? (input.fromStoreId ?? null)
              : null,
          fromWorkshopId: sourceWorkshopId,
          toStoreId: input.toStoreId ?? null,
          toWorkshopId: input.toWorkshopId ?? null,
          courierId: input.courierId ?? null,
          plannedAt,
          comment: input.comment ?? null,
          createdById: actor.id,
        },
      });

      if (orderIds.length > 0) {
        await this.addOrdersWithin(tx, batch, orderIds, actor);
      }

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'CREATE',
          entity: 'Batch',
          entityId: batch.id,
          after: {
            batchNo,
            direction: input.direction,
            plannedAt: plannedAt.toISOString(),
            orders: orderIds.length,
          },
        },
      });

      return batch.id;
    });

    return this.findOne(created, actor);
  }

  /**
   * Добавить заказы в партию.
   *
   * Правила включения — из домена (`checkBatchEligibility`), а не свои: то же
   * правило применяет интерфейс, и две реализации разошлись бы.
   */
  async addOrders(
    batchId: string,
    rawInput: unknown,
    actor: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    const input = parseOrThrow(batchOrdersSchema, rawInput);
    await this.prisma.runInTransaction(async (tx) => {
      const scopeFilter = this.buildScopeFilter(actor);
      const batch = await tx.batch.findFirst({ where: { AND: [{ id: batchId }, scopeFilter] } });
      if (batch === null) throw new NotFoundException('Партия не найдена');

      /*
       * Состав заморожен после формирования акта: акт — документ о передаче
       * конкретных изделий, и добавление заказа после подписания сделало бы его
       * недостоверным.
       */
      const lock = batchCompositionLockReason(batch.status);
      if (lock !== null) throw new ConflictException(lock);

      await this.addOrdersWithin(tx, batch, input.orderIds, actor);
    });

    return this.findOne(batchId, actor);
  }

  /** Исключить заказ из партии. Причина обязательна (docs/07 §8). */
  async removeOrder(
    batchId: string,
    orderId: string,
    rawInput: unknown,
    actor: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    const input = parseOrThrow(removeBatchOrderSchema, rawInput);
    await this.prisma.runInTransaction(async (tx) => {
      const scopeFilter = this.buildScopeFilter(actor);
      const batch = await tx.batch.findFirst({ where: { AND: [{ id: batchId }, scopeFilter] } });
      if (batch === null) throw new NotFoundException('Партия не найдена');

      // Та же заморозка, что и при добавлении: состав неизменяем после акта.
      const lock = batchCompositionLockReason(batch.status);
      if (lock !== null) throw new ConflictException(lock);

      /*
       * Строка не удаляется, а помечается `removedAt` с причиной: состав партии
       * входит в акт приёма-передачи, и «куда делся заказ» должно быть
       * объяснимо после подписания.
       */
      const item = await tx.batchItem.findUnique({
        where: { batchId_orderId: { batchId, orderId } },
      });
      if (item === null || item.removedAt !== null) {
        throw new NotFoundException('Заказ не входит в эту партию');
      }

      await tx.batchItem.update({
        where: { batchId_orderId: { batchId, orderId } },
        data: { removedAt: new Date(), removeReason: input.reason },
      });

      // Счётчик состава уменьшается здесь же: он показывается в списке и не
      // должен требовать пересчёта всех строк.
      await tx.batch.update({
        where: { id: batchId },
        data: { itemsCount: { decrement: 1 } },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'UPDATE',
          entity: 'Batch',
          entityId: batchId,
          before: { orderId, inBatch: true },
          after: { orderId, inBatch: false, reason: input.reason },
        },
      });
    });

    return this.findOne(batchId, actor);
  }

  /**
   * Отобрать заказы-кандидаты для партии.
   *
   * Нужен интерфейсу: показать, что можно включить, и объяснить отказ по
   * остальным. Возвращает и подходящие, и отклонённые с причиной.
   */
  async candidates(
    batchId: string,
    actor: AuthenticatedUser,
  ): Promise<{
    eligible: Array<{ id: string; orderNo: string; status: string; warning?: string }>;
    rejected: Array<{ id: string; orderNo: string; reason: string; message: string }>;
  }> {
    const scopeFilter = this.buildScopeFilter(actor);
    const batch = await this.prisma.batch.findFirst({
      where: { AND: [{ id: batchId }, scopeFilter] },
    });
    if (batch === null) throw new NotFoundException('Партия не найдена');

    const alreadyInIds = await this.ordersInActiveBatches(this.prisma);

    /*
     * Кандидаты берутся по статусу, соответствующему направлению партии.
     *
     * Для направления В ЦЕХ дополнительно ограничиваем магазином отправления:
     * машина забирает изделия с одной точки, и заказы из других магазинов
     * заведомо не подходят — показывать их значит заставлять логиста читать
     * длинный список отказов.
     *
     * Для направления В МАГАЗИН такого ограничения НЕТ. Прежде здесь стоял
     * фильтр `createdStoreId: batch.fromStoreId`, и он отсекал ровно те заказы,
     * которые нужны: магазин приёма совпадал с фильтром, после чего проверка
     * отклоняла их как «заказ уже числится в этом магазине». Собрать обратную
     * партию было невозможно (дефект 62, docs/15-known-issues.md).
     * Область видимости по магазину здесь тоже не сужается: менеджер
     * производства собирает рейс на точку, к которой сам не приписан.
     */
    const where: Prisma.OrderWhereInput =
      batch.direction === BATCH_DIRECTION.TO_PRODUCTION
        ? {
            status: 'QUEUED_FOR_DISPATCH',
            ...(batch.fromStoreId === null ? {} : { createdStoreId: batch.fromStoreId }),
          }
        : { status: 'IN_TRANSIT_TO_STORE' };

    const orders = await this.prisma.order.findMany({
      where,
      orderBy: { acceptedAt: 'asc' },
      take: 500,
      select: {
        id: true,
        orderNo: true,
        status: true,
        createdStoreId: true,
        pickupStoreId: true,
        workshopId: true,
      },
    });

    const result = partitionBatchCandidates({
      orders,
      direction: batch.direction,
      fromStoreId: batch.fromStoreId,
      toStoreId: batch.toStoreId,
      toWorkshopId: batch.toWorkshopId,
      alreadyInIds,
    });

    /*
     * Замечания подходящих заказов отдаются интерфейсу: без них предупреждение
     * «заказ принят в другом магазине» осталось бы только в коде.
     */
    const warningById = new Map(result.warnings.map((w) => [w.order.id, w.message]));

    return {
      eligible: result.eligible.map((order) => {
        const warning = warningById.get(order.id);
        return warning === undefined
          ? { id: order.id, orderNo: order.orderNo ?? '', status: order.status }
          : { id: order.id, orderNo: order.orderNo ?? '', status: order.status, warning };
      }),
      rejected: result.rejected.map((entry) => ({
        id: entry.order.id,
        orderNo: entry.order.orderNo ?? '',
        reason: entry.reason,
        message: entry.message,
      })),
    };
  }

  /**
   * Сформировать электронный акт приёма-передачи (задача 2.2).
   *
   * Акт фиксирует состав партии НА МОМЕНТ формирования: `itemsSnapshot` больше
   * не пересчитывается. Иначе переименованный заказ или исправленное ФИО
   * клиента меняли бы уже подписанный документ — а акт должен оставаться тем
   * же, чем его подписали.
   *
   * Формирование и перевод партии в `ACT_FORMED` происходят в ОДНОЙ
   * транзакции. Если бы акт создался, а статус не сменился, партия осталась бы
   * `DRAFT` и допускала правку состава под уже существующим актом.
   */
  async formAct(batchId: string, actor: AuthenticatedUser): Promise<BatchActDto> {
    const actId = await this.prisma.runInTransaction(async (tx) => {
      const scopeFilter = this.buildScopeFilter(actor);
      const batch = await tx.batch.findFirst({
        where: { AND: [{ id: batchId }, scopeFilter] },
        include: {
          fromStore: { select: { name: true } },
          fromWorkshop: { select: { name: true } },
          toStore: { select: { name: true } },
          toWorkshop: { select: { name: true } },
          items: {
            where: { removedAt: null },
            orderBy: { addedAt: 'asc' },
            include: {
              order: {
                select: {
                  orderNo: true,
                  totalAmountMinor: true,
                  customer: { select: { fullName: true } },
                },
              },
            },
          },
        },
      });
      if (batch === null) throw new NotFoundException('Партия не найдена');

      /*
       * Акт формируется только по партии, состав которой утверждён. Пустая
       * партия — это не «акт на ноль изделий»: передавать нечего, и подписывать
       * такой документ бессмысленно.
       */
      if (batch.items.length === 0) {
        throw new BadRequestException('Нельзя сформировать акт: в партии нет заказов');
      }

      // Повторное формирование запрещено: второй акт на ту же партию означал бы
      // два документа о передаче одних и тех же изделий.
      const existing = await tx.batchAct.findFirst({ where: { batchId } });
      if (existing !== null) {
        throw new ConflictException(`Акт по этой партии уже сформирован: ${existing.actNo}`);
      }

      if (batch.status !== BATCH_STATUS.DRAFT) {
        throw new ConflictException(
          `Акт можно сформировать только для черновика (партия в статусе ${batch.status})`,
        );
      }

      const now = new Date();
      const { year } = documentDateParts(now);
      /*
       * Номер акта — годовой (`АПП-25-000118`), в отличие от номера партии,
       * который дневной. Так задан формат в docs/03 §2, и он же записан в
       * комментарии к счётчику; менять формат нельзя, не затронув уже
       * напечатанные акты.
       */
      const scope = `ACT:${year}`;
      const counter = await tx.counter.upsert({
        where: { scope },
        update: { value: { increment: 1 } },
        create: { scope, value: 1 },
      });

      /*
       * Отправитель в акте берётся ПО НАПРАВЛЕНИЮ (дефект 76). Прежде здесь
       * всегда стоял магазин с запасным значением «Магазин», поэтому акт на
       * отправку из цеха называл отправителем магазин — то есть документ,
       * который подписывают обе стороны, указывал не того, кто передал изделия.
       */
      const senderKind = batchSenderKind(batch.direction);
      const fromLabel =
        senderKind === BATCH_SENDER.WORKSHOP
          ? (batch.fromWorkshop?.name ?? 'Цех')
          : (batch.fromStore?.name ?? 'Магазин');

      const snapshot = buildBatchActSnapshot({
        batchNo: batch.batchNo,
        direction: batch.direction,
        fromLabel,
        toLabel: batch.toWorkshop?.name ?? batch.toStore?.name ?? 'Получатель',
        formedAt: now,
        items: batch.items.map((item) => ({
          orderId: item.orderId,
          orderNo: item.order.orderNo,
          customerName: item.order.customer.fullName,
          totalAmountMinor: item.order.totalAmountMinor,
        })),
      });

      const act = await tx.batchAct.create({
        data: {
          batchId,
          actNo: buildBatchActNo(now, counter.value),
          // `itemsSnapshot` хранит снимок целиком: по нему акт читается и
          // печатается без обращения к заказам.
          itemsSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.batch.update({
        where: { id: batchId },
        data: { status: BATCH_STATUS.ACT_FORMED },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'UPDATE',
          entity: 'BatchAct',
          entityId: act.id,
          after: {
            actNo: act.actNo,
            batchNo: batch.batchNo,
            itemsCount: snapshot.itemsCount,
            totalAmountMinor: snapshot.totalAmountMinor,
          },
        },
      });

      return act.id;
    });

    return this.findAct(batchId, actor, actId);
  }

  /** Акт по партии. `actId` позволяет вернуть только что созданный акт. */
  async findAct(batchId: string, actor: AuthenticatedUser, actId?: string): Promise<BatchActDto> {
    const scopeFilter = this.buildScopeFilter(actor);
    const batch = await this.prisma.batch.findFirst({
      where: { AND: [{ id: batchId }, scopeFilter] },
      select: { id: true, batchNo: true },
    });
    if (batch === null) throw new NotFoundException('Партия не найдена');

    const act = await this.prisma.batchAct.findFirst({
      where: { batchId, ...(actId === undefined ? {} : { id: actId }) },
    });
    if (act === null) throw new NotFoundException('Акт по этой партии не сформирован');

    return this.toActDto(act, batch.batchNo);
  }

  /**
   * Подписать акт со стороны отправителя или получателя (задача 2.3).
   *
   * Каждая сторона подписывает один раз: повторная подпись той же стороны
   * отклоняется. Иначе «подпись» переставала бы означать конкретный момент
   * передачи — а именно он и важен при споре о том, кто и когда принял изделие.
   */
  async signAct(
    batchId: string,
    rawInput: unknown,
    actor: AuthenticatedUser,
  ): Promise<BatchActDto> {
    const input = parseOrThrow(signBatchActSchema, rawInput);

    await this.prisma.runInTransaction(async (tx) => {
      const scopeFilter = this.buildScopeFilter(actor);
      const batch = await tx.batch.findFirst({ where: { AND: [{ id: batchId }, scopeFilter] } });
      if (batch === null) throw new NotFoundException('Партия не найдена');

      const act = await tx.batchAct.findFirst({ where: { batchId } });
      if (act === null) throw new NotFoundException('Акт по этой партии не сформирован');

      /*
       * Подписывать можно только сформированный акт. Партия в пути уже уехала:
       * подпись задним числом после отправки не подтверждает передачу, а
       * создаёт видимость её отсутствия в момент отъезда.
       */
      if (batch.status !== BATCH_STATUS.ACT_FORMED) {
        throw new ConflictException(
          `Подписать можно только сформированный акт (партия в статусе ${batch.status})`,
        );
      }

      const now = new Date();
      if (input.side === 'FROM') {
        if (act.signedFromAt !== null) {
          throw new ConflictException('Акт уже подписан отправителем');
        }
        await tx.batchAct.update({
          where: { id: act.id },
          data: { signedByFromId: actor.id, signedFromAt: now },
        });
      } else {
        if (act.signedToAt !== null) {
          throw new ConflictException('Акт уже подписан получателем');
        }
        await tx.batchAct.update({
          where: { id: act.id },
          data: { signedByToId: actor.id, signedToAt: now },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'UPDATE',
          entity: 'BatchAct',
          entityId: act.id,
          after: { actNo: act.actNo, signedSide: input.side, signedAt: now.toISOString() },
        },
      });
    });

    return this.findAct(batchId, actor);
  }

  /**
   * PDF акта (задача 2.3).
   *
   * Документ собирается ИЗ СНИМКА состава: подписанный акт обязан оставаться тем
   * же документом, даже если заказ позже переименовали. PDF не сохраняется в
   * хранилище при каждой печати — он отдаётся потоком; в `BatchAct.pdfFileId`
   * попадает только та версия, которую сохранили явно.
   */
  async buildActPdf(
    batchId: string,
    actor: AuthenticatedUser,
  ): Promise<{ buffer: Buffer; actNo: string }> {
    const scopeFilter = this.buildScopeFilter(actor);
    const batch = await this.prisma.batch.findFirst({
      where: { AND: [{ id: batchId }, scopeFilter] },
      select: { id: true },
    });
    if (batch === null) throw new NotFoundException('Партия не найдена');

    const act = await this.prisma.batchAct.findFirst({ where: { batchId } });
    if (act === null) throw new NotFoundException('Акт по этой партии не сформирован');

    /*
     * ФИО подписавших читаются отдельным запросом, а не через `include`:
     * в схеме `signedByFromId`/`signedByToId` объявлены без связи с `User`,
     * поэтому связь пришлось бы добавлять миграцией. Здесь достаточно одного
     * дополнительного запроса по двум идентификаторам.
     */
    const signerIds = [act.signedByFromId, act.signedByToId].filter(
      (id): id is string => id !== null,
    );
    const signers =
      signerIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: signerIds } },
            select: { id: true, fullName: true },
          });
    const nameById = new Map(signers.map((user) => [user.id, user.fullName]));

    const snapshot = act.itemsSnapshot as unknown as BatchActSnapshot;
    const buffer = await this.actPdf.buildActPdf({
      actNo: act.actNo,
      companyName: COMPANY_NAME,
      snapshot,
      signedByFromName:
        act.signedByFromId === null ? null : (nameById.get(act.signedByFromId) ?? null),
      signedByToName: act.signedByToId === null ? null : (nameById.get(act.signedByToId) ?? null),
      signedFromAt: act.signedFromAt,
      signedToAt: act.signedToAt,
    });

    return { buffer, actNo: act.actNo };
  }

  /**
   * Сохранить подписанный акт в хранилище и привязать файл к акту.
   *
   * Нужно для юридически значимой копии: потоковый PDF нельзя предъявить, а
   * сохранённый — можно. Повторное сохранение заменяет прежний файл: держать
   * несколько копий одного акта значит не знать, какая из них подписана.
   */
  async storeActPdf(batchId: string, actor: AuthenticatedUser): Promise<BatchActDto> {
    const { buffer } = await this.buildActPdf(batchId, actor);

    await this.prisma.runInTransaction(async (tx) => {
      const scopeFilter = this.buildScopeFilter(actor);
      const batch = await tx.batch.findFirst({ where: { AND: [{ id: batchId }, scopeFilter] } });
      if (batch === null) throw new NotFoundException('Партия не найдена');

      const act = await tx.batchAct.findFirst({ where: { batchId } });
      if (act === null) throw new NotFoundException('Акт по этой партии не сформирован');

      const stored = await this.storage.saveRaw({
        buffer,
        folder: `batches/${batchId}/act`,
        extension: 'pdf',
        mimeType: 'application/pdf',
      });

      const fileObject = await tx.fileObject.create({
        data: {
          bucket: 'local',
          objectKey: stored.objectKey,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          uploadedById: actor.id,
        },
      });

      const document = await tx.document.create({
        data: {
          batchId,
          type: 'BATCH_ACT',
          number: act.actNo,
          fileId: fileObject.id,
        },
      });

      /*
       * ВНИМАНИЕ: `BatchAct.pdfFileId` ссылается на `Document`, а не на
       * `FileObject` — несмотря на имя поля. Это видно в схеме:
       * `pdfFile Document? @relation("BatchActPdf", fields: [pdfFileId], ...)`.
       *
       * Здесь стоял `fileObject.id`, и сохранение акта отвечало 500 с нарушением
       * внешнего ключа `batch_act_pdfFileId_fkey`. Юнит-тест этого не поймал:
       * двойник Prisma принимал любой идентификатор. Дефект нашёлся только
       * проверкой на живом сервере. Файл связан с документом через
       * `Document.fileId`, поэтому отдельная ссылка на `FileObject` не нужна.
       */
      await tx.batchAct.update({
        where: { id: act.id },
        data: { pdfFileId: document.id },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'UPDATE',
          entity: 'BatchAct',
          entityId: act.id,
          after: { actNo: act.actNo, storedPdf: true, sizeBytes: stored.sizeBytes },
        },
      });
    });

    return this.findAct(batchId, actor);
  }

  /**
   * Отправить партию (задача 2.5, ТЗ п. 2.6).
   *
   * ЗАЧЕМ ОДНА ТРАНЗАКЦИЯ. Партия переводит в «в пути» СРАЗУ все свои заказы.
   * Если каждый заказ откроет собственную транзакцию, половина партии уедет, а
   * половина останется — и на складе окажется состав, которого нет ни в одном
   * документе: акт подписан на все изделия, а в пути только часть.
   *
   * ПОЧЕМУ ЧЕРЕЗ `OrderWorkflowService`. Таблица переходов и guard-условия
   * живут в одном месте (docs/04 §2). Собственный `UPDATE status` здесь обошёл бы
   * и проверку роли, и обязательность акта, и историю статусов — то есть заказ
   * уехал бы без записи о том, кто и когда его отправил.
   */
  async dispatch(batchId: string, actor: AuthenticatedUser): Promise<BatchDetailDto> {
    return this.moveBatch(batchId, 'DISPATCH', actor);
  }

  /** Принять партию: заказы переходят в производство или в «готов к выдаче». */
  async receive(batchId: string, actor: AuthenticatedUser): Promise<BatchDetailDto> {
    return this.moveBatch(batchId, 'RECEIVE', actor);
  }

  private async moveBatch(
    batchId: string,
    phase: 'DISPATCH' | 'RECEIVE',
    actor: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    const scopeFilter = this.buildScopeFilter(actor);

    const batch = await this.prisma.batch.findFirst({
      where: { AND: [{ id: batchId }, scopeFilter] },
      include: { items: { where: { removedAt: null }, select: { orderId: true } } },
    });
    if (batch === null) throw new NotFoundException('Партия не найдена');

    const status: BatchStatus = batch.status;
    if (phase === 'DISPATCH' && !canDispatchBatch(status)) {
      throw new ConflictException(batchDispatchLockReason(status));
    }
    if (phase === 'RECEIVE' && !canReceiveBatch(status)) {
      throw new ConflictException(batchReceiveLockReason(status));
    }

    if (batch.items.length === 0) {
      // Пустую партию отправлять нечем: акт подписан на нулевой состав, и
      // «в пути» оказалось бы ничего.
      throw new ConflictException('В партии нет ни одного заказа');
    }

    const direction: BatchDirection = batch.direction;
    /*
     * Целевой статус проверяется заранее и только на поддержку направления:
     * сам статус у каждого заказа свой (см. ниже). Возврат `null` означает
     * несовместимость направления и фазы, а не «нет цели».
     */
    if (batchOrderTargetStatus(direction, phase) === null) {
      throw new ConflictException('Направление партии не поддерживается');
    }

    const now = new Date();
    /** Сколько заказов ушло в каждый статус — для записи в журнал аудита. */
    const appliedTo: Record<string, number> = {};

    await this.prisma.runInTransaction(
      async (tx) => {
        /*
         * Перевод заказов идёт ПОСЛЕДОВАТЕЛЬНО в одной транзакции, а не
         * `Promise.all`: каждый переход читает историю статусов заказа, и
         * параллельные чтения внутри одной транзакции Prisma не поддерживает.
         * Партия ограничена лимитом (по умолчанию — составом одного рейса), и
         * 15 секунд таймаута на неё хватает.
         */
        for (const item of batch.items) {
          const current = await tx.order.findUnique({
            where: { id: item.orderId },
            select: { version: true, status: true, returnedWithoutWorkAt: true },
          });
          if (current === null) continue;

          /*
           * Целевой статус считается ДЛЯ КАЖДОГО заказа (дефект 67). В одном
           * рейсе «в магазин» едут и изделия после выполненной работы, и
           * изделия, возвращённые без работ: первые становятся «Готов к
           * выдаче», вторые закрываются отказом клиента. Единый статус на
           * партию отправил бы отказ в «Готов к выдаче», откуда заказ нельзя ни
           * выдать, ни закрыть.
           */
          const target = batchOrderTargetStatus(direction, phase, {
            returnedWithoutWork: current.returnedWithoutWorkAt !== null,
          });
          if (target === null) continue;

          /*
           * Заказ уже в целевом статусе — пропускаем. Так повторный вызов после
           * частичного сбоя доводит партию до конца, а не падает на «переход
           * недопустим»: операция обязана быть повторяемой.
           */
          if (current.status === target) continue;

          await this.workflow.transition({
            orderId: item.orderId,
            to: target,
            actorId: actor.id,
            actorRole: actor.primaryRole,
            actorRoles: actor.roles,
            version: current.version,
            scopes: actor.scopes,
            storeIds: actor.storeIds ?? [],
            tx,
          });

          appliedTo[target] = (appliedTo[target] ?? 0) + 1;
        }

        await tx.batch.update({
          where: { id: batchId },
          data:
            phase === 'DISPATCH'
              ? { status: BATCH_STATUS.IN_TRANSIT, dispatchedAt: now }
              : { status: BATCH_STATUS.RECEIVED, receivedAt: now },
        });

        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.primaryRole,
            action: 'UPDATE',
            entity: 'Batch',
            entityId: batchId,
            before: { status },
            /*
             * Записывается распределение по статусам, а не одно значение:
             * в рейсе «в магазин» заказы могут уйти и в «Готов к выдаче», и в
             * «Отказ до начала работ» (дефект 67), и по журналу должно быть
             * видно, сколько ушло куда.
             */
            after: {
              status: phase === 'DISPATCH' ? BATCH_STATUS.IN_TRANSIT : BATCH_STATUS.RECEIVED,
              orders: batch.items.length,
              appliedTo,
            },
          },
        });
      },
      // Партия из десятков заказов: стандартных 15 секунд может не хватить,
      // и тогда половина рейса откатилась бы по таймауту.
      { timeout: 60_000 },
    );

    /*
     * Уведомление создаётся ПОСЛЕ транзакции, а не внутри неё. Во-первых,
     * отправка во внешний канал не должна удлинять транзакцию: держать блокировки
     * на строках заказов, пока отвечает почтовый сервер, — верный способ
     * получить таймаут на ровном месте. Во-вторых, при откате транзакции
     * уведомление о несостоявшейся перевозке уже не отозвать.
     *
     * Ошибка уведомления не отменяет операцию: партия уже уехала, и сообщать
     * об ошибке пользователю бессмысленно — исправить он ничего не может.
     */
    if (phase === 'RECEIVE') {
      // `createdById` — скалярное поле партии, оно уже прочитано вместе с
      // партией: отдельный запрос к `user` был бы лишним кругом к базе.
      await this.notifyBatchReceived(batch.createdById, batch.batchNo, actor).catch(
        (error: unknown) => {
          /*
           * Ошибка уведомления НЕ отменяет приёмку — партия уже принята
           * физически. Но и полностью молчать нельзя: без записи в журнал
           * «отправитель не узнал о приёмке» обнаруживается только тогда, когда
           * он позвонит и спросит. Пустой `catch` скрывал бы отказ канала
           * навсегда.
           */
          this.logger.warn(
            `Партия ${batch.batchNo}: уведомление отправителю не отправлено — ${String(error)}`,
          );
        },
      );
    }

    return this.findOne(batchId, actor);
  }

  /**
   * Загрузить фотофиксацию партии (задача 2.4, ТЗ п. 2.6).
   *
   * ПОРЯДОК ДЕЙСТВИЙ ВАЖЕН: сначала проверяются права и статус, потом файлы
   * пишутся на диск, и только затем появляются записи в базе. Если файл не
   * сохранился, в базе не остаётся «фото-призрак», которое нельзя открыть; если
   * запись не создалась, файл убирается с диска.
   */
  async uploadPhotos(
    batchId: string,
    params: { caption: string | null; files: { buffer: Buffer; originalname: string }[] },
    actor: AuthenticatedUser,
  ): Promise<BatchPhotoDto[]> {
    if (params.files.length === 0) {
      throw new BadRequestException({
        code: 'NO_FILES',
        message: 'Не выбран ни один файл',
      });
    }

    const scopeFilter = this.buildScopeFilter(actor);
    const batch = await this.prisma.batch.findFirst({
      where: { AND: [{ id: batchId }, scopeFilter] },
      select: { id: true, status: true },
    });
    if (batch === null) throw new NotFoundException('Партия не найдена');

    // Статус проверяется по доменному правилу, а не по списку в сервисе: то же
    // правило использует интерфейс, и две реализации неизбежно разошлись бы.
    const status: BatchStatus = batch.status;
    if (!canUploadBatchPhoto(status)) {
      throw new ConflictException(batchPhotoUploadLockReason(status));
    }

    const saved: string[] = [];
    for (const file of params.files) {
      let stored;
      try {
        stored = await this.storage.savePhoto({
          buffer: file.buffer,
          folder: `batches/${batchId}`,
        });
      } catch (error) {
        // Неизображение или слишком большой файл — понятная ошибка вместо 500.
        const message =
          error instanceof RangeError ? error.message : 'Не удалось обработать изображение';
        throw new BadRequestException({
          code: 'INVALID_IMAGE',
          message: `${file.originalname}: ${message}`,
        });
      }

      try {
        await this.prisma.runInTransaction(async (tx) => {
          const fileObject = await tx.fileObject.create({
            data: {
              bucket: 'local',
              objectKey: stored.objectKey,
              mimeType: stored.mimeType,
              sizeBytes: stored.sizeBytes,
              checksum: stored.checksum,
              uploadedById: actor.id,
            },
          });
          const photo = await tx.batchPhoto.create({
            data: { batchId, fileId: fileObject.id, caption: params.caption },
          });
          await tx.auditLog.create({
            data: {
              actorId: actor.id,
              actorRole: actor.primaryRole,
              action: 'PHOTO_UPLOAD',
              entity: 'BatchPhoto',
              entityId: photo.id,
              after: { batchId, batchNo: batchId, sizeBytes: stored.sizeBytes },
            },
          });
        });
        saved.push(stored.objectKey);
      } catch (error) {
        /*
         * Запись не создалась — убираем записанные файлы, чтобы на диске не
         * осталось мусора, на который никто не ссылается. Уже сохранённые в
         * этой попытке файлы тоже убираются: партия фото должна быть целой, а не
         * наполовину применённой.
         */
        await this.storage.remove(stored.objectKey);
        await this.storage.remove(stored.thumbnailKey);
        for (const key of saved) {
          await this.storage.remove(key);
          await this.storage.remove(key.replace(/\.jpg$/, '-thumb.jpg'));
        }
        throw error;
      }
    }

    return this.listPhotos(batchId, actor);
  }

  /** Фотографии партии. */
  async listPhotos(batchId: string, actor: AuthenticatedUser): Promise<BatchPhotoDto[]> {
    const scopeFilter = this.buildScopeFilter(actor);
    const batch = await this.prisma.batch.findFirst({
      where: { AND: [{ id: batchId }, scopeFilter] },
      select: { id: true },
    });
    if (batch === null) throw new NotFoundException('Партия не найдена');

    const photos = await this.prisma.batchPhoto.findMany({
      where: { batchId },
      include: { file: true },
      orderBy: { createdAt: 'asc' },
    });

    return photos.map((photo) => ({
      id: photo.id,
      batchId: photo.batchId,
      caption: photo.caption,
      createdAt: photo.createdAt.toISOString(),
      mimeType: photo.file.mimeType,
      sizeBytes: photo.file.sizeBytes,
      // Ключ хранилища наружу не отдаётся: по нему файл достаётся в обход прав.
      url: `/api/v1/batches/photos/${photo.id}`,
      thumbnailUrl: `/api/v1/batches/photos/${photo.id}?variant=thumb`,
    }));
  }

  /**
   * Данные файла фото партии для отдачи по HTTP.
   *
   * Отдаётся через API, а не статикой: фото партии — свидетельство о передаче
   * изделий клиентов, доступ к нему должен проверяться правами и областью
   * видимости. Прямая раздача каталога отдала бы любой файл по угадываемому
   * адресу.
   */
  async getPhotoFile(
    photoId: string,
    variant: 'full' | 'thumb',
    actor: AuthenticatedUser,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const photo = await this.prisma.batchPhoto.findFirst({
      where: { id: photoId },
      include: { file: true, batch: { select: { id: true, fromStoreId: true, toStoreId: true } } },
    });
    if (photo === null) throw new NotFoundException('Фотография не найдена');

    // Доступ проверяется ПО ПАРТИИ: фотография наследует её видимость.
    const scopeFilter = this.buildScopeFilter(actor);
    const visible = await this.prisma.batch.findFirst({
      where: { AND: [{ id: photo.batchId }, scopeFilter] },
      select: { id: true },
    });
    if (visible === null) throw new NotFoundException('Фотография не найдена');

    /*
     * Уменьшенная копия отличается суффиксом `-thumb`. Если её нет (старые
     * записи или сбой при сохранении), отдаём оригинал: показать фото целиком
     * лучше, чем не показать ничего.
     */
    const key =
      variant === 'thumb'
        ? photo.file.objectKey.replace(/\.jpg$/, '-thumb.jpg')
        : photo.file.objectKey;

    let buffer: Buffer;
    try {
      buffer = await this.storage.read(key);
    } catch {
      buffer = await this.storage.read(photo.file.objectKey);
    }

    return { buffer, mimeType: photo.file.mimeType, fileName: `batch-photo-${photo.id}.jpg` };
  }

  /**
   * Удалить фото партии.
   *
   * После отправки удаление запрещено: фото становится частью записи о передаче,
   * и пропавшее задним числом доказательство хуже, чем его отсутствие.
   */
  async removePhoto(photoId: string, actor: AuthenticatedUser): Promise<void> {
    const photo = await this.prisma.batchPhoto.findFirst({
      where: { id: photoId },
      include: { file: true, batch: { select: { id: true, status: true } } },
    });
    if (photo === null) throw new NotFoundException('Фотография не найдена');

    const scopeFilter = this.buildScopeFilter(actor);
    const visible = await this.prisma.batch.findFirst({
      where: { AND: [{ id: photo.batchId }, scopeFilter] },
      select: { id: true },
    });
    if (visible === null) throw new NotFoundException('Фотография не найдена');

    const status: BatchStatus = photo.batch.status;
    if (!canDeleteBatchPhoto(status)) {
      throw new ConflictException(batchPhotoDeleteLockReason(status));
    }

    await this.prisma.runInTransaction(async (tx) => {
      await tx.batchPhoto.delete({ where: { id: photoId } });
      await tx.fileObject.delete({ where: { id: photo.fileId } });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'PHOTO_DELETE',
          entity: 'BatchPhoto',
          entityId: photoId,
          before: { batchId: photo.batchId },
        },
      });
    });

    // Файлы удаляются после успешной транзакции: если база откатится, записи
    // останутся, и файл должен остаться вместе с ними.
    await this.storage.remove(photo.file.objectKey);
    await this.storage.remove(photo.file.objectKey.replace(/\.jpg$/, '-thumb.jpg'));
  }

  private toActDto(
    act: {
      id: string;
      actNo: string;
      batchId: string;
      itemsSnapshot: Prisma.JsonValue;
      signedByFromId: string | null;
      signedByToId: string | null;
      signedFromAt: Date | null;
      signedToAt: Date | null;
      pdfFileId: string | null;
    },
    batchNo: string,
  ): BatchActDto {
    /*
     * Снимок читается как есть. Приведение типа здесь неизбежно: Prisma хранит
     * `Json`, а форму снимка задаёт `buildBatchActSnapshot`. Данные пишет только
     * эта функция, поэтому снимок всегда соответствует типу.
     */
    const snapshot = act.itemsSnapshot as unknown as BatchActSnapshot;
    return {
      id: act.id,
      actNo: act.actNo,
      batchId: act.batchId,
      batchNo,
      itemsCount: snapshot.itemsCount,
      totalAmountMinor: snapshot.totalAmountMinor,
      formedAt: snapshot.formedAt,
      signedByFromId: act.signedByFromId,
      signedByToId: act.signedByToId,
      signedFromAt: act.signedFromAt?.toISOString() ?? null,
      signedToAt: act.signedToAt?.toISOString() ?? null,
      isFullySigned: act.signedFromAt !== null && act.signedToAt !== null,
      hasPdf: act.pdfFileId !== null,
      snapshot,
    };
  }

  /**
   * Проверить, что `itemsCount` совпадает с числом активных заказов.
   *
   * Счётчик — денормализация ради списка, и она обязана совпадать с составом.
   * Расхождение означает, что логист видит в партии заказ, которого там нет
   * (именно это и произошло в дефекте со счётчиком). Метод нужен проверкам и
   * диагностике: он позволяет утверждать инвариант, а не только отдельные
   * переходы.
   */
  async verifyItemsCount(batchId: string): Promise<{ stored: number; actual: number }> {
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
      select: { itemsCount: true },
    });
    if (batch === null) throw new NotFoundException('Партия не найдена');

    const actual = await this.prisma.batchItem.count({
      where: { batchId, removedAt: null },
    });

    return { stored: batch.itemsCount, actual };
  }

  // -------------------------------------------------------------------------
  // Внутренние помощники
  // -------------------------------------------------------------------------

  /**
   * Добавить заказы в партию внутри уже открытой транзакции.
   *
   * Один общий помощник для создания партии и для добавления состава: правила
   * и проверки обязаны быть одни и те же, иначе партия, созданная сразу с
   * составом, принимала бы заказы, которые отклоняет добавление по одному.
   */
  private async addOrdersWithin(
    tx: Prisma.TransactionClient,
    batch: {
      id: string;
      direction: BatchDirection;
      fromStoreId: string | null;
      /* Цех-отправитель партии «в магазин» (дефект 76). */
      fromWorkshopId: string | null;
      toWorkshopId: string | null;
    },
    orderIds: readonly string[],
    actor: AuthenticatedUser,
  ): Promise<void> {
    const unique = [...new Set(orderIds)];
    if (unique.length !== orderIds.length) {
      throw new BadRequestException('В списке есть повторяющиеся заказы');
    }

    const alreadyInIds = await this.ordersInActiveBatches(tx, batch.id);

    const orders = await tx.order.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        orderNo: true,
        status: true,
        createdStoreId: true,
        pickupStoreId: true,
        workshopId: true,
      },
    });

    if (orders.length !== unique.length) {
      throw new NotFoundException('Некоторые заказы не найдены');
    }

    /*
     * Проверяются ВСЕ заказы до первой записи. Иначе половина состава
     * добавилась бы, а запрос завершился ошибкой — и логист не понял бы, что
     * именно попало в партию.
     */
    const rejected: string[] = [];
    for (const order of orders) {
      const verdict = checkBatchEligibility({
        order,
        direction: batch.direction,
        fromStoreId: batch.fromStoreId,
        toWorkshopId: batch.toWorkshopId,
        alreadyInIds,
      });
      if (!verdict.eligible) {
        rejected.push(`${order.orderNo}: ${verdict.message ?? 'заказ не подходит'}`);
      }
    }
    if (rejected.length > 0) {
      throw new ConflictException(`Заказы не могут быть добавлены — ${rejected.join('; ')}`);
    }

    /*
     * Цех-отправитель партии «в магазин» проставляется, когда в неё попадает
     * первый заказ (дефект 76).
     *
     * Партию можно создать пустой и наполнить в карточке, поэтому определять
     * отправителя только при создании недостаточно: у пустой партии его не из
     * чего вывести, и в акте приёма-передачи отправителем оказался бы магазин —
     * исходный дефект. Часть заказов без цеха или заказы из РАЗНЫХ цехов дают
     * отказ: подставить произвольный цех значило бы снова соврать в документе.
     */
    if (batchSenderKind(batch.direction) === BATCH_SENDER.WORKSHOP) {
      /*
       * Цех, уже записанный в партии, участвует в проверке ТОЛЬКО когда он есть:
       * у пустой партии его нет по определению, и это не «неизвестный цех», а
       * «ещё не определён». Приравнять эти состояния значило бы запретить
       * наполнение пустой партии — то есть сломать штатный порядок работы.
       */
      const workshopIds = orders.map((order) => order.workshopId);
      if (batch.fromWorkshopId !== null) workshopIds.push(batch.fromWorkshopId);

      const resolved = resolveBatchSourceWorkshop(workshopIds);
      if (!resolved.ok) {
        throw new ConflictException({
          code: 'BATCH_SENDER_UNKNOWN',
          message: batchSourceWorkshopMessage(resolved.reason),
          details: { reason: resolved.reason },
        });
      }
      if (batch.fromWorkshopId !== resolved.workshopId) {
        await tx.batch.update({
          where: { id: batch.id },
          data: { fromWorkshopId: resolved.workshopId },
        });
      }
    }

    /*
     * Лимит состава — предупреждение, а не запрет (решение по задаче 2.1):
     * он не задан в ТЗ, и включённый «на глазок» блокировал бы работу точки.
     * Здесь проверяется только то, что партия не превысила настроенный лимит,
     * если администратор его задал.
     */
    const maxItems = await this.batchMaxItems(tx);
    const currentCount = await tx.batchItem.count({
      where: { batchId: batch.id, removedAt: null },
    });
    if (exceedsBatchLimit(currentCount + orders.length, maxItems)) {
      throw new ConflictException(
        `В партии не может быть больше ${maxItems} заказов (сейчас ${currentCount})`,
      );
    }

    /*
     * Считать приращение состава МОЖНО ТОЛЬКО по строкам, которых в партии ещё
     * нет. Строка, уже активная в этой партии, при повторном добавлении ничего
     * не меняет (уникальный ключ `(batchId, orderId)` не даст вставить её
     * второй раз), но раньше счётчик всё равно увеличивался — и `itemsCount`
     * навсегда расходился с числом активных заказов.
     *
     * Дефект найден сквозной проверкой на живом сервере: после повторного
     * добавления и исключения заказа в партии `П-250916-001` поле показывало 1,
     * а активных строк было 0. Интерфейс показывает именно `itemsCount`, поэтому
     * логист видел в партии заказ, которого там нет.
     */
    const existing = await tx.batchItem.findMany({
      where: { batchId: batch.id, orderId: { in: orders.map((order) => order.id) } },
      select: { orderId: true, removedAt: true },
    });
    const alreadyActive = new Set(
      existing.filter((row) => row.removedAt === null).map((row) => row.orderId),
    );

    if (alreadyActive.size > 0) {
      const numbers = orders
        .filter((order) => alreadyActive.has(order.id))
        .map((order) => order.orderNo)
        .join(', ');
      throw new ConflictException(`Заказ уже в этой партии — ${numbers}`);
    }

    for (const order of orders) {
      /*
       * Строка могла остаться от прежнего состава (заказ исключали и вернули):
       * уникальный ключ `(batchId, orderId)` не даст вставить её второй раз,
       * поэтому повторное включение снимает отметку об исключении.
       */
      await tx.batchItem.upsert({
        where: { batchId_orderId: { batchId: batch.id, orderId: order.id } },
        update: { removedAt: null, removeReason: null, addedAt: new Date(), addedById: actor.id },
        create: { batchId: batch.id, orderId: order.id, addedById: actor.id },
      });
    }

    // Сюда попадают только новые или возвращённые заказы, поэтому счётчик
    // увеличивается ровно на их число.
    await tx.batch.update({
      where: { id: batch.id },
      data: { itemsCount: { increment: orders.length } },
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.primaryRole,
        action: 'UPDATE',
        entity: 'Batch',
        entityId: batch.id,
        after: { addedOrders: orders.map((order) => order.orderNo) },
      },
    });
  }

  /**
   * Заказы, уже лежащие в активных партиях.
   *
   * `excludeBatchId` исключает саму партию: при добавлении состава в неё заказы
   * уже числятся её строками, и без исключения они считались бы «занятыми
   * другой партией».
   */
  private async ordersInActiveBatches(
    client: Prisma.TransactionClient | PrismaService,
    excludeBatchId?: string,
  ): Promise<Set<string>> {
    const rows = await client.batchItem.findMany({
      where: {
        removedAt: null,
        batch: {
          status: { in: [...ACTIVE_BATCH_STATUSES] },
          ...(excludeBatchId === undefined ? {} : { id: { not: excludeBatchId } }),
        },
      },
      select: { orderId: true },
    });
    return new Set(rows.map((row) => row.orderId));
  }

  /**
   * Лимит состава партии из настроек.
   *
   * Настройка `logistics.batchMaxItems` отсутствует по умолчанию — значит лимита
   * нет. Значение читается из `Setting`, а не из переменной окружения: его
   * должен менять администратор без перезапуска сервисов.
   */
  private async batchMaxItems(
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<number | null> {
    const setting = await client.setting.findUnique({ where: { key: 'logistics.batchMaxItems' } });
    if (setting === null) return DEFAULT_MAX_ITEMS;
    /*
     * Значение может быть записано и числом, и объектом `{ value: 5 }` —
     * форма зависит от того, как настройку сохранил администратор. Проверяются
     * оба варианта, потому что «настройка есть, но не прочиталась» выглядела бы
     * как отсутствие лимита, то есть как молчаливое отключение ограничения.
     */
    const value: unknown = setting.value;
    if (isPositiveInteger(value)) return value;
    if (typeof value === 'object' && value !== null && 'value' in value) {
      const inner: unknown = value.value;
      if (isPositiveInteger(inner)) return inner;
    }
    // Настройка есть, но значение бессмысленное: лимит не применяется, а не
    // превращается в «нельзя ничего».
    return DEFAULT_MAX_ITEMS;
  }

  /**
   * Область видимости партий по ролям.
   *
   * Устроена так же, как `buildOrderScopeFilter` в `PrismaService`, и по той же
   * логике областей (`DATA_SCOPE`):
   *
   *  * `ALL_STORES` — администратор, руководитель, главный бухгалтер;
   *  * `READ_ALL` — аудитор: видит всё, но только на чтение;
   *  * `PRODUCTION` — логист и руководитель производства: партия не привязана к
   *    статусу заказа, поэтому они видят все рейсы (иначе логист не смог бы
   *    спланировать перевозку между точками, которые ему не «принадлежат»).
   *    Важно, что это правило по ОБЛАСТИ, а не по списку магазинов: у логиста
   *    магазинов нет вовсе, и проверка «нет магазинов → ничего не видно»
   *    отдавала бы ему пустой список;
   *  * области магазина — только рейсы через свои точки.
   *
   * `READ_ALL` здесь принципиально важен: аудитор имеет право `logistics:read`
   * (docs/02 §4, строка «Логистика: партия, акт» — «Р»), но его область не
   * `ALL_STORES`. Пока исключался только `ALL_STORES`, аудитор получал пустой
   * список — то есть право на чтение без единой доступной записи.
   *
   * Проверяется НАБОР областей (дефект 65), а не одна «самая широкая»: партия
   * доступна, если её видно по ЛЮБОЙ роли сотрудника. Для партий объединение
   * совпадает с прежним правилом — `PRODUCTION` и так даёт все рейсы, а
   * магазинные области добавляют рейсы своих точек; но проверка по набору не
   * ломается, когда у приёмщика появляется вторая роль логиста.
   */
  private buildScopeFilter(actor: AuthenticatedUser): Prisma.BatchWhereInput {
    if (
      actor.scopes.includes('ALL_STORES') ||
      actor.scopes.includes('READ_ALL') ||
      actor.scopes.includes('PRODUCTION')
    ) {
      return {};
    }

    const storeIds = actor.storeIds ?? [];
    if (storeIds.length === 0) {
      // Нет доступных магазинов — партий не видно вовсе. Возвращать всё было бы
      // утечкой: роль без магазинов не должна видеть чужие рейсы.
      return { id: '__none__' };
    }
    return {
      OR: [{ fromStoreId: { in: storeIds } }, { toStoreId: { in: storeIds } }],
    };
  }

  /**
   * Сообщить о приёмке партии (задача 2.6).
   *
   * Получатель — отправитель рейса, если он известен: именно он ждёт
   * подтверждения, что изделия доехали. Когда отправителя нет (рейс заведён
   * системой или прежним сотрудником), уведомление не создаётся: сообщение «в
   * никуда» только засорило бы таблицу.
   */
  private async notifyBatchReceived(
    senderId: string | null,
    batchNo: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    if (senderId === null) return;

    /*
     * Адрес отправителя читается здесь же. Скалярного `createdById` из партии
     * недостаточно: уведомление уходит по ДВУМ каналам (задача 5.9), а для письма
     * нужен адрес. Отправитель может не открыть систему, и тогда единственным
     * способом узнать о приёмке остаётся почта.
     *
     * Отсутствие адреса не мешает: сообщение в интерфейсе всё равно создаётся.
     */
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { email: true },
    });

    await this.notifications.notifyStaff({
      code: TEMPLATE_CODE.BATCH_RECEIVED,
      userId: senderId,
      email: sender?.email ?? null,
      values: { batchNo, receivedBy: actor.email },
      fallbackSubject: `Партия ${batchNo} принята`,
      fallbackBody: `Партия ${batchNo} принята получателем.`,
    });
  }

  /**
   * Норматив доставки в часах (задача 2.6).
   *
   * Читается из `Setting`, а не из переменной окружения: городской и
   * междугородний рейс имеют разную норму, и менять её должен логистик, а не
   * разработчик с перезапуском сервиса. Значение бессмысленное (ноль,
   * отрицательное, не число) — берётся значение по умолчанию: иначе деление на
   * ноль оставило бы партию «в норме» навсегда, и тревога не сработала бы.
   */
  private async transitNormHours(
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<number> {
    const setting = await client.setting.findUnique({
      where: { key: 'logistics.transitNormHours' },
    });
    if (setting === null) return DEFAULT_TRANSIT_NORM_HOURS;

    /*
     * Значение может быть записано и числом, и объектом `{ value: 5 }` — форма
     * зависит от того, как настройку сохранил администратор. Проверяются оба
     * варианта: «настройка есть, но не прочиталась» выглядела бы как отсутствие
     * норматива, то есть как молчаливое отключение контроля.
     */
    const value: unknown = setting.value;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'object' && value !== null && 'value' in value) {
      const inner: unknown = value.value;
      if (typeof inner === 'number' && Number.isFinite(inner) && inner > 0) return inner;
    }
    return DEFAULT_TRANSIT_NORM_HOURS;
  }

  private toDto(
    row: {
      id: string;
      batchNo: string;
      direction: string;
      status: string;
      fromStoreId: string | null;
      fromWorkshopId?: string | null;
      toStoreId: string | null;
      toWorkshopId: string | null;
      courierId: string | null;
      plannedAt: Date;
      dispatchedAt: Date | null;
      receivedAt: Date | null;
      itemsCount: number;
      comment: string | null;
      createdAt: Date;
      fromStore?: { name: string } | null;
      fromWorkshop?: { name: string } | null;
      toStore?: { name: string } | null;
      toWorkshop?: { name: string } | null;
    },
    normHours: number,
    now?: Date,
  ): BatchDto {
    return {
      id: row.id,
      batchNo: row.batchNo,
      direction: row.direction as BatchDirection,
      status: row.status,
      fromStoreId: row.fromStoreId,
      fromStoreName: row.fromStore?.name ?? null,
      fromWorkshopId: row.fromWorkshopId ?? null,
      fromWorkshopName: row.fromWorkshop?.name ?? null,
      senderKind: batchSenderKind(row.direction as BatchDirection),
      toStoreId: row.toStoreId,
      toStoreName: row.toStore?.name ?? null,
      toWorkshopId: row.toWorkshopId,
      toWorkshopName: row.toWorkshop?.name ?? null,
      courierId: row.courierId,
      plannedAt: row.plannedAt.toISOString(),
      dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
      receivedAt: row.receivedAt?.toISOString() ?? null,
      itemsCount: row.itemsCount,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
      transit: assessTransit({
        dispatchedAt: row.dispatchedAt,
        now: now ?? new Date(),
        normHours,
      }),
    };
  }
}

/**
 * Начало московских суток для даты `ГГГГ-ММ-ДД`.
 *
 * Смещение Москвы постоянно (UTC+3, перехода на летнее время нет с 2014 года),
 * поэтому начало суток — это `T00:00:00+03:00`. Отдельная функция, потому что
 * то же сравнение нужно и для конца суток.
 */
export function moscowDayStart(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+03:00`);
}

/** Следующий день для `ГГГГ-ММ-ДД` — верхняя граница суток. */
export function nextDayKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Разобрать входные данные и вернуть ошибку в общем формате API.
 *
 * Проверка выполняется в сервисе, а не в контроллере, как во всех остальных
 * модулях проекта (`dictionaries`, `users`, `customers`): тогда правило одно и
 * то же независимо от того, откуда пришёл вызов, а формат ошибки
 * (`code: VALIDATION_ERROR` + `details` по полям) совпадает с остальным API, и
 * интерфейс показывает сообщения у нужных полей.
 */
/** Является ли значение положительным целым — пригодным лимитом. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseOrThrow<Output, Input = unknown>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Проверьте правильность заполнения полей',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  return parsed.data;
}

/**
 * Привести параметры строки запроса к виду, который понимает схема.
 *
 * В адресе `?status=DRAFT&status=ACT_FORMED` Express отдаёт массивом, а
 * `?status=DRAFT` — строкой. Схема ожидает массив для `status`. Без этого
 * приведения одиночный фильтр не проходил бы проверку, хотя выглядит
 * совершенно обычным, — и ошибка была бы непонятна пользователю.
 */
function normalizeQuery(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {};
  const result: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const value = result['status'];
  if (typeof value === 'string') result['status'] = [value];
  return result;
}
