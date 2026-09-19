import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';

import { ClaimsService } from './claims.service';
import type { ClaimDetail, ClaimListItem } from './claims.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { RequirePermission } from '../../common/auth/roles.decorator';

/**
 * Реестр рекламаций (этап 6, ТЗ п. 2.9).
 *
 * ПОЧЕМУ ЧТЕНИЕ И ИЗМЕНЕНИЕ РАЗДЕЛЕНЫ ПО ПРАВАМ. Смотреть рекламации может и
 * бухгалтер (`claim:read` есть у многих ролей): ему нужно понимать, сколько
 * денег вернули клиентам. А решать судьбу обращения — только тот, кто отвечает
 * за производство (`claim:manage`): решение по гарантии — это обязательство
 * компании, и принимать его должен не любой сотрудник.
 *
 * ПОЧЕМУ ПЕРЕХОД ОТДЕЛЬНЫМ ЭНДПОИНТОМ, А НЕ ПОЛЕМ В PATCH. Смена статуса
 * рекламации — событие с проверкой правил, записью в аудит и в историю заказа.
 * Обычный `PATCH` подразумевал бы «изменить поле», и проверки легко забылись бы
 * при добавлении следующего поля.
 *
 * Тела разбираются схемами из `@app/shared` тем же способом, что и в остальных
 * модулях: `@Body() body: unknown` плюс `safeParse` в сервисе.
 */
@ApiTags('claims')
@ApiCookieAuth()
@Controller()
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Get('claims')
  @RequirePermission(PERMISSION.CLAIM_READ)
  @ApiOperation({ summary: 'Реестр рекламаций' })
  list(
    @Query('status') status?: string,
    @Query('overdue') overdue?: string,
    @Query('orderId') orderId?: string,
  ): Promise<ClaimListItem[]> {
    return this.claims.list({
      ...(status === undefined ? {} : { status }),
      /*
       * Сравнение со строкой `'true'`, а не `Boolean(...)`: `Boolean('false')`
       * вернуло бы `true`, и фильтр «только просроченные» включался бы всегда.
       */
      ...(overdue === undefined ? {} : { overdueOnly: overdue === 'true' }),
      ...(orderId === undefined ? {} : { orderId }),
    });
  }

  @Get('claims/:id')
  @RequirePermission(PERMISSION.CLAIM_READ)
  @ApiOperation({ summary: 'Карточка рекламации' })
  get(@Param('id') id: string): Promise<ClaimDetail> {
    return this.claims.get(id);
  }

  @Post('claims')
  @RequirePermission(PERMISSION.CLAIM_MANAGE)
  @ApiOperation({ summary: 'Открыть рекламацию по заказу' })
  open(@Body() body: unknown, @CurrentUser() actor: AuthenticatedUser): Promise<ClaimDetail> {
    return this.claims.open(body, actor);
  }

  @Post('claims/:id/transition')
  @RequirePermission(PERMISSION.CLAIM_MANAGE)
  @ApiOperation({ summary: 'Сменить статус рекламации' })
  transition(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ClaimDetail> {
    return this.claims.transition(id, body, actor);
  }
}
