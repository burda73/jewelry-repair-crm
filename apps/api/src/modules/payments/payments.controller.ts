import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiHeader, ApiQuery } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import type { PaymentDto, PaymentListItem, PaymentResult } from './payments.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { PERMISSION } from '@app/shared';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

@ApiTags('payments')
@ApiCookieAuth()
@Controller()
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /** Платежи по заказу. */
  @Get('orders/:id/payments')
  @RequirePermission(PERMISSION.PAYMENT_READ)
  @ApiOperation({ summary: 'Платежи по заказу' })
  findByOrder(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentDto[]> {
    return this.paymentsService.findByOrder(id, user);
  }

  /**
   * Принять платёж.
   *
   * Заголовок `Idempotency-Key` обязателен: без него повтор запроса создал бы
   * второй платёж (двойной клик кассира или повтор при обрыве связи). Повтор с
   * тем же ключом возвращает результат первой операции.
   */
  @Post('orders/:id/payments')
  @RequirePermission(PERMISSION.PAYMENT_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Ключ идемпотентности (UUID). Повтор с тем же ключом не создаёт второй платёж.',
  })
  @ApiOperation({ summary: 'Принять платёж по заказу (идемпотентно)' })
  create(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentResult> {
    return this.paymentsService.createPayment(id, body, idempotencyKey, user);
  }

  /**
   * Реестр платежей.
   * ВАЖНО: объявлен до `:id`-маршрутов соседних контроллеров, но внутри этого
   * контроллера конфликтов нет — пути не пересекаются.
   */
  @Get('payments')
  @RequirePermission(PERMISSION.PAYMENT_READ)
  @ApiOperation({ summary: 'Реестр платежей с фильтрами' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'orderId', required: false, type: String })
  @ApiQuery({ name: 'storeId', required: false, isArray: true })
  @ApiQuery({ name: 'status', required: false, isArray: true })
  @ApiQuery({ name: 'kind', required: false, isArray: true })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('orderId') orderId?: string,
    @Query('storeId') storeId?: string | string[],
    @Query('status') status?: string | string[],
    @Query('kind') kind?: string | string[],
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<PaymentListItem[]> {
    const asArray = (value?: string | string[]): string[] | undefined =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value];

    const asDate = (value?: string): Date | undefined => {
      if (value === undefined) return undefined;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    };

    return this.paymentsService.findAll(
      {
        limit: limit ? Number(limit) : undefined,
        orderId: orderId ?? undefined,
        storeId: asArray(storeId),
        status: asArray(status),
        kind: asArray(kind),
        from: asDate(from),
        to: asDate(to),
      },
      user,
    );
  }

  /**
   * Сторно платежа.
   * Исходный платёж не удаляется: он получает статус `REVERSED`, причина
   * уходит в аудит. История движений денег неизменна (требование финансового учёта).
   */
  @Post('payments/:id/reverse')
  @RequirePermission(PERMISSION.PAYMENT_REVERSE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Сторно платежа (причина обязательна)' })
  reverse(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentResult> {
    return this.paymentsService.reversePayment(id, body, user);
  }
}
