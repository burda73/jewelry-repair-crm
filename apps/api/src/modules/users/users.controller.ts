import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';
import { UsersService } from './users.service';
import type { RolesCatalog, UserDetail, UserListItem } from './users.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Управление учётными записями и ролями (задача 1.2.4, docs/07-api-spec.md §13).
 *
 * Все маршруты требуют права `user:manage`, которое по матрице ролей есть
 * только у ADMIN. Гварды `JwtAuthGuard` и `RolesGuard` подключены глобально
 * в `auth.module.ts` — повторно здесь не регистрируются.
 *
 * Роли, выданные учётной записи, не отдаются отдельным справочником прав:
 * `GET /users/roles-catalog` возвращает матрицу «роль → права» из доменного
 * пакета, чтобы экран администратора показывал ровно то, что получит сотрудник,
 * а не собственную копию матрицы.
 *
 * Порядок маршрутов: `roles-catalog` объявлен до `:id`, иначе слово
 * «roles-catalog» было бы принято за идентификатор учётной записи (тот же приём,
 * что с `search` и `summary` в `orders.controller.ts`).
 */
@ApiTags('users')
@ApiCookieAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('roles-catalog')
  @RequirePermission(PERMISSION.USER_MANAGE)
  @ApiOperation({ summary: 'Справочник ролей с правами и областей видимости' })
  getRolesCatalog(): RolesCatalog {
    return this.usersService.getRolesCatalog();
  }

  @Get()
  @RequirePermission(PERMISSION.USER_MANAGE)
  @ApiOperation({ summary: 'Список учётных записей' })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'ФИО, почта или телефон' })
  @ApiQuery({
    name: 'isActive',
    required: false,
    type: Boolean,
    description: 'true | false. Без параметра возвращаются все',
  })
  @ApiQuery({ name: 'role', required: false, type: String, description: 'Код роли' })
  findAll(
    @Query('q') q?: string,
    @Query('isActive') isActive?: string,
    @Query('role') role?: string,
  ): Promise<UserListItem[]> {
    return this.usersService.findAll({ q, isActive, role });
  }

  @Post()
  @RequirePermission(PERMISSION.USER_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Создать учётную запись (пароль задаёт администратор, смена — при первом входе)',
  })
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser): Promise<UserDetail> {
    return this.usersService.create(body, user);
  }

  @Get(':id')
  @RequirePermission(PERMISSION.USER_MANAGE)
  @ApiOperation({ summary: 'Карточка учётной записи с вычисленными правами' })
  findOne(@Param('id') id: string): Promise<UserDetail> {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSION.USER_MANAGE)
  @ApiOperation({
    summary: 'Изменить учётную запись (отключение завершает её активные сессии)',
  })
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserDetail> {
    return this.usersService.update(id, body, user);
  }

  @Post(':id/roles')
  @RequirePermission(PERMISSION.USER_MANAGE)
  @ApiOperation({ summary: 'Назначить роль' })
  assignRole(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserDetail> {
    return this.usersService.assignRole(id, body, user);
  }

  /**
   * Снять роль.
   *
   * `:roleId` — идентификатор назначения (`user_role.id`), а не код роли: одна
   * роль может быть назначена в нескольких магазинах, и снимать нужно
   * конкретное назначение.
   */
  @Delete(':id/roles/:roleId')
  @RequirePermission(PERMISSION.USER_MANAGE)
  @ApiOperation({ summary: 'Снять роль (снятие последней роли запрещено)' })
  revokeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserDetail> {
    return this.usersService.revokeRole(id, roleId, user);
  }

  @Post(':id/reset-password')
  @RequirePermission(PERMISSION.USER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Сбросить пароль (все сессии учётной записи завершаются)' })
  resetPassword(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.usersService.resetPassword(id, body, user);
  }
}
