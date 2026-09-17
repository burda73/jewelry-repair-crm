import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';
import { DictionariesService } from './dictionaries.service';
import type {
  ActivePriceList,
  PerformerDto,
  PriceListItemDto,
  PriceListVersionDetail,
  PriceListVersionListItem,
  StoneTypeDto,
  StoreDto,
  WorkCategoryDto,
  WorkshopDto,
} from './dictionaries.service';
import { RequirePermission } from '../../common/auth/roles.decorator';

/**
 * Справочные данные: магазины, цеха, исполнители, категории работ, камни
 * и прейскурант (docs/07-api-spec.md §9, §10, §13).
 *
 * Контроллер один, а пути разные (`/stores`, `/workshops`, `/price-lists`…),
 * поэтому `@Controller()` объявлен без префикса, а полный путь задан в каждом
 * методе — как в `PaymentsController`. Разносить справочники по отдельным
 * контроллерам смысла нет: сервис один, права на чтение пересекаются, а
 * прейскурант и его позиции обязаны жить в одном классе — иначе порядок
 * маршрутов (`/price-lists/active` до `/price-lists/:id`) перестал бы быть
 * локальным и стал бы зависеть от порядка регистрации модулей.
 *
 * Только чтение: CRUD справочников — отдельная задача. Гварды
 * (`JwtAuthGuard`, `RolesGuard`) подключены глобально в `AuthModule` и здесь
 * повторно не объявляются.
 */
@ApiTags('dictionaries')
@ApiCookieAuth()
@Controller()
export class DictionariesController {
  constructor(private readonly dictionariesService: DictionariesService) {}

  @Get('stores')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Список магазинов' })
  findStores(): Promise<StoreDto[]> {
    return this.dictionariesService.findStores();
  }

  @Get('stores/:id')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Магазин' })
  findStore(@Param('id') id: string): Promise<StoreDto> {
    return this.dictionariesService.findStore(id);
  }

  @Get('workshops')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Цеха' })
  findWorkshops(): Promise<WorkshopDto[]> {
    return this.dictionariesService.findWorkshops();
  }

  @Get('performers')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Исполнители производства (ювелиры)' })
  @ApiQuery({ name: 'workshopId', required: false, type: String })
  @ApiQuery({
    name: 'isActive',
    required: false,
    type: Boolean,
    description: 'true | false. Без параметра возвращаются все исполнители',
  })
  findPerformers(
    @Query('workshopId') workshopId?: string,
    @Query('isActive') isActive?: string,
  ): Promise<PerformerDto[]> {
    return this.dictionariesService.findPerformers({ workshopId, isActive });
  }

  @Get('work-categories')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Категории работ' })
  findWorkCategories(): Promise<WorkCategoryDto[]> {
    return this.dictionariesService.findWorkCategories();
  }

  @Get('stone-types')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Справочник камней' })
  findStoneTypes(): Promise<StoneTypeDto[]> {
    return this.dictionariesService.findStoneTypes();
  }

  @Get('price-lists')
  @RequirePermission(PERMISSION.PRICELIST_READ)
  @ApiOperation({ summary: 'Версии прейскуранта (список)' })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'DRAFT | PENDING_APPROVAL | APPROVED | ARCHIVED | REJECTED',
  })
  findPriceLists(@Query('status') status?: string): Promise<PriceListVersionListItem[]> {
    return this.dictionariesService.findPriceLists({ status });
  }

  /**
   * Действующая (утверждённая) версия прейскуранта для расчёта.
   *
   * ВАЖНО: объявлен ДО `:id`, иначе «active» был бы принят за идентификатор
   * версии и запрос уходил бы в поиск по `id` (тот же приём — в
   * `orders.controller.ts`, маршруты `search` и `summary`).
   *
   * Пустой ответ (`null`) означает «утверждённого прейскуранта нет»: это
   * штатное состояние, поэтому не 404 — см. `DictionariesService.findActivePriceList`.
   */
  @Get('price-lists/active')
  @RequirePermission(PERMISSION.PRICELIST_READ)
  @ApiOperation({ summary: 'Активная (APPROVED) версия прейскуранта с позициями' })
  @ApiQuery({
    name: 'storeId',
    required: false,
    type: String,
    description: 'Магазин: своя версия предпочтительнее общей (без магазина)',
  })
  findActivePriceList(@Query('storeId') storeId?: string): Promise<ActivePriceList | null> {
    return this.dictionariesService.findActivePriceList({ storeId });
  }

  /**
   * Позиции действующего прейскуранта.
   * ВАЖНО: объявлен ДО `price-lists/:id`-совместимых маршрутов не требуется —
   * путь отличается (`price-list-items`), но порядок сохранён для наглядности.
   */
  @Get('price-list-items')
  @RequirePermission(PERMISSION.PRICELIST_READ)
  @ApiOperation({ summary: 'Позиции активного прейскуранта с фильтрами' })
  @ApiQuery({ name: 'categoryId', required: false, type: String })
  @ApiQuery({ name: 'storeId', required: false, type: String })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Поиск по названию или артикулу' })
  findPriceListItems(
    @Query('categoryId') categoryId?: string,
    @Query('q') q?: string,
    @Query('storeId') storeId?: string,
  ): Promise<PriceListItemDto[]> {
    return this.dictionariesService.findPriceListItems({ categoryId, q, storeId });
  }

  @Get('price-lists/:id')
  @RequirePermission(PERMISSION.PRICELIST_READ)
  @ApiOperation({ summary: 'Версия прейскуранта с позициями' })
  findPriceList(@Param('id') id: string): Promise<PriceListVersionDetail> {
    return this.dictionariesService.findPriceList(id);
  }
}
