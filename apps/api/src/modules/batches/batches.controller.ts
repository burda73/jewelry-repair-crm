import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';

import { BatchesService } from './batches.service';
import type { BatchDetailDto, BatchDto } from './batches.service';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Логистика: партии (задача 2.1, ТЗ п. 2.6, docs/07 §8).
 *
 * Права: чтение — `logistics:read`, изменение состава — `logistics:manage`.
 * По матрице ролей (docs/02 §4) партии ведут логист и руководитель
 * производства; руководитель и администратор их видят.
 *
 * Область видимости различается по ролям и вычисляется в сервисе: логист и
 * руководитель производства видят все рейсы, приёмщик — только свои.
 *
 * Разбор тел идёт через `safeParse` и `BadRequestException`, как в остальных
 * контроллерах проекта: схема — единственный источник правил, и её сообщение
 * об ошибке должно доходить до интерфейса целиком, а не превращаться в
 * «Bad Request».
 */
@ApiTags('batches')
@ApiCookieAuth()
@Controller('batches')
export class BatchesController {
  constructor(private readonly batchesService: BatchesService) {}

  @Get()
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Список партий' })
  list(
    @Query() rawQuery: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: BatchDto[]; nextCursor: string | null }> {
    return this.batchesService.list(rawQuery, user);
  }

  @Post()
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Создать партию' })
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser): Promise<BatchDetailDto> {
    return this.batchesService.create(body, user);
  }

  @Get(':id')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Партия с составом' })
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    return this.batchesService.findOne(id, user);
  }

  @Get(':id/candidates')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Заказы, которые можно включить в партию' })
  candidates(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Awaited<ReturnType<BatchesService['candidates']>>> {
    return this.batchesService.candidates(id, user);
  }

  @Post(':id/orders')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Добавить заказы в партию' })
  addOrders(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    return this.batchesService.addOrders(id, body, user);
  }

  /**
   * Исключить заказ из партии.
   *
   * `DELETE` с телом — необычно, но причина обязательна, а поместить её в путь
   * нельзя: это свободный текст. Строка при этом не удаляется физически, а
   * помечается `removedAt` с причиной: состав входит в акт приёма-передачи, и
   * «куда делся заказ» должно быть объяснимо после подписания.
   */
  @Delete(':id/orders/:orderId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Убрать заказ из партии (с причиной)' })
  removeOrder(
    @Param('id') id: string,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    return this.batchesService.removeOrder(id, orderId, body, user);
  }
}
