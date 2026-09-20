import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
// `Prisma` нужен как значение: `Prisma.validator` вызывается при объявлении
// констант выборки. `OrderStatus` — при построении фильтра незавершённых заказов.
import { Prisma, OrderStatus } from '@prisma/client';
import { z } from 'zod';
import {
  createStoreSchema,
  updateStoreSchema,
  createWorkshopSchema,
  updateWorkshopSchema,
  createPerformerSchema,
  updatePerformerSchema,
  createWorkCategorySchema,
  updateWorkCategorySchema,
  createStoneTypeSchema,
  updateStoneTypeSchema,
} from '@app/shared';

import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import {
  STORE_SELECT,
  WORKSHOP_SELECT,
  PERFORMER_SELECT,
  WORK_CATEGORY_SELECT,
  STONE_TYPE_SELECT,
  type StoreDto,
  type WorkshopDto,
  type PerformerDto,
  type WorkCategoryDto,
  type StoneTypeDto,
} from './dictionaries.service';

/**
 * Заказы в этих статусах считаются законченными.
 *
 * Нужны, чтобы отличить «цех отработал всё» от «в цехе ещё лежат изделия»:
 * отключать цех с незавершёнными заказами нельзя, иначе эти заказы останутся
 * без исполнителя и площадки, а менеджер производства не поймёт, куда они делись.
 */
const TERMINAL_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.REFUSED,
  OrderStatus.REFUSED_BEFORE_WORK,
  OrderStatus.CANCELLED,
];

/**
 * Изменение справочников администратором (задача 1.3.1).
 *
 * Отдельный сервис, а не методы `DictionariesService`: чтение справочников
 * доступно почти всем ролям и не пишет в журнал, а изменение — только
 * администратору и всегда оставляет след в `AuditLog` (ТЗ п. 4). Смешав их в
 * одном классе, легко случайно применить правило записи к чтению.
 *
 * ## Удаления нет
 *
 * Ни один метод не удаляет запись. Причина: на магазины, цеха и исполнителей
 * ссылаются заказы, на категории — позиции прейскуранта, на типы камней —
 * строки камней в заказах. `DELETE` разорвал бы историю расчётов, а по
 * `docs/03-data-model.md` справочники, влияющие на уже созданные документы,
 * не удаляются. Поэтому «удаление» в интерфейсе — это `isActive: false`.
 *
 * ## Что защищено отдельно
 *
 * Схемы проверяют формат полей, но не состояние базы. Проверки, для которых
 * нужно обратиться к данным, живут здесь и собраны в одном месте, чтобы
 * администратор получал объяснение, а не ошибку внешнего ключа:
 *
 * - код магазина участвует в номере заказа (`MSK1-2609-000001`), поэтому его
 *   смена запрещена, если у магазина уже есть заказы;
 * - нельзя отключить последний активный магазин — приём заказов остановится;
 * - нельзя отключить магазин, к которому привязаны активные сотрудники: они
 *   потеряли бы доступ к своим заказам;
 * - нельзя отключить цех, у которого есть активные исполнители или
 *   незавершённые заказы;
 * - нельзя отключить исполнителя с незакрытыми назначениями;
 * - нельзя отключить категорию, пока в прейскуранте есть её активные работы.
 */
@Injectable()
export class DictionariesAdminService {
  private readonly logger = new Logger(DictionariesAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Магазины
  // -------------------------------------------------------------------------

  async createStore(input: unknown, actor: AuthenticatedUser): Promise<StoreDto> {
    const data = parseOrThrow(createStoreSchema, input);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const store = await tx.store.create({
          data: {
            code: data.code,
            name: data.name,
            address: data.address ?? null,
            phone: data.phone ?? null,
            timezone: data.timezone,
          },
          select: STORE_SELECT,
        });

        await this.audit(tx, actor, 'CREATE', 'Store', store.id, null, store);
        this.logger.log(`Магазин создан: ${store.code}`);
        return store;
      });
    } catch (error) {
      throw translateCodeViolation(error, 'Магазин с таким кодом уже существует');
    }
  }

  async updateStore(id: string, input: unknown, actor: AuthenticatedUser): Promise<StoreDto> {
    const data = parseOrThrow(updateStoreSchema, input);

    const current = await this.prisma.store.findUnique({ where: { id }, select: STORE_SELECT });
    if (!current) throw notFound('Магазин не найден');

    // Код попадает в человекочитаемый номер заказа. После первого заказа смена
    // кода сделала бы выданные номера несоответствующими магазину, а старые
    // документы — необъяснимыми: заказ `MSK1-2609-000001` числился бы за точкой
    // с кодом `MSK9`.
    if (data.code !== undefined && data.code !== current.code) {
      const orders = await this.prisma.order.count({
        where: { OR: [{ createdStoreId: id }, { pickupStoreId: id }] },
      });
      if (orders > 0) {
        throw new ConflictException({
          code: 'STORE_CODE_IN_USE',
          message: `Нельзя изменить код: у магазина ${orders} заказ(ов), а код входит в их номера`,
        });
      }
    }

    if (data.isActive === false && current.isActive) {
      await this.assertStoreCanBeDeactivated(id);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const store = await tx.store.update({
          where: { id },
          data: {
            code: data.code,
            name: data.name,
            address: data.address,
            phone: data.phone,
            timezone: data.timezone,
            isActive: data.isActive,
          },
          select: STORE_SELECT,
        });

        await this.audit(tx, actor, 'UPDATE', 'Store', id, current, store);
        this.logger.log(`Магазин изменён: ${store.code}`);
        return store;
      });
    } catch (error) {
      throw translateCodeViolation(error, 'Магазин с таким кодом уже существует');
    }
  }

  /**
   * Проверить, что магазин можно вывести из обращения.
   *
   * Отключение не удаляет данные, но делает точку невыбираемой в операционных
   * экранах. Поэтому проверяются два последствия, которые администратор не
   * увидит в списке магазинов: полная остановка приёма и «повисшие» сотрудники.
   */
  private async assertStoreCanBeDeactivated(id: string): Promise<void> {
    const otherActive = await this.prisma.store.count({
      where: { isActive: true, id: { not: id } },
    });
    if (otherActive === 0) {
      throw new ConflictException({
        code: 'LAST_ACTIVE_STORE',
        message:
          'Это единственный активный магазин: приём заказов остановится. Сначала включите другой',
      });
    }

    const assignedUsers = await this.prisma.userRole.count({
      where: { storeId: id, user: { isActive: true } },
    });
    if (assignedUsers > 0) {
      throw new ConflictException({
        code: 'STORE_HAS_ACTIVE_USERS',
        message: `К магазину привязаны активные сотрудники: ${assignedUsers}. Сначала переведите их в другой магазин`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Цеха
  // -------------------------------------------------------------------------

  async createWorkshop(input: unknown, actor: AuthenticatedUser): Promise<WorkshopDto> {
    const data = parseOrThrow(createWorkshopSchema, input);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const workshop = await tx.workshop.create({
          data: { code: data.code, name: data.name, address: data.address ?? null },
          select: WORKSHOP_SELECT,
        });

        await this.audit(tx, actor, 'CREATE', 'Workshop', workshop.id, null, workshop);
        this.logger.log(`Цех создан: ${workshop.code}`);
        return workshop;
      });
    } catch (error) {
      throw translateCodeViolation(error, 'Цех с таким кодом уже существует');
    }
  }

  async updateWorkshop(id: string, input: unknown, actor: AuthenticatedUser): Promise<WorkshopDto> {
    const data = parseOrThrow(updateWorkshopSchema, input);

    const current = await this.prisma.workshop.findUnique({
      where: { id },
      select: WORKSHOP_SELECT,
    });
    if (!current) throw notFound('Цех не найден');

    if (data.isActive === false && current.isActive) {
      const performers = await this.prisma.performer.count({
        where: { workshopId: id, isActive: true },
      });
      if (performers > 0) {
        throw new ConflictException({
          code: 'WORKSHOP_HAS_ACTIVE_PERFORMERS',
          message: `В цехе числятся активные исполнители: ${performers}. Сначала переведите или отключите их`,
        });
      }

      // Незавершённый заказ в отключённом цехе остался бы без площадки: он виден
      // менеджеру производства, но назначить по нему работу было бы некуда.
      const openOrders = await this.prisma.order.count({
        where: { workshopId: id, status: { notIn: TERMINAL_ORDER_STATUSES } },
      });
      if (openOrders > 0) {
        throw new ConflictException({
          code: 'WORKSHOP_HAS_OPEN_ORDERS',
          message: `В цехе незавершённые заказы: ${openOrders}. Дождитесь их выдачи или передайте в другой цех`,
        });
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const workshop = await tx.workshop.update({
          where: { id },
          data: {
            code: data.code,
            name: data.name,
            address: data.address,
            isActive: data.isActive,
          },
          select: WORKSHOP_SELECT,
        });

        await this.audit(tx, actor, 'UPDATE', 'Workshop', id, current, workshop);
        this.logger.log(`Цех изменён: ${workshop.code}`);
        return workshop;
      });
    } catch (error) {
      throw translateCodeViolation(error, 'Цех с таким кодом уже существует');
    }
  }

  // -------------------------------------------------------------------------
  // Исполнители производства
  // -------------------------------------------------------------------------

  async createPerformer(input: unknown, actor: AuthenticatedUser): Promise<PerformerDto> {
    const data = parseOrThrow(createPerformerSchema, input);
    await this.assertWorkshopExists(data.workshopId);

    return this.prisma.$transaction(async (tx) => {
      const performer = await tx.performer.create({
        data: {
          workshopId: data.workshopId,
          fullName: data.fullName,
          specialization: data.specialization ?? null,
          grade: data.grade ?? null,
        },
        select: PERFORMER_SELECT,
      });

      await this.audit(tx, actor, 'CREATE', 'Performer', performer.id, null, performer);
      this.logger.log(`Исполнитель создан: ${performer.id}`);
      return performer;
    });
  }

  async updatePerformer(
    id: string,
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<PerformerDto> {
    const data = parseOrThrow(updatePerformerSchema, input);

    const current = await this.prisma.performer.findUnique({
      where: { id },
      select: PERFORMER_SELECT,
    });
    if (!current) throw notFound('Исполнитель не найден');

    if (data.workshopId !== undefined && data.workshopId !== current.workshop.id) {
      await this.assertWorkshopExists(data.workshopId);
    }

    if (data.isActive === false && current.isActive) {
      // Незакрытое назначение означает, что работа закреплена за ювелиром.
      // Отключив его, менеджер производства потерял бы исполнителя в списке,
      // а заказ остался бы «в работе» без ответственного.
      const openAssignments = await this.prisma.orderAssignment.count({
        where: { performerId: id, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
      });
      if (openAssignments > 0) {
        throw new ConflictException({
          code: 'PERFORMER_HAS_OPEN_ASSIGNMENTS',
          message: `У исполнителя незакрытые назначения: ${openAssignments}. Сначала завершите или переназначьте работы`,
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const performer = await tx.performer.update({
        where: { id },
        data: {
          workshopId: data.workshopId,
          fullName: data.fullName,
          specialization: data.specialization,
          grade: data.grade,
          isActive: data.isActive,
        },
        select: PERFORMER_SELECT,
      });

      await this.audit(tx, actor, 'UPDATE', 'Performer', id, current, performer);
      this.logger.log(`Исполнитель изменён: ${id}`);
      return performer;
    });
  }

  private async assertWorkshopExists(workshopId: string): Promise<void> {
    const workshop = await this.prisma.workshop.findUnique({
      where: { id: workshopId },
      select: { id: true, isActive: true },
    });
    if (!workshop) {
      throw new BadRequestException({
        code: 'WORKSHOP_NOT_FOUND',
        message: 'Указанный цех не найден',
        details: { workshopId: ['Цех не найден'] },
      });
    }
    // Нового исполнителя нельзя завести в закрытом цехе: он сразу оказался бы
    // недоступен для назначения, и администратор не понял бы, почему.
    if (!workshop.isActive) {
      throw new ConflictException({
        code: 'WORKSHOP_INACTIVE',
        message: 'Цех отключён: включите его или выберите другой',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Категории работ
  // -------------------------------------------------------------------------

  async createWorkCategory(input: unknown, actor: AuthenticatedUser): Promise<WorkCategoryDto> {
    const data = parseOrThrow(createWorkCategorySchema, input);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const category = await tx.workCategory.create({
          data: { code: data.code, name: data.name, sortOrder: data.sortOrder },
          select: WORK_CATEGORY_SELECT,
        });

        await this.audit(tx, actor, 'CREATE', 'WorkCategory', category.id, null, category);
        this.logger.log(`Категория работ создана: ${category.code}`);
        return category;
      });
    } catch (error) {
      throw translateCodeViolation(error, 'Категория с таким кодом уже существует');
    }
  }

  async updateWorkCategory(
    id: string,
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<WorkCategoryDto> {
    const data = parseOrThrow(updateWorkCategorySchema, input);

    const current = await this.prisma.workCategory.findUnique({
      where: { id },
      select: WORK_CATEGORY_SELECT,
    });
    if (!current) throw notFound('Категория работ не найдена');

    if (data.isActive === false && current.isActive) {
      // Категория — только группировка прейскуранта, поэтому её отключение не
      // трогает сами работы. Но если в действующем прейскуранте есть активные
      // позиции этой категории, они останутся рабочими и «повиснут» без группы.
      const activeItems = await this.prisma.priceListItem.count({
        where: { categoryId: id, isActive: true },
      });
      if (activeItems > 0) {
        throw new ConflictException({
          code: 'CATEGORY_HAS_ACTIVE_ITEMS',
          message: `В прейскуранте есть активные работы этой категории: ${activeItems}. Сначала отключите или перенесите их`,
        });
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const category = await tx.workCategory.update({
          where: { id },
          data: {
            code: data.code,
            name: data.name,
            sortOrder: data.sortOrder,
            isActive: data.isActive,
          },
          select: WORK_CATEGORY_SELECT,
        });

        await this.audit(tx, actor, 'UPDATE', 'WorkCategory', id, current, category);
        this.logger.log(`Категория работ изменена: ${category.code}`);
        return category;
      });
    } catch (error) {
      throw translateCodeViolation(error, 'Категория с таким кодом уже существует');
    }
  }

  // -------------------------------------------------------------------------
  // Типы камней
  // -------------------------------------------------------------------------

  async createStoneType(input: unknown, actor: AuthenticatedUser): Promise<StoneTypeDto> {
    const data = parseOrThrow(createStoneTypeSchema, input);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const stoneType = await tx.stoneType.create({
          data: {
            code: data.code,
            name: data.name,
            unit: data.unit,
            priceMinor: data.priceMinor,
          },
          select: STONE_TYPE_SELECT,
        });

        await this.audit(tx, actor, 'CREATE', 'StoneType', stoneType.id, null, stoneType);
        this.logger.log(`Тип камня создан: ${stoneType.code}`);
        return stoneType;
      });
    } catch (error) {
      throw translateCodeViolation(error, 'Тип камня с таким кодом уже существует');
    }
  }

  async updateStoneType(
    id: string,
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<StoneTypeDto> {
    const data = parseOrThrow(updateStoneTypeSchema, input);

    const current = await this.prisma.stoneType.findUnique({
      where: { id },
      select: STONE_TYPE_SELECT,
    });
    if (!current) throw notFound('Тип камня не найден');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const stoneType = await tx.stoneType.update({
          where: { id },
          data: {
            code: data.code,
            name: data.name,
            unit: data.unit,
            priceMinor: data.priceMinor,
            isActive: data.isActive,
          },
          select: STONE_TYPE_SELECT,
        });

        await this.audit(tx, actor, 'UPDATE', 'StoneType', id, current, stoneType);
        this.logger.log(`Тип камня изменён: ${stoneType.code}`);
        return stoneType;
      });
    } catch (error) {
      throw translateCodeViolation(error, 'Тип камня с таким кодом уже существует');
    }
  }

  // -------------------------------------------------------------------------
  // Аудит
  // -------------------------------------------------------------------------

  /**
   * Запись в журнал действий (ТЗ п. 4).
   *
   * Вызывается внутри той же транзакции, что и само изменение: иначе при сбое
   * в журнале осталась бы правка, которой нет в данных, либо наоборот —
   * изменение без следа. ФИО исполнителя в записи есть, и это осознанно:
   * журнал должен отвечать на вопрос «кто это был», а справочник исполнителей
   * не является учётными данными.
   */
  private async audit(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    action: 'CREATE' | 'UPDATE',
    entity: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.primaryRole,
        action,
        entity,
        entityId,
        before: action === 'CREATE' ? Prisma.JsonNull : (before as Prisma.InputJsonValue),
        after: after as Prisma.InputJsonValue,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

function notFound(message: string): NotFoundException {
  return new NotFoundException({ code: 'NOT_FOUND', message });
}

function validationError(fieldErrors: Record<string, string[] | undefined>): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Проверьте правильность заполнения полей',
    details: fieldErrors,
  });
}

/**
 * Разобрать тело запроса и вернуть ошибку в общем формате API.
 *
 * `input` и `output` разведены явно по той же причине, что в `parseQueryOrThrow`:
 * у `z.ZodType<T>` выходной тип — `any`, и на схемах с `default(...)` это давало
 * бы предупреждение `no-unsafe-return`.
 */
function parseOrThrow<Output, Input = unknown>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.flatten().fieldErrors);
  return parsed.data;
}

/**
 * Превратить нарушение уникальности кода в понятную ошибку.
 *
 * Коды всех пяти справочников уникальны (`@unique`), поэтому проверка одна на
 * всех. Отдельный предварительный `findUnique` не нужен: между проверкой и
 * вставкой код мог бы занять другой администратор, и ошибка всё равно пришла бы
 * от базы — но уже необработанная.
 */
function translateCodeViolation(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException({ code: 'CODE_TAKEN', message });
  }
  return error;
}
