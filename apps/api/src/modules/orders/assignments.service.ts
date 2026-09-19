import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  assignmentSchema,
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  isTerminalStatus,
  type OrderStatus,
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Распределение работы между исполнителями производства (задача 7.2).
 *
 * ## Почему это отдельный сервис, а не метод `OrdersService`
 *
 * Работа с исполнителями — не редактирование заказа: назначение меняет СТАТУС
 * (через доменный workflow) и пишет запись в историю. Держать это в
 * `OrdersService` значило бы тянуть туда транзакции поверх транзакций и
 * смешивать «изменить поле» с «перевести заказ по статусной модели».
 *
 * ## Дефект, который здесь закрывается
 *
 * Таблица `OrderAssignment` существовала, схема `assignmentSchema` была
 * написана, но запись в неё не производил никто — по всему репозиторию только
 * чтение (дефект 59). Следствие серьёзнее отсутствующей функции: переход
 * «Работы завершены» требует исполнителя (guard `PERFORMER_ASSIGNED` смотрит
 * наличие строки), поэтому заказ физически не мог уехать из цеха — цепочка
 * обрывалась на «в производстве» навсегда.
 */
@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: OrderWorkflowService,
  ) {}

  /**
   * Назначить исполнителя и выдать работу.
   *
   * Назначение и перевод заказа в «Выдано в работу» происходят в ОДНОЙ
   * транзакции: если бы заказ переводился отдельно от записи назначения, при
   * сбое между ними получился бы заказ «в работе» без исполнителя — и статус
   * врал бы о том, что работа идёт, тогда как выдавать её некому.
   *
   * @param orderId заказ
   * @param input   тело запроса (проверяется `assignmentSchema`)
   * @param user    менеджер производства
   */
  async assign(
    orderId: string,
    input: unknown,
    user: AuthenticatedUser,
  ): Promise<OrderAssignmentDto> {
    const parsed = assignmentSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scope: user.scope,
      storeIds: user.storeIds,
      userId: user.id,
    });

    /*
     * Заказ читается ВНЕ транзакции перехода: нужны `version` для оптимистичной
     * блокировки и текущий статус. Само назначение ниже выполняется в
     * транзакции перехода — иначе между проверкой и записью заказ мог бы
     * уехать, и назначение досталось бы заказу в другом статусе.
     */
    const order = await this.prisma.order.findFirst({
      where: { AND: [{ id: orderId }, scopeFilter] },
      select: { id: true, orderNo: true, status: true, version: true, workshopId: true },
    });
    if (order === null) {
      // Не найдено ИЛИ вне области видимости → 404, не 403 (защита от IDOR).
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    /*
     * Назначать исполнителя можно только на этапе, где работа выдаётся.
     * Проверяем по таблице переходов, а не списком статусов: список разошёлся
     * бы с таблицей при добавлении статуса, а таблица — единственный источник
     * правды о том, куда можно перейти.
     */
    const allowedFrom = this.assignmentSourceStatuses();
    if (!allowedFrom.includes(order.status)) {
      throw new ConflictException({
        code: 'BUSINESS_RULE_VIOLATION',
        message: `Назначить исполнителя можно из статуса «Принят цехом», текущий: ${order.status}`,
      });
    }

    const performer = await this.prisma.performer.findFirst({
      where: { id: data.performerId, isActive: true },
      select: { id: true, fullName: true, workshopId: true },
    });
    if (performer === null) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Исполнитель не найден или неактивен',
        details: { performerId: ['Исполнитель не найден или неактивен'] },
      });
    }

    /*
     * Исполнитель закреплён за цехом, а заказ может быть назначен на другой.
     * Это проверка, а не запрет: цех у заказа может быть не заполнен (работа
     * распределяется по факту), и тогда назначение — способ его определить.
     * Если цех заполнен и не совпадает — предупреждаем, потому что физически
     * изделие в одном цехе, а исполнитель в другом.
     */
    const workshopMismatch = order.workshopId !== null && performer.workshopId !== order.workshopId;

    const assignmentId = await this.prisma.runInTransaction(async (tx) => {
      /*
       * Прошлые незакрытые назначения закрываются ДО создания нового. Иначе в
       * заказе оказались бы два активных исполнителя, и `workFinished` смотрел
       * бы на любой из них: заказ мог считаться готовым, пока второй ювелир
       * ещё работает.
       */
      await tx.orderAssignment.updateMany({
        where: { orderId: order.id, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
        data: { status: 'RETURNED', finishedAt: new Date() },
      });

      const created = await tx.orderAssignment.create({
        data: {
          orderId: order.id,
          performerId: performer.id,
          assignedById: user.id,
          plannedHours: data.plannedHours ?? null,
          comment: data.comment ?? null,
          status: 'ASSIGNED',
          startedAt: new Date(),
        },
        select: { id: true },
      });

      /*
       * Статус переводит доменный workflow, а не прямое обновление поля: только
       * он проверит роль, условия и версию, рассчитает норматив срока и запишет
       * историю статусов. Прямая запись статуса обошла бы все эти проверки.
       *
       * Переход передаётся ТОЙ ЖЕ транзакцией: иначе назначение и смена статуса
       * зафиксировались бы по отдельности.
       */
      await this.workflow.transition({
        orderId: order.id,
        to: ORDER_STATUS.IN_WORK,
        actorId: user.id,
        actorRole: user.primaryRole,
        actorRoles: user.roles,
        version: order.version,
        scope: user.scope,
        storeIds: user.storeIds,
        tx,
      });

      /*
       * Запись в историю ОБ ИСПОЛНИТЕЛЕ — отдельной строкой (требование
       * заказчика: в истории заказа должно быть видно, какой ювелир выполнял
       * работу).
       *
       * `OrderStatusHistory` для этого не подходит: её `toStatus` — статус, и
       * записать туда ФИО значило бы сломать отчётность по статусам. Поэтому
       * запись идёт в аудит с действием `ASSIGNMENT`, а лента заказа собирает её
       * в отдельный тип `ASSIGNMENT`.
       */
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'ASSIGNMENT',
          entity: 'OrderAssignment',
          entityId: created.id,
          after: {
            orderId: order.id,
            orderNo: order.orderNo,
            performerId: performer.id,
            performerName: performer.fullName,
            plannedHours: data.plannedHours ?? null,
            comment: data.comment ?? null,
          },
        },
      });

      return created.id;
    });

    this.logger.log(
      `Заказ ${order.orderNo}: работа выдана ${performer.fullName}${workshopMismatch ? ' (цех не совпадает)' : ''}`,
    );

    return this.findOneAssignment(assignmentId);
  }

  /**
   * Принять работу: назначение закрывается, заказ переходит в «Работы завершены».
   *
   * Приёмка — это подтверждение менеджера, что работа выполнена. Один флаг от
   * ювелира «я закончил» здесь недостаточен: заказчик требует, чтобы работу
   * принимал менеджер, иначе в магазин уедет изделие, которое никто не проверял.
   */
  async finish(
    orderId: string,
    assignmentId: string,
    input: unknown,
    user: AuthenticatedUser,
  ): Promise<OrderAssignmentDto> {
    /*
     * Приёмка работы причины не требует, но комментарий допустим: менеджер
     * может зафиксировать замечание. Схема проверяется тем же правилом, что и
     * удаление заказа из партии — «комментарий необязателен, но если он есть,
     * то не мусор».
     */
    const body = (input ?? {}) as { comment?: unknown };
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (comment.length > 1000) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Комментарий слишком длинный',
        details: { comment: ['Не более 1000 символов'] },
      });
    }

    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scope: user.scope,
      storeIds: user.storeIds,
      userId: user.id,
    });

    const order = await this.prisma.order.findFirst({
      where: { AND: [{ id: orderId }, scopeFilter] },
      select: { id: true, orderNo: true, status: true, version: true },
    });
    if (order === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }
    if (isTerminalStatus(order.status)) {
      throw new ConflictException({
        code: 'ORDER_FINAL',
        message: 'Заказ закрыт — принять работу невозможно',
      });
    }

    await this.prisma.runInTransaction(async (tx) => {
      const assignment = await tx.orderAssignment.findFirst({
        where: { id: assignmentId, orderId: order.id },
        select: { id: true, status: true, performerId: true },
      });
      if (assignment === null) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Назначение не найдено' });
      }
      if (assignment.status === 'DONE') {
        throw new ConflictException({
          code: 'BUSINESS_RULE_VIOLATION',
          message: 'Работа по этому назначению уже принята',
        });
      }
      if (assignment.status === 'RETURNED') {
        throw new ConflictException({
          code: 'BUSINESS_RULE_VIOLATION',
          message: 'Назначение отменено — работа по нему не выполнялась',
        });
      }

      await tx.orderAssignment.update({
        where: { id: assignment.id },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          comment: comment.length > 0 ? comment : undefined,
        },
      });

      await this.workflow.transition({
        orderId: order.id,
        to: ORDER_STATUS.WORK_COMPLETED,
        actorId: user.id,
        actorRole: user.primaryRole,
        actorRoles: user.roles,
        version: order.version,
        scope: user.scope,
        storeIds: user.storeIds,
        tx,
      });
    });

    this.logger.log(`Заказ ${order.orderNo}: работа принята менеджером`);

    return this.findOneAssignment(assignmentId);
  }

  /** Назначение в том виде, в каком его возвращает API. */
  async findOneAssignment(assignmentId: string): Promise<OrderAssignmentDto> {
    const row = await this.prisma.orderAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        performer: { select: { id: true, fullName: true, specialization: true } },
        assignedBy: { select: { id: true, fullName: true } },
      },
    });
    if (row === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Назначение не найдено' });
    }

    return {
      id: row.id,
      orderId: row.orderId,
      performerId: row.performerId,
      performerName: row.performer.fullName,
      performerSpecialization: row.performer.specialization,
      assignedById: row.assignedById,
      assignedByName: row.assignedBy.fullName,
      plannedHours: row.plannedHours,
      status: row.status,
      comment: row.comment,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Статусы, из которых можно выдать работу.
   *
   * Выводятся из таблицы переходов: берём те, у которых целевой статус —
   * `IN_WORK`. Список статусов, записанный здесь руками, разошёлся бы с
   * таблицей при первой же правке статусной модели — а именно на таком
   * расхождении в проекте уже случался дефект с нормативами сроков.
   */
  private assignmentSourceStatuses(): OrderStatus[] {
    return ORDER_TRANSITIONS.filter((rule) => rule.to === ORDER_STATUS.IN_WORK)
      .map((rule) => rule.from)
      .filter((from): from is OrderStatus => from !== null);
  }
}

/** Назначение исполнителя в ответе API. */
export interface OrderAssignmentDto {
  id: string;
  orderId: string;
  performerId: string;
  performerName: string;
  performerSpecialization: string | null;
  assignedById: string;
  assignedByName: string;
  plannedHours: number | null;
  status: string;
  comment: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}
