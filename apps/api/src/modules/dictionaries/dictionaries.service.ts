import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
// `Prisma` и `PriceListStatus` нужны как значения: `Prisma.validator` вызывается
// при объявлении констант запросов, а `PriceListStatus.APPROVED` — при построении
// фильтра. Поэтому import без `type`.
import { Prisma, PriceListStatus } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Константы запросов справочников.
 *
 * Объявлены через `Prisma.validator`, чтобы из них можно было вывести типы
 * (`Prisma.StoreGetPayload<...>` и т.п.). Это единый источник истины: тип ответа
 * вычисляется из самого запроса, поэтому добавленное в `select` поле
 * автоматически появляется в типе, а удалённое — исчезает. Рукописные
 * интерфейсы здесь разошлись бы с реальным ответом API при первом изменении.
 */
export const STORE_SELECT = Prisma.validator<Prisma.StoreSelect>()({
  id: true,
  code: true,
  name: true,
  address: true,
  phone: true,
  timezone: true,
  isActive: true,
});

export const WORKSHOP_SELECT = Prisma.validator<Prisma.WorkshopSelect>()({
  id: true,
  code: true,
  name: true,
  address: true,
  isActive: true,
});

/** Исполнитель вместе с цехом: в UI он выбирается как «ФИО — цех». */
export const PERFORMER_SELECT = Prisma.validator<Prisma.PerformerSelect>()({
  id: true,
  fullName: true,
  specialization: true,
  grade: true,
  isActive: true,
  workshop: { select: { id: true, code: true, name: true } },
});

export const WORK_CATEGORY_SELECT = Prisma.validator<Prisma.WorkCategorySelect>()({
  id: true,
  code: true,
  name: true,
  sortOrder: true,
  isActive: true,
});

export const STONE_TYPE_SELECT = Prisma.validator<Prisma.StoneTypeSelect>()({
  id: true,
  code: true,
  name: true,
  unit: true,
  priceMinor: true,
  isActive: true,
});

/**
 * Позиция прейскуранта, отдаваемая наружу.
 *
 * `costMinor` (себестоимость) в ответ НЕ включён намеренно: право на чтение
 * прейскуранта есть и у приёмщика, и у кассира, которым маржинальность видеть
 * не нужно. Себестоимость участвует только в отчёте о маржинальности
 * (docs/06-reporting.md §4), который отдаётся отдельным правом.
 *
 * `rates` (цены по металлам) включены обязательно: утверждённый прейскурант
 * задаёт для каждой услуги ДВЕ цены — по золоту и по серебру. Без них мастер
 * приёма не сможет посчитать заказ по металлу сданного изделия и возьмёт
 * цену по умолчанию, то есть серебряное изделие посчитает по золотому тарифу.
 */
export const PRICE_LIST_ITEM_SELECT = Prisma.validator<Prisma.PriceListItemSelect>()({
  id: true,
  priceListId: true,
  categoryId: true,
  code: true,
  name: true,
  description: true,
  unit: true,
  priceMinor: true,
  priceFrom: true,
  metalCostSeparate: true,
  durationHours: true,
  warrantyMonths: true,
  requiresPrepayment: true,
  isActive: true,
  category: { select: { id: true, code: true, name: true } },
  rates: {
    select: { metal: true, priceMinor: true, isFrom: true },
    orderBy: { metal: 'asc' },
  },
});

/** Порядок позиций: по категории прейскуранта, внутри — по артикулу. */
export const PRICE_LIST_ITEM_ORDER = Prisma.validator<
  Prisma.PriceListItemOrderByWithRelationInput[]
>()([{ category: { sortOrder: 'asc' } }, { code: 'asc' }]);

export const PRICE_LIST_SELECT = Prisma.validator<Prisma.PriceListVersionSelect>()({
  id: true,
  version: true,
  storeId: true,
  status: true,
  effectiveFrom: true,
  effectiveTo: true,
  comment: true,
  approvedAt: true,
  rejectionReason: true,
  createdAt: true,
  store: { select: { id: true, code: true, name: true } },
  _count: { select: { items: true } },
});

/**
 * Версия прейскуранта с позициями для карточки (`GET /price-lists/:id`).
 * Отдаются ВСЕ позиции, включая неактивные: администратор должен видеть,
 * какие работы выведены из обращения, а не обнаруживать их пропажу.
 */
export const PRICE_LIST_DETAIL_INCLUDE = Prisma.validator<Prisma.PriceListVersionInclude>()({
  store: { select: { id: true, code: true, name: true } },
  items: { orderBy: PRICE_LIST_ITEM_ORDER, select: PRICE_LIST_ITEM_SELECT },
});

/**
 * Действующая версия для расчёта (`GET /price-lists/active`).
 * Здесь, наоборот, только активные позиции: по неактивной работе нельзя
 * посчитать заказ.
 */
const ACTIVE_PRICE_LIST_INCLUDE = Prisma.validator<Prisma.PriceListVersionInclude>()({
  store: { select: { id: true, code: true, name: true } },
  items: {
    where: { isActive: true },
    orderBy: PRICE_LIST_ITEM_ORDER,
    select: PRICE_LIST_ITEM_SELECT,
  },
});

/** Порядок выбора действующей версии при пересечении интервалов действия. */
const ACTIVE_VERSION_ORDER = Prisma.validator<Prisma.PriceListVersionOrderByWithRelationInput[]>()([
  { effectiveFrom: 'desc' },
  { version: 'desc' },
]);

export type StoreDto = Prisma.StoreGetPayload<{ select: typeof STORE_SELECT }>;
export type WorkshopDto = Prisma.WorkshopGetPayload<{ select: typeof WORKSHOP_SELECT }>;
export type PerformerDto = Prisma.PerformerGetPayload<{ select: typeof PERFORMER_SELECT }>;
export type WorkCategoryDto = Prisma.WorkCategoryGetPayload<{
  select: typeof WORK_CATEGORY_SELECT;
}>;
export type StoneTypeDto = Prisma.StoneTypeGetPayload<{ select: typeof STONE_TYPE_SELECT }>;
export type PriceListItemDto = Prisma.PriceListItemGetPayload<{
  select: typeof PRICE_LIST_ITEM_SELECT;
}>;
/** Версия прейскуранта в списке: без позиций, но со счётчиком. */
export type PriceListVersionListItem = Prisma.PriceListVersionGetPayload<{
  select: typeof PRICE_LIST_SELECT;
}>;
export type PriceListVersionDetail = Prisma.PriceListVersionGetPayload<{
  include: typeof PRICE_LIST_DETAIL_INCLUDE;
}>;
export type ActivePriceList = Prisma.PriceListVersionGetPayload<{
  include: typeof ACTIVE_PRICE_LIST_INCLUDE;
}>;

/** Фильтры списка исполнителей (значения — как пришли в query-строке). */
export interface PerformerQuery {
  workshopId?: string;
  isActive?: string;
}

/** Фильтр списка версий прейскуранта. */
export interface PriceListQuery {
  status?: string;
}

/** Фильтры действующего прейскуранта. */
export interface ActivePriceListQuery {
  storeId?: string;
}

/** Фильтры позиций действующего прейскуранта. */
export interface PriceListItemQuery {
  categoryId?: string;
  q?: string;
  /** Магазин, для которого нужен прейскурант: у магазина может быть своя версия. */
  storeId?: string;
}

// ---------------------------------------------------------------------------
// Валидация query-параметров
// ---------------------------------------------------------------------------

/**
 * Схемы разбора query-строки.
 *
 * В `@app/shared` их нет: там лежат схемы домена (заказ, платёж, новая версия
 * прейскуранта), общие для API и веб-интерфейса. Здесь — только правила чтения
 * фильтров справочников, нужные единственному контроллеру. Когда появится CRUD
 * справочников (отдельная задача), фильтры переедут в общий пакет.
 */
const idSchema = z.string().cuid('Некорректный идентификатор');

/**
 * Логическое значение из query-строки.
 *
 * `z.coerce.boolean()` использовать нельзя: он считает истиной любую непустую
 * строку, в том числе `"false"` — фильтр «только неактивные» молча отдавал бы
 * активных.
 */
const booleanQuerySchema = z
  .string()
  .refine((value) => value === 'true' || value === 'false', 'Ожидается true или false')
  .transform((value) => value === 'true');

const performerQuerySchema = z.object({
  workshopId: idSchema.optional(),
  isActive: booleanQuerySchema.optional(),
});

const priceListQuerySchema = z.object({
  status: z
    .nativeEnum(PriceListStatus, {
      errorMap: () => ({ message: 'Недопустимый статус прейскуранта' }),
    })
    .optional(),
});

const activePriceListQuerySchema = z.object({
  storeId: idSchema.optional(),
});

/**
 * Строка текстового поиска.
 *
 * Пустая строка (`?q=`) приводится к «фильтра не было»: интерфейс шлёт её,
 * когда пользователь стёр текст в поле поиска, и ответ `400` на пустое поле
 * выглядел бы как ошибка, хотя искать просто нечего. Пробелы по краям
 * срезаются по той же причине.
 */
const optionalSearchSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length <= 200, 'Строка поиска слишком длинная')
  .transform((value) => (value === '' ? undefined : value));

const priceListItemQuerySchema = z.object({
  categoryId: idSchema.optional(),
  storeId: idSchema.optional(),
  q: optionalSearchSchema.optional(),
});

/**
 * Разобрать query-параметры и вернуть ошибку в общем формате API.
 *
 * Формат ответа тот же, что у `orders.service.create`: клиент получает разбор
 * полей в `details` и подсвечивает конкретный фильтр, а не показывает общее
 * «неверный запрос».
 *
 * `input` и `output` разведены явно (`z.ZodType<Output, z.ZodTypeDef, Input>`):
 * у `z.ZodType<T>` выходной тип — `any`, и на схеме с `transform`
 * (флаг `isActive` приводится из строки) это давало предупреждение
 * `no-unsafe-return`. Разведённые параметры сохраняют точный тип результата
 * без приведения (`as`), то есть без отключения проверки типов.
 */
function parseQueryOrThrow<Output, Input = unknown>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Проверьте правильность заполнения полей',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  return parsed.data;
}

/**
 * Чтение справочных данных для мастера приёма заказа и администрирования.
 *
 * Класс только читает (GET). Запись живёт в `DictionariesAdminService`
 * (задача 1.3.1), поэтому здесь нет ни транзакций, ни записи в `AuditLog`:
 * аудит ведётся для изменений (ТЗ п. 4), а чтение справочника следа в журнале
 * не оставляет.
 *
 * Область видимости (`DataScope`) к справочникам не применяется: она ограничивает
 * ЗАКАЗЫ, а магазины, цеха и прейскурант — общие данные сети. Заказ можно принять
 * в любом магазине (ответ на вопрос 4 ТЗ), поэтому список магазинов не сужается
 * до магазинов пользователя.
 */
@Injectable()
export class DictionariesService {
  private readonly logger = new Logger(DictionariesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Магазины сети.
   *
   * Возвращаются и неактивные записи (с `isActive: false`), но первыми идут
   * активные: закрытая точка должна быть видна администратору, а приёмщик
   * отфильтровывает её по флагу. Скрывать неактивные на сервере нельзя — тогда
   * в админке «пропадали» бы магазины, которые надо включить обратно.
   */
  async findStores(): Promise<StoreDto[]> {
    return this.prisma.store.findMany({
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      select: STORE_SELECT,
    });
  }

  /** Магазин по идентификатору. */
  async findStore(storeId: string): Promise<StoreDto> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: STORE_SELECT,
    });

    if (!store) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Магазин не найден' });
    }

    return store;
  }

  /** Цеха (производственные площадки). */
  async findWorkshops(): Promise<WorkshopDto[]> {
    return this.prisma.workshop.findMany({
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      select: WORKSHOP_SELECT,
    });
  }

  /**
   * Исполнители производства (ювелиры).
   *
   * Фильтры `workshopId` и `isActive` необязательны: без них возвращаются все
   * исполнители, включая уволенных, — интерфейс сам решает, показывать ли их
   * (например, для разбора старых назначений).
   */
  async findPerformers(query: PerformerQuery): Promise<PerformerDto[]> {
    const filters = parseQueryOrThrow(performerQuerySchema, query);

    const where: Prisma.PerformerWhereInput = {};
    if (filters.workshopId !== undefined) where.workshopId = filters.workshopId;
    if (filters.isActive !== undefined) where.isActive = filters.isActive;

    return this.prisma.performer.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      select: PERFORMER_SELECT,
    });
  }

  /** Категории работ — группировка прейскуранта в интерфейсе. */
  async findWorkCategories(): Promise<WorkCategoryDto[]> {
    return this.prisma.workCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: WORK_CATEGORY_SELECT,
    });
  }

  /** Справочник камней: цена за единицу подставляется в калькуляцию. */
  async findStoneTypes(): Promise<StoneTypeDto[]> {
    return this.prisma.stoneType.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: STONE_TYPE_SELECT,
    });
  }

  /**
   * Версии прейскуранта, новые сверху.
   *
   * Без фильтра отдаются все версии: руководителю нужна история правок цен,
   * а не только действующая. Фильтр `status` — для выбора, например, черновиков,
   * ожидающих утверждения.
   */
  async findPriceLists(query: PriceListQuery): Promise<PriceListVersionListItem[]> {
    const filters = parseQueryOrThrow(priceListQuerySchema, query);

    const where: Prisma.PriceListVersionWhereInput = {};
    if (filters.status !== undefined) where.status = filters.status;

    return this.prisma.priceListVersion.findMany({
      where,
      orderBy: ACTIVE_VERSION_ORDER,
      select: PRICE_LIST_SELECT,
    });
  }

  /**
   * Версия прейскуранта с позициями.
   *
   * Отдаёт ЛЮБУЮ версию по идентификатору (включая черновик) — это карточка
   * прейскуранта, а не «цена для расчёта». Право на чтение (`PRICELIST_READ`)
   * есть у всех ролей, участвующих в расчёте.
   */
  async findPriceList(priceListId: string): Promise<PriceListVersionDetail> {
    const version = await this.prisma.priceListVersion.findUnique({
      where: { id: priceListId },
      include: PRICE_LIST_DETAIL_INCLUDE,
    });

    if (!version) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Версия прейскуранта не найдена' });
    }

    return version;
  }

  /**
   * Действующий (утверждённый) прейскурант для расчёта.
   *
   * Условие «действует сейчас»: `status = APPROVED`, начало действия наступило
   * (`effectiveFrom <= now`), окончание не задано или ещё не наступило. Если
   * интервалы пересеклись, выигрывает версия с более поздним `effectiveFrom`,
   * затем — с большим номером версии.
   *
   * При `storeId` сначала ищется версия этого магазина, и только потом — общая
   * версия сети (`storeId = null`): у точки могут быть свои цены, но если их нет,
   * расчёт идёт по сетевому прейскуранту. Ответ содержит `storeId`, поэтому
   * клиент всегда видит, чей прейскурант он получил.
   *
   * Если утверждённой версии нет, возвращается `null` (HTTP 200), а НЕ 404:
   * «прейскурант не утверждён» — штатное состояние системы (например, до
   * утверждения первой версии), и мастер приёма должен показать понятное
   * сообщение, а не ошибку запроса. Молча подставлять черновик нельзя: расчёт
   * по неутверждённым ценам — это выставленная клиенту сумма, которую
   * руководитель ещё не согласовал.
   */
  async findActivePriceList(query: ActivePriceListQuery): Promise<ActivePriceList | null> {
    const filters = parseQueryOrThrow(activePriceListQuerySchema, query);

    if (filters.storeId !== undefined) {
      const storeVersion = await this.prisma.priceListVersion.findFirst({
        where: this.activeVersionWhere(filters.storeId),
        orderBy: ACTIVE_VERSION_ORDER,
        include: ACTIVE_PRICE_LIST_INCLUDE,
      });

      if (storeVersion) {
        this.logger.debug(
          `Действующий прейскурант магазина ${filters.storeId}: версия ${storeVersion.version}`,
        );
        return storeVersion;
      }
    }

    const commonVersion = await this.prisma.priceListVersion.findFirst({
      where: this.activeVersionWhere(null),
      orderBy: ACTIVE_VERSION_ORDER,
      include: ACTIVE_PRICE_LIST_INCLUDE,
    });

    if (!commonVersion) {
      this.logger.debug('Действующий утверждённый прейскурант не найден — расчёт недоступен');
    }

    return commonVersion;
  }

  /**
   * Позиции действующего прейскуранта с фильтрами.
   *
   * Нужны шагу «Работы и камни» мастера приёма: список длинный, его ищут по
   * названию или артикулу и сужают по категории. Отдаются только активные
   * позиции — по выведенной из прейскуранта работе заказ не считают. Если
   * утверждённого прейскуранта нет, возвращается пустой список (200): клиент
   * уже получил `null` от `/price-lists/active` и знает причину.
   */
  async findPriceListItems(query: PriceListItemQuery): Promise<PriceListItemDto[]> {
    const filters = parseQueryOrThrow(priceListItemQuerySchema, query);

    const activePriceListId = await this.resolveActivePriceListId(filters.storeId);
    if (activePriceListId === null) {
      this.logger.debug('Позиции прейскуранта запрошены, но действующей версии нет');
      return [];
    }

    const where: Prisma.PriceListItemWhereInput = {
      priceListId: activePriceListId,
      isActive: true,
    };
    if (filters.categoryId !== undefined) where.categoryId = filters.categoryId;
    if (filters.q !== undefined) {
      // Поиск по названию и артикулу: по ним работу ищут в интерфейсе.
      // Описание в поиск не входит — оно длинное и даёт шумные совпадения.
      where.OR = [
        { name: { contains: filters.q, mode: 'insensitive' } },
        { code: { contains: filters.q, mode: 'insensitive' } },
      ];
    }

    return this.prisma.priceListItem.findMany({
      where,
      orderBy: PRICE_LIST_ITEM_ORDER,
      select: PRICE_LIST_ITEM_SELECT,
    });
  }

  /**
   * Условие «версия действует на текущий момент» для конкретного владельца.
   * `null` в `storeId` — общий прейскурант сети.
   */
  private activeVersionWhere(storeId: string | null): Prisma.PriceListVersionWhereInput {
    const now = new Date();

    return {
      AND: [
        {
          status: PriceListStatus.APPROVED,
          effectiveFrom: { lte: now },
          // `effectiveTo: null` — «срок не ограничен».
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        { storeId },
      ],
    };
  }

  /** Идентификатор действующей версии для магазина или сети (иначе `null`). */
  private async resolveActivePriceListId(storeId?: string): Promise<string | null> {
    if (storeId !== undefined) {
      const storeVersion = await this.prisma.priceListVersion.findFirst({
        where: this.activeVersionWhere(storeId),
        orderBy: ACTIVE_VERSION_ORDER,
        select: { id: true },
      });

      if (storeVersion) return storeVersion.id;
    }

    const commonVersion = await this.prisma.priceListVersion.findFirst({
      where: this.activeVersionWhere(null),
      orderBy: ACTIVE_VERSION_ORDER,
      select: { id: true },
    });

    return commonVersion?.id ?? null;
  }
}
