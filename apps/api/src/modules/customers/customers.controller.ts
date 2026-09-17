import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import type { CustomerSearchItem, CustomerCard, CustomerDetails } from './customers.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { PERMISSION } from '@app/shared';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Клиенты (первый шаг мастера создания заказа).
 *
 * Гварды `JwtAuthGuard` и `RolesGuard` подключены глобально в auth.module.ts —
 * повторно здесь они не регистрируются. Ограничение задаётся только
 * `@RequirePermission`.
 *
 * Права: поиск, создание и изменение — `ORDER_CREATE` (клиента заводит
 * приёмщик при оформлении заказа, отдельного права на клиента матрица
 * ролей не предусматривает). Карточка с историей заказов — `ORDER_READ`.
 */
@ApiTags('customers')
@ApiCookieAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  /**
   * Поиск клиента по телефону или ФИО.
   *
   * ВАЖНО: объявлен ДО `:id`, иначе «search» был бы принят за идентификатор
   * клиента (тот же порядок, что в orders.controller.ts).
   */
  @Get('search')
  @RequirePermission(PERMISSION.ORDER_CREATE)
  @ApiOperation({ summary: 'Поиск клиента по телефону (нормализованному) или ФИО' })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Телефон или ФИО' })
  search(@Query('q') q?: string): Promise<CustomerSearchItem[]> {
    return this.customersService.search(q ?? '');
  }

  @Post()
  @RequirePermission(PERMISSION.ORDER_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать клиента (409, если телефон уже зарегистрирован)' })
  create(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerDetails> {
    return this.customersService.create(body, user);
  }

  @Get(':id')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Карточка клиента с историей заказов (последние 10)' })
  findOne(@Param('id') id: string): Promise<CustomerCard> {
    return this.customersService.findOne(id);
  }

  /**
   * Изменение данных клиента.
   *
   * `PATCH`, а не `PUT`: приходит только изменённая часть полей. `@HttpCode(200)`
   * проставлен явно — по умолчанию Nest отвечает на `PATCH` кодом 200, но
   * неявная зависимость от умолчания ломается при смене фреймворка, а контракт
   * уже зафиксирован в docs/07-api-spec.md.
   */
  @Patch(':id')
  @RequirePermission(PERMISSION.ORDER_CREATE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Изменить ФИО, email, заметки и согласия клиента' })
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerDetails> {
    return this.customersService.update(id, body, user);
  }
}
