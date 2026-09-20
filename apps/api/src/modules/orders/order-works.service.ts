import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  addOrderWorkSchema,
  updateOrderWorkSchema,
  removeOrderWorkSchema,
  isWorksEditable,
  isTerminalStatus,
  resolveItemPrice,
  calcOrderTotal,
  type OrderStatus,
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Состав работ заказа: добавить, изменить, удалить (требование заказчика).
 *
 * ## Почему отдельный сервис
 *
 * Правка состава — не «изменить поле заказа». Она:
 *  * меняет ДЕНЬГИ (`worksTotalMinor` и итог) — а значит, расходится с суммой,
 *    которую подтвердил клиент, и это расхождение обязано быть видно;
 *  * проверяет статус («работы уже выполняются?») и этап;
 *  * подставляет цену по прейскуранту для металла КОНКРЕТНОГО изделия.
 *
 * В `OrdersService` это утонуло бы среди переходов и платежей, и правило
 * «итог пересчитывается ровно так же, как при создании заказа» стало бы
 * неочевидным. Здесь оно в одном месте — и именно поэтому его можно проверить.
 *
 * ## Что важнее всего
 *
 * Итог заказа пересчитывается как `работы + камни − скидка` (общая функция
 * `calcOrderTotal`). Ручное сложение в двух местах уже приводило к дефекту в
 * корректировках: `discountMinor` трактовался как «вычесть», хотя бывает
 * отрицательным (надбавка), и итог расходился со суммой строк.
 */
@Injectable()
export class OrderWorksService {
  private readonly logger = new Logger(OrderWorksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Добавить работу в заказ.
   *
   * Цена берётся из прейскуранта ДЛЯ МЕТАЛЛА ИЗДЕЛИЯ, а не из тела запроса:
   * иначе цену можно было бы назначить произвольно, минуя прейскурант, — а он
   * существует ровно для того, чтобы цены не выдумывались на месте. Свободная
   * цена допускается только для нетиповой работы (`isCustom`), у которой
   * прейскуранта нет по определению.
   */
  async add(orderId: string, input: unknown, user: AuthenticatedUser): Promise<void> {
    const parsed = addOrderWorkSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    await this.prisma.runInTransaction(async (tx) => {
      const order = await this.loadEditableOrder(tx, orderId, user);

      // Изделие: либо указано явно, либо берём единственное в заказе.
      const item = await tx.item.findFirst({
        where: { id: data.itemId ?? undefined, orderId: order.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, metal: true },
      });
      if (item === null) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Изделие не найдено в заказе',
          details: { itemId: ['Выберите изделие этого заказа'] },
        });
      }

      /*
       * Позиция прейскуранта: имя, код, единица и цена берутся из неё, а не из
       * тела. Иначе «Полировка» из прейскуранта могла бы уехать в заказ под
       * названием «Замена камня» — и в квитанции клиент увидел бы не то, что
       * заказывал.
       */
      let code = data.code ?? '';
      let name = data.name ?? '';
      let unit = data.unit ?? 'шт';
      let unitPriceMinor = data.unitPriceMinor ?? 0;

      if (data.priceListItemId !== undefined) {
        const priceItem = await this.resolvePriceItem(tx, data.priceListItemId, item.metal);
        code = priceItem.code;
        name = priceItem.name;
        unit = priceItem.unit;
        unitPriceMinor = priceItem.unitPriceMinor;
      } else {
        if (name.trim().length < 2) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'Укажите название работы',
            details: { name: ['Укажите название работы'] },
          });
        }
        if (code.trim() === '') code = data.isCustom ? 'CUSTOM' : 'MANUAL';
      }

      await tx.orderWork.create({
        data: {
          orderId: order.id,
          itemId: item.id,
          priceListItemId: data.priceListItemId ?? null,
          code,
          name,
          quantity: data.quantity,
          unit,
          unitPriceMinor,
          amountMinor: Math.round(unitPriceMinor * data.quantity),
          durationHours: data.durationHours ?? null,
          warrantyMonths: data.warrantyMonths,
          isCustom: data.isCustom,
          comment: data.comment ?? null,
          createdById: user.id,
        },
      });

      await this.recalcTotals(tx, order.id);

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'ORDER_WORK_ADD',
          entity: 'OrderWork',
          entityId: order.id,
          after: { orderNo: order.orderNo, code, name, quantity: data.quantity, unitPriceMinor },
        },
      });
    });

    this.logger.log(`Заказ ${orderId}: добавлена работа`);
  }

  /** Изменить работу: количество, цену, название, гарантию. */
  async update(
    orderId: string,
    workId: string,
    input: unknown,
    user: AuthenticatedUser,
  ): Promise<void> {
    const parsed = updateOrderWorkSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    await this.prisma.runInTransaction(async (tx) => {
      const order = await this.loadEditableOrder(tx, orderId, user);
      await this.checkVersion(tx, order.id, data.version);

      const work = await tx.orderWork.findFirst({
        where: { id: workId, orderId: order.id },
        select: { id: true, code: true, name: true, quantity: true, unitPriceMinor: true },
      });
      if (work === null) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Работа не найдена в заказе' });
      }

      const quantity = data.quantity ?? Number(work.quantity);
      const unitPrice = data.unitPriceMinor ?? work.unitPriceMinor;

      await tx.orderWork.update({
        where: { id: work.id },
        data: {
          quantity: data.quantity,
          unitPriceMinor: data.unitPriceMinor,
          // Сумма строки пересчитывается ВСЕГДА, даже если изменилось только
          // название: держать её в согласии с количеством и ценой обязан сервер,
          // а не тот, кто прислал запрос.
          amountMinor: Math.round(unitPrice * quantity),
          name: data.name,
          unit: data.unit,
          durationHours: data.durationHours,
          warrantyMonths: data.warrantyMonths,
          comment: data.comment,
        },
      });

      await this.recalcTotals(tx, order.id);

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'ORDER_WORK_UPDATE',
          entity: 'OrderWork',
          entityId: work.id,
          before: {
            name: work.name,
            quantity: Number(work.quantity),
            unitPriceMinor: work.unitPriceMinor,
          },
          after: { name: data.name ?? work.name, quantity, unitPriceMinor: unitPrice },
        },
      });
    });
  }

  /**
   * Удалить работу из заказа.
   *
   * Причина обязательна: удаление строки — это изменение суммы, за которую
   * клиент платит, и в истории должно остаться объяснение. Без причины запись
   * в аудите говорила бы «работу убрали», но не почему.
   */
  async remove(
    orderId: string,
    workId: string,
    input: unknown,
    user: AuthenticatedUser,
  ): Promise<void> {
    const parsed = removeOrderWorkSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Укажите причину удаления работы',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    await this.prisma.runInTransaction(async (tx) => {
      const order = await this.loadEditableOrder(tx, orderId, user);
      await this.checkVersion(tx, order.id, data.version);

      const work = await tx.orderWork.findFirst({
        where: { id: workId, orderId: order.id },
        select: { id: true, code: true, name: true, amountMinor: true },
      });
      if (work === null) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Работа не найдена в заказе' });
      }

      /*
       * Последнюю работу удалить нельзя. Заказ без работ — это заказ без
       * согласованной суммы: `totalAmountMinor` станет нулём, и проверка
       * `APPROVAL_COVERS_TOTAL` уже не пропустит его в работу. Оставлять такое
       * состояние в базе незачем: сотрудник всё равно упрётся в следующем шаге,
       * только непонятно почему.
       */
      const worksCount = await tx.orderWork.count({ where: { orderId: order.id } });
      if (worksCount <= 1) {
        throw new ConflictException({
          code: 'BUSINESS_RULE_VIOLATION',
          message: 'В заказе должна остаться хотя бы одна работа',
        });
      }

      await tx.orderWork.delete({ where: { id: work.id } });
      await this.recalcTotals(tx, order.id);

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'ORDER_WORK_REMOVE',
          entity: 'OrderWork',
          entityId: work.id,
          reason: data.reason,
          before: { code: work.code, name: work.name, amountMinor: work.amountMinor },
        },
      });
    });

    this.logger.log(`Заказ ${orderId}: работа удалена`);
  }

  /** Заказ, у которого вообще можно править состав работ. */
  private async loadEditableOrder(
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
    orderId: string,
    user: AuthenticatedUser,
  ): Promise<{ id: string; orderNo: string; status: OrderStatus }> {
    const order = await tx.order.findFirst({
      where: {
        AND: [
          { id: orderId },
          this.prisma.buildOrderScopeFilter({
            scopes: user.scopes,
            storeIds: user.storeIds,
            userId: user.id,
          }),
        ],
      },
      select: { id: true, orderNo: true, status: true },
    });

    if (order === null) {
      // Не найдено ИЛИ вне области видимости → 404, не 403 (защита от IDOR).
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    if (isTerminalStatus(order.status)) {
      throw new ConflictException({
        code: 'ORDER_FINAL',
        message: 'Заказ закрыт — состав работ изменить нельзя',
      });
    }

    /*
     * Правка разрешена, пока работы не выданы исполнителю. Дальше перечень
     * зафиксирован: ювелир работает по определённому объёму, и правка задним
     * числом означала бы, что заказ описывает не то, что выполняли.
     */
    if (!isWorksEditable(order.status)) {
      throw new ConflictException({
        code: 'WORKS_LOCKED',
        message: 'Работы уже выданы в производство — состав зафиксирован',
        details: { status: order.status },
      });
    }

    return order;
  }

  /** Проверка оптимистичной блокировки: без неё двое затрут правки друг друга. */
  private async checkVersion(
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
    orderId: string,
    version: number,
  ): Promise<void> {
    const current = await tx.order.findUnique({
      where: { id: orderId },
      select: { version: true },
    });
    if (current !== null && current.version !== version) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Заказ изменён другим сотрудником. Обновите страницу и повторите.',
        details: { expected: version, actual: current.version },
      });
    }
  }

  /**
   * Цена позиции прейскуранта для металла ИЗДЕЛИЯ.
   *
   * Металл передаётся в `resolveItemPrice`, а не сравнивается здесь: сравнение
   * свободного текста («Серебро 925») с кодом (`SILVER`) не совпадает никогда,
   * и ошибка при этом не видна — просто применяется цена по умолчанию. Такой
   * дефект в проекте уже случался, поэтому нормализация живёт в одном месте.
   */
  private async resolvePriceItem(
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
    priceListItemId: string,
    metal: string | null,
  ): Promise<{
    code: string;
    name: string;
    unit: string;
    unitPriceMinor: number;
  }> {
    /*
     * Действующий прейскурант — тот же, что фиксируется при создании заказа:
     * `APPROVED` и уже вступивший в силу. Условие повторяет запрос создания
     * заказа намеренно: два разных определения «действующего» прейскуранта
     * разошлись бы, и в цепочку можно было бы добавить работу из черновика
     * или из ещё не вступившей в силу версии.
     */
    const item = await tx.priceListItem.findFirst({
      where: {
        id: priceListItemId,
        priceList: { status: 'APPROVED', effectiveFrom: { lte: new Date() } },
      },
      select: {
        code: true,
        name: true,
        unit: true,
        priceMinor: true,
        priceFrom: true,
        metalCostSeparate: true,
        rates: { select: { metal: true, priceMinor: true, isFrom: true } },
      },
    });

    if (item === null) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Работа не найдена в действующем прейскуранте',
        details: { priceListItemId: ['Выберите работу из действующего прейскуранта'] },
      });
    }

    const resolved = resolveItemPrice(item, metal);

    return {
      code: item.code,
      name: item.name,
      unit: item.unit,
      unitPriceMinor: resolved.priceMinor,
    };
  }

  /**
   * Пересчитать итог заказа после правки состава.
   *
   * Суммы строк берутся из БАЗЫ, а не из тела запроса: только так итог
   * описывает то, что действительно лежит в заказе. Скидка сохраняется —
   * её не трогает правка состава, а `calcOrderTotal` учитывает её знак
   * (она бывает отрицательной, то есть надбавкой).
   */
  private async recalcTotals(
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
    orderId: string,
  ): Promise<void> {
    const [works, stones, current] = await Promise.all([
      tx.orderWork.aggregate({ where: { orderId }, _sum: { amountMinor: true } }),
      tx.orderStone.aggregate({ where: { orderId }, _sum: { amountMinor: true } }),
      tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { discountMinor: true },
      }),
    ]);

    const worksTotalMinor = works._sum.amountMinor ?? 0;
    const stonesTotalMinor = stones._sum.amountMinor ?? 0;
    const totalAmountMinor = calcOrderTotal({
      worksTotalMinor,
      stonesTotalMinor,
      discountMinor: current.discountMinor,
    });

    await tx.order.update({
      where: { id: orderId },
      data: {
        worksTotalMinor,
        stonesTotalMinor,
        totalAmountMinor,
        /*
         * Версия увеличивается: карточка у клиента должна узнать, что состав
         * изменился. Без этого сотрудник со старой версией страницы затёр бы
         * правку своим устаревшим состоянием, и в заказе оказалась бы сумма,
         * которой уже нет.
         */
        version: { increment: 1 },
      },
    });
  }
}
