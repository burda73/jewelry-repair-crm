import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { PriceListAdminService } from './price-list-admin.service';
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
import type { PriceListVersionDetail, PriceListVersionListItem } from './dictionaries.service';
import { RequirePermission, RequireStrictPermission } from '../../common/auth/roles.decorator';
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
  constructor(
    private readonly adminService: DictionariesAdminService,
    private readonly priceListService: PriceListAdminService,
  ) {}

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

  // -------------------------------------------------------------------------
  // Прейскурант (задачи 1.4.2–1.4.3)
  // -------------------------------------------------------------------------

  /*
   * Права разделены намеренно, по матрице `docs/02-domain-and-roles.md` §4:
   *
   *  * `PRICELIST_EDIT` — ADMIN. Правит и отправляет на утверждение;
   *  * `PRICELIST_APPROVE` — MANAGER и CHIEF_ACCOUNTANT. Достаточно ОДНОЙ
   *    подписи (ответ A2, `docs/00-decisions.md` §1.2), поэтому право есть у
   *    обеих ролей, и approving фиксируется в аудите по конкретному сотруднику.
   *
   * Администратор по матрице прейскурант НЕ утверждает. Это не случайность:
   * подпись под ценами — контрольная функция, и совмещать её с правом правки
   * значило бы позволить одному человеку и назначить цену, и её утвердить.
   */
  @Post('price-lists')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать черновик версии прейскуранта' })
  createPriceList(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.priceListService.createVersion(body, user);
  }

  @Get('price-lists/:id/editor')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @ApiOperation({ summary: 'Версия прейскуранта с позициями для редактора' })
  findPriceListForEdit(@Param('id') id: string): Promise<PriceListVersionDetail> {
    return this.priceListService.findVersion(id);
  }

  @Patch('price-lists/:id')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @ApiOperation({ summary: 'Изменить черновик версии (даты, примечание, магазин)' })
  updatePriceList(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.priceListService.updateVersion(id, body, user);
  }

  @Post('price-lists/:id/items')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Добавить позицию в черновик прейскуранта' })
  createPriceListItem(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ id: string }> {
    return this.priceListService.createItem(id, body, user);
  }

  @Patch('price-list-items/:itemId')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @ApiOperation({ summary: 'Изменить позицию прейскуранта (цена, ставки по металлам)' })
  updatePriceListItem(
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ id: string }> {
    return this.priceListService.updateItem(itemId, body, user);
  }

  /**
   * Отключить позицию. `DELETE` отсутствует: на позицию ссылаются работы уже
   * принятых заказов, и удаление разорвало бы историю расчётов.
   */
  @Post('price-list-items/:itemId/deactivate')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отключить позицию прейскуранта (isActive: false)' })
  deactivatePriceListItem(
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ id: string; isActive: boolean }> {
    return this.priceListService.deactivateItem(itemId, user);
  }

  /**
   * Отправить версию на утверждение.
   *
   * `PRICELIST_EDIT`: отправляет тот, кто правил. Утверждает уже другая роль —
   * см. пояснение о разделении прав выше.
   */
  @Post('price-lists/:id/submit')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отправить версию прейскуранта на утверждение' })
  submitPriceList(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.priceListService.applyAction(id, 'SUBMIT', {}, user);
  }

  @Post('price-lists/:id/approve')
  @RequireStrictPermission(PERMISSION.PRICELIST_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Утвердить версию прейскуранта (одной подписи достаточно)' })
  approvePriceList(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.priceListService.applyAction(id, 'APPROVE', {}, user);
  }

  @Post('price-lists/:id/reject')
  @RequireStrictPermission(PERMISSION.PRICELIST_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отклонить версию прейскуранта с причиной' })
  rejectPriceList(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.priceListService.applyAction(id, 'REJECT', body, user);
  }

  @Post('price-lists/:id/restore-to-draft')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вернуть версию из «на утверждении» в черновик' })
  restorePriceListToDraft(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.priceListService.applyAction(id, 'RESTORE_TO_DRAFT', {}, user);
  }

  @Post('price-lists/:id/archive')
  @RequireStrictPermission(PERMISSION.PRICELIST_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отправить утверждённую версию в архив' })
  archivePriceList(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.priceListService.applyAction(id, 'ARCHIVE', {}, user);
  }

  /**
   * Создать новую версию на основе существующей.
   *
   * Это и есть способ изменить утверждённые цены: правка их запрещена
   * (задача 1.4.3), а новая версия начинается с уже набранных позиций.
   */
  @Post('price-lists/:id/copy')
  @RequirePermission(PERMISSION.PRICELIST_EDIT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать новую версию прейскуранта на основе этой' })
  copyPriceList(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.priceListService.applyAction(id, 'COPY', body, user);
  }
}
