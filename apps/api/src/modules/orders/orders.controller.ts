import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Header,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { AssignmentsService } from './assignments.service';
import type { OrderAssignmentDto } from './assignments.service';
import { ReceiptService } from './receipt.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles, RequirePermission } from '../../common/auth/roles.decorator';
import {
  ROLE,
  PERMISSION,
  transitionSchema,
  cancelOrderSchema,
  type OrderStatus,
} from '@app/shared';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import type {
  OrderCard,
  OrderListResult,
  OrderSearchItem,
  OrderSummary,
  TimelineEntry,
  CreatedOrder,
} from './orders.service';

/**
 * Ответ на некорректное тело запроса.
 *
 * `transition` и `cancel` возвращают его вместо исключения: это осознанное
 * решение — клиент получает разбор полей (`details`) в том же формате, что и
 * `ValidationPipe`, и может подсветить конкретные поля формы. Поэтому тип
 * возврата этих методов — объединение с карточкой заказа.
 */
interface ValidationErrorResponse {
  statusCode: 400;
  code: 'VALIDATION_ERROR';
  message: string;
  details: Record<string, string[] | undefined>;
}

@ApiTags('orders')
@ApiCookieAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly assignmentsService: AssignmentsService,
    private readonly workflow: OrderWorkflowService,
    private readonly receiptService: ReceiptService,
  ) {}

  @Get()
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Список заказов с фильтрами и пагинацией' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, isArray: true })
  @ApiQuery({ name: 'overdue', required: false, type: Boolean })
  @ApiQuery({ name: 'customerPhone', required: false, type: String })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string | string[],
    @Query('storeId') storeId?: string | string[],
    @Query('overdue') overdue?: string,
    @Query('orderNo') orderNo?: string,
    @Query('customerPhone') customerPhone?: string,
    @Query('isWarranty') isWarranty?: string,
    @Query('priority') priority?: string,
  ): Promise<OrderListResult> {
    const asArray = (value?: string | string[]): string[] | undefined =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value];

    return this.ordersService.findAll(
      {
        limit: limit ? Number(limit) : undefined,
        cursor: cursor ?? undefined,
        status: asArray(status) as OrderStatus[] | undefined,
        storeId: asArray(storeId),
        overdue: overdue === 'true',
        orderNo: orderNo ?? undefined,
        customerPhone: customerPhone ?? undefined,
        isWarranty: isWarranty === undefined ? undefined : isWarranty === 'true',
        priority: priority ?? undefined,
      },
      user,
    );
  }

  /**
   * Глобальный поиск по номеру заказа, телефону или ФИО.
   * ВАЖНО: объявлен ДО `:id`, иначе «search» был бы принят за идентификатор.
   */
  @Get('search')
  @RequirePermission(PERMISSION.ORDER_SEARCH_GLOBAL)
  @ApiOperation({ summary: 'Глобальный поиск: номер заказа, телефон, ФИО' })
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q: string,
  ): Promise<OrderSearchItem[]> {
    return this.ordersService.searchGlobal(q ?? '', user);
  }

  /**
   * Сводка для дашборда.
   * ВАЖНО: объявлен ДО `:id` — иначе «summary» был бы принят за идентификатор.
   */
  @Get('summary')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Сводка по заказам для дашборда' })
  summary(@CurrentUser() user: AuthenticatedUser): Promise<OrderSummary> {
    return this.ordersService.getSummary(user);
  }

  /** Просроченные заказы — дашборд (ТЗ п. 2.7). */
  @Get('overdue')
  @Roles(ROLE.MANAGER, ROLE.PRODUCTION_MANAGER, ROLE.ADMIN)
  @ApiOperation({ summary: 'Просроченные заказы' })
  findOverdue(@CurrentUser() user: AuthenticatedUser): Promise<OrderListResult> {
    return this.ordersService.findAll({ overdue: true, limit: 100 }, user);
  }

  @Post()
  @Roles(ROLE.RECEIVER)
  @RequirePermission(PERMISSION.ORDER_CREATE)
  @ApiOperation({ summary: 'Создать заказ' })
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser): Promise<CreatedOrder> {
    return this.ordersService.create(body, user);
  }

  @Get(':id')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Карточка заказа' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<OrderCard> {
    return this.ordersService.findOne(id, user);
  }

  @Get(':id/timeline')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Единая лента событий заказа' })
  getTimeline(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TimelineEntry[]> {
    return this.ordersService.getTimeline(id, user);
  }

  @Get(':id/available-transitions')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Доступные действия для текущего пользователя' })
  async availableTransitions(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderCard['availableTransitions']> {
    const order = await this.ordersService.findOne(id, user);
    return order.availableTransitions;
  }

  /**
   * Переход статуса.
   * Все проверки (роль, предоплата, оплата, согласование) — на сервере.
   *
   * Возвращается полная карточка заказа, а не запись из таблицы: раньше здесь
   * уходил «сырой» результат `order.findUniqueOrThrow`, в котором нет
   * вычисляемых полей (`availableTransitions`, `statusLabel`, `remainingMinor`).
   * Клиент подставлял этот ответ в кэш карточки, и интерфейс падал на
   * `availableTransitions.length`. Форма ответа того же эндпоинта, что и
   * `GET /orders/:id`, избавляет клиент от склейки данных из двух источников.
   */
  /**
   * Выдать работу исполнителю производства (задача 7.2).
   *
   * Создаёт назначение и переводит заказ в «Выдано в работу» одной операцией.
   * Право `production:manage` — то же, что у менеджера производства на переводы
   * в цехе.
   */
  @Post(':id/assignments')
  @RequirePermission(PERMISSION.PRODUCTION_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Назначить исполнителя производства' })
  assignPerformer(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderAssignmentDto> {
    return this.assignmentsService.assign(id, body, user);
  }

  /**
   * Принять работу у исполнителя: заказ переходит в «Работы завершены».
   *
   * Путь `:assignmentId` вложен в заказ намеренно: он проверяется на
   * принадлежность заказу, иначе менеджер одного цеха мог бы закрыть назначение
   * чужого заказа, зная только идентификатор назначения.
   */
  @Post(':id/assignments/:assignmentId/finish')
  @RequirePermission(PERMISSION.PRODUCTION_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Принять работу у исполнителя' })
  finishAssignment(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderAssignmentDto> {
    return this.assignmentsService.finish(id, assignmentId, body, user);
  }

  @Post(':id/transition')
  @RequirePermission(PERMISSION.ORDER_TRANSITION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Перевести заказ в другой статус' })
  async transition(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderCard | ValidationErrorResponse> {
    const parsed = transitionSchema.safeParse(body);
    if (!parsed.success) {
      return {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      };
    }

    await this.workflow.transition({
      orderId: id,
      to: parsed.data.to as OrderStatus,
      actorId: user.id,
      actorRole: user.primaryRole,
      actorRoles: user.roles,
      reason: parsed.data.reason,
      version: parsed.data.version,
      payload: parsed.data.payload,
      scope: user.scope,
      storeIds: user.storeIds,
    });

    // Отдаём карточку в той же форме, что и `GET /orders/:id`.
    return this.ordersService.findOne(id, user);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSION.ORDER_CANCEL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить заказ (причина обязательна)' })
  async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderCard | ValidationErrorResponse> {
    const parsed = cancelOrderSchema.safeParse(body);
    if (!parsed.success) {
      return {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      };
    }

    await this.workflow.transition({
      orderId: id,
      to: 'CANCELLED',
      actorId: user.id,
      actorRole: user.primaryRole,
      actorRoles: user.roles,
      reason: parsed.data.reason,
      version: parsed.data.version,
      scope: user.scope,
      storeIds: user.storeIds,
    });

    // Как и при переходе статуса, отдаём карточку целиком: клиент подставляет
    // ответ в кэш и не должен получать объект другой формы.
    return this.ordersService.findOne(id, user);
  }

  /**
   * Зафиксировать согласование клиента по сумме и сроку (ТЗ п. 2.4).
   *
   * Отдаём карточку заказа, а не созданное согласование: интерфейс после
   * операции обновляет вкладки «Согласования» и «История», и один запрос
   * вместо двух означает меньше рассинхронизации.
   */
  @Post(':id/approvals')
  @RequirePermission(PERMISSION.APPROVAL_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Зафиксировать согласование клиента' })
  createApproval(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderCard> {
    return this.ordersService.createApproval(id, body, user);
  }

  /** Скорректировать калькуляцию — только с обязательной причиной (ТЗ п. 2.3). */
  @Post(':id/adjustments')
  @RequirePermission(PERMISSION.CALC_ADJUST)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Скорректировать калькуляцию (причина обязательна)' })
  createAdjustment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderCard> {
    return this.ordersService.createAdjustment(id, body, user);
  }

  /**
   * Оформить акт отказа от оплаты (ТЗ п. 2.8, задача 7.5).
   *
   * Право — `order:transition`, а не отдельное: акт существует ровно для того,
   * чтобы стал возможен переход в «Отказ от оплаты», и выдавать его кому-то,
   * кто не может перевести заказ, значило бы создавать документ, которым нельзя
   * воспользоваться. Кто именно вправе отказать, решает таблица переходов
   * (20 — приёмщик, менеджер, администратор; 22 — менеджер, администратор).
   */
  @Post(':id/refusal-act')
  @RequirePermission(PERMISSION.ORDER_TRANSITION)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Оформить акт отказа от оплаты' })
  createRefusalAct(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderCard> {
    return this.ordersService.createRefusalAct(id, body, user);
  }

  /**
   * PDF-квитанция с QR-кодом (ответ A4, ТЗ п. 2.1).
   *
   * Отдаётся файлом (`inline`, не `attachment`): браузер открывает его во
   * встроенном просмотрщике, откуда печатают. Скачивать файл в «Загрузки»
   * приёмщику не нужно — он печатает и отдаёт бумагу клиенту.
   *
   * `no-store`: квитанция содержит ФИО и телефон клиента, кэшировать её в
   * браузере или на промежуточном прокси нельзя.
   */
  @Get(':id/receipt')
  @RequirePermission(PERMISSION.ORDER_READ)
  @Header('Content-Type', 'application/pdf')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'PDF-квитанция приёма заказа с QR-кодом' })
  async downloadReceipt(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    // Счётчик перепечаток увеличивает сервис: печать — это действие,
    // а не чтение, и оно попадает в историю заказа.
    const data = await this.ordersService.getReceiptData(id, user);
    const pdf = await this.receiptService.buildReceiptPdf(data);

    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `inline; filename="receipt-${data.orderNo}.pdf"`);
    res.end(pdf);
  }
}
