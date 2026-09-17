import { Body, Controller, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';
import { DictionariesAdminService } from './dictionaries-admin.service';
import type {
  PerformerDto,
  StoneTypeDto,
  StoreDto,
  WorkCategoryDto,
  WorkshopDto,
} from './dictionaries.service';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Администрирование справочников (задача 1.3.1).
 *
 * Отдельный контроллер, а не методы `DictionariesController`: у чтения и записи
 * разные права и разные последствия. `DictionariesController` открыт почти всем
 * ролям, и добавление туда `POST`/`PATCH` рядом с `@RequirePermission(ORDER_READ)`
 * делало бы ошибку в декораторе опасной — приёмщик смог бы переименовать магазин.
 * Здесь каждое право задано явно и один раз.
 *
 * Удаления нет ни у одного ресурса: справочники отключаются (`isActive: false`),
 * потому что на них ссылаются заказы и прейскурант (см. `DictionariesAdminService`).
 *
 * ## Права
 *
 * - магазины, цеха, категории работ, типы камней — `SETTINGS_MANAGE` (ADMIN);
 * - исполнители — `PERFORMER_MANAGE` (ADMIN и PRODUCTION_MANAGER).
 *
 * Исполнители выделены намеренно: по матрице прав (docs/02-domain-and-roles.md §4)
 * строку «Исполнители производства» ведёт менеджер производства, а не
 * администратор. Требовать здесь ADMIN значило бы отобрать у него работу,
 * которую документация ему уже отдала.
 *
 * Пути объявлены полностью в каждом методе (`@Controller()` без префикса) —
 * так же, как в `DictionariesController`, чтобы порядок маршрутов оставался
 * локальным для класса.
 */
@ApiTags('dictionaries-admin')
@ApiCookieAuth()
@Controller()
export class DictionariesAdminController {
  constructor(private readonly adminService: DictionariesAdminService) {}

  // -------------------------------------------------------------------------
  // Магазины
  // -------------------------------------------------------------------------

  @Post('stores')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать магазин' })
  createStore(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser): Promise<StoreDto> {
    return this.adminService.createStore(body, user);
  }

  /**
   * Изменить магазин.
   *
   * `PATCH`, а не `PUT`: администратор меняет отдельные поля, и требовать полный
   * объект значило бы заставлять клиента присылать обратно всё, что он прочитал.
   */
  @Patch('stores/:id')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({
    summary: 'Изменить магазин (отключение — isActive: false; код неизменяем при наличии заказов)',
  })
  updateStore(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StoreDto> {
    return this.adminService.updateStore(id, body, user);
  }

  // -------------------------------------------------------------------------
  // Цеха
  // -------------------------------------------------------------------------

  @Post('workshops')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать цех' })
  createWorkshop(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkshopDto> {
    return this.adminService.createWorkshop(body, user);
  }

  @Patch('workshops/:id')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Изменить цех (отключение — isActive: false)' })
  updateWorkshop(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkshopDto> {
    return this.adminService.updateWorkshop(id, body, user);
  }

  // -------------------------------------------------------------------------
  // Исполнители производства
  // -------------------------------------------------------------------------

  @Post('performers')
  @RequirePermission(PERMISSION.PERFORMER_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать исполнителя производства' })
  createPerformer(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PerformerDto> {
    return this.adminService.createPerformer(body, user);
  }

  @Patch('performers/:id')
  @RequirePermission(PERMISSION.PERFORMER_MANAGE)
  @ApiOperation({ summary: 'Изменить исполнителя (перевод в другой цех, отключение)' })
  updatePerformer(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PerformerDto> {
    return this.adminService.updatePerformer(id, body, user);
  }

  // -------------------------------------------------------------------------
  // Категории работ
  // -------------------------------------------------------------------------

  @Post('work-categories')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать категорию работ' })
  createWorkCategory(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkCategoryDto> {
    return this.adminService.createWorkCategory(body, user);
  }

  @Patch('work-categories/:id')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Изменить категорию работ (отключение — isActive: false)' })
  updateWorkCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkCategoryDto> {
    return this.adminService.updateWorkCategory(id, body, user);
  }

  // -------------------------------------------------------------------------
  // Типы камней
  // -------------------------------------------------------------------------

  @Post('stone-types')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать тип камня' })
  createStoneType(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StoneTypeDto> {
    return this.adminService.createStoneType(body, user);
  }

  @Patch('stone-types/:id')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Изменить тип камня (цена, единица, отключение)' })
  updateStoneType(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StoneTypeDto> {
    return this.adminService.updateStoneType(id, body, user);
  }
}
