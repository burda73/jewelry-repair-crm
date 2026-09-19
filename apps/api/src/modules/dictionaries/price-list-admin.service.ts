import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Prisma, PriceListStatus } from '@prisma/client';
import { z } from 'zod';
import {
  createPriceListSchema,
  updatePriceListSchema,
  priceListItemSchema,
  updatePriceListItemSchema,
  rejectPriceListSchema,
  copyPriceListSchema,
  canApplyPriceListAction,
  isPriceListEditable,
  PRICE_LIST_EDIT_DENIED_CODE,
  PRICE_LIST_EDIT_DENIED_MESSAGE,
  type PriceListAction,
  type PriceListStatus as PriceListStatusCode,
} from '@app/shared';

import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import {
  PRICE_LIST_SELECT,
  PRICE_LIST_DETAIL_INCLUDE,
  type PriceListVersionListItem,
  type PriceListVersionDetail,
} from './dictionaries.service';

/**
 * Редактирование прейскуранта (задачи 1.4.2–1.4.3).
 *
 * ## Зачем отдельный сервис
 *
 * Прейскурант — это ЦЕНЫ, и цена утверждённой версии уже применена в заказах.
 * Поэтому у него правила строже, чем у остальных справочников: версия проходит
 * путь «черновик → на утверждение → утверждена», а утверждённая перестаёт
 * правиться. Держать эти правила рядом с магазинами и типами камней значило бы
 * смешивать «изменяемое» и «неизменяемое» в одном классе, где случайная правка
 * одного не бросается в глаза.
 *
 * ## Утверждённую версию не правят — её заменяют
 *
 * Главное правило (задача 1.4.3). Изменение цены задним числом сделало бы
 * историю недостоверной, причём НЕЗАМЕТНО: суммы в заказах хранятся копией
 * (`OrderWork.unitPriceMinor`), поэтому старый заказ выглядел бы верным, а
 * расхождение с прейскурантом всплыло бы при разборе жалобы. Изменение идёт
 * через новую версию: `COPY` на основе утверждённой или архивной.
 *
 * Правила переходов живут в `@app/shared` (`price-list.ts`) и здесь не
 * дублируются: интерфейс прячет недоступные действия по тем же функциям, и
 * разойдись они — кнопка вела бы к отказу.
 *
 * ## Что защищено отдельно
 *
 * - нельзя отправить на утверждение пустую версию: утверждать нечего, а
 *   действующим прейскурантом стала бы версия без работ;
 * - нельзя создать две версии с одним номером (уникальность `storeId + version`);
 * - нельзя утвердить версию, не отправив её;
 * - при копировании номер новой версии выдаётся сервером, а не клиентом: иначе
 *   два администратора получили бы один номер;
 * - утверждение версии архивирует предыдущую действующую: одновременно
 *   действующих прейскурантов быть не должно, иначе расчёт недетерминирован.
 */
@Injectable()
export class PriceListAdminService {
  private readonly logger = new Logger(PriceListAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Версия
  // -------------------------------------------------------------------------

  /**
   * Создать черновик версии.
   *
   * Номер версии вычисляется как «максимальный + 1» в рамках магазина (общий
   * прейскурант — `storeId: null`). Считается в транзакции, чтобы два
   * одновременных создания не получили один номер; уникальное ограничение
   * `[storeId, version]` — вторая линия защиты.
   */
  async createVersion(input: unknown, actor: AuthenticatedUser): Promise<PriceListVersionListItem> {
    const data = parseOrThrow(createPriceListSchema, input);

    return this.prisma.$transaction(async (tx) => {
      const last = await tx.priceListVersion.findFirst({
        where: { storeId: data.storeId ?? null },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (last?.version ?? 0) + 1;

      const created = await tx.priceListVersion.create({
        data: {
          version,
          storeId: data.storeId ?? null,
          effectiveFrom: data.effectiveFrom,
          comment: data.comment ?? null,
          createdById: actor.id,
          status: PriceListStatus.DRAFT,
        },
        select: PRICE_LIST_SELECT,
      });

      await this.audit(tx, actor, 'CREATE', 'PriceListVersion', created.id, null, created);
      this.logger.log(`Черновик прейскуранта создан: версия ${version}`);
      return created;
    });
  }

  /**
   * Изменить «шапку» версии (даты, примечание, магазин).
   *
   * Магазин меняется только у черновика: перенос версии между магазинами после
   * утверждения означал бы, что утверждали для одной точки, а действует в другой.
   */
  async updateVersion(
    id: string,
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    const data = parseOrThrow(updatePriceListSchema, input);
    const current = await this.requireVersion(id, actor);

    /*
     * ГЛАВНОЕ ПРАВИЛО ЗАДАЧИ 1.4.3. Проверка обязана стоять здесь: «шапка»
     * версии — такая же часть документа, как позиции. Даты действия определяют,
     * к каким заказам применяется цена, поэтому их правка в утверждённой версии
     * меняет расчёт задним числом ровно так же, как правка самой цены.
     */
    this.assertEditable(current.status);

    /*
     * Интервал проверяется по ИТОГОВЫМ значениям: одно из двух полей могло быть
     * задано ранее, и проверять только присланную пару значило бы пропустить
     * «конец раньше начала», собранный из старого и нового значений. Схема такой
     * случай поймать не может — она видит лишь присланные поля.
     */
    const nextFrom = data.effectiveFrom ?? current.effectiveFrom;
    const nextTo = data.effectiveTo !== undefined ? data.effectiveTo : current.effectiveTo;
    if (nextTo !== null && nextTo <= nextFrom) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Дата окончания должна быть позже даты начала',
        details: { effectiveTo: ['Дата окончания должна быть позже даты начала'] },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.priceListVersion.update({
        where: { id },
        data: {
          ...(data.effectiveFrom !== undefined ? { effectiveFrom: data.effectiveFrom } : {}),
          ...(data.effectiveTo !== undefined ? { effectiveTo: data.effectiveTo } : {}),
          ...(data.comment !== undefined ? { comment: data.comment } : {}),
          ...(data.storeId !== undefined ? { storeId: data.storeId } : {}),
        },
        select: PRICE_LIST_SELECT,
      });

      await this.audit(tx, actor, 'UPDATE', 'PriceListVersion', id, current, updated);
      this.logger.log(`Прейскурант изменён: версия ${updated.version}`);
      return updated;
    });
  }

  /** Версия с позициями для редактора. */
  async findVersion(id: string): Promise<PriceListVersionDetail> {
    const version = await this.prisma.priceListVersion.findUnique({
      where: { id },
      include: PRICE_LIST_DETAIL_INCLUDE,
    });
    if (!version) throw notFound('Версия прейскуранта не найдена');
    return version;
  }

  // -------------------------------------------------------------------------
  // Позиции
  // -------------------------------------------------------------------------

  async createItem(
    versionId: string,
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<{ id: string }> {
    const data = parseOrThrow(priceListItemSchema, input);
    const version = await this.requireVersion(versionId, actor);
    this.assertEditable(version.status);

    if (data.categoryId !== undefined) {
      await this.requireCategory(data.categoryId);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const item = await tx.priceListItem.create({
          data: {
            priceListId: versionId,
            categoryId: data.categoryId ?? null,
            code: data.code,
            name: data.name,
            description: data.description ?? null,
            unit: data.unit,
            priceMinor: data.priceMinor,
            priceFrom: data.priceFrom,
            metalCostSeparate: data.metalCostSeparate,
            costMinor: data.costMinor ?? null,
            durationHours: data.durationHours ?? null,
            warrantyMonths: data.warrantyMonths,
            requiresPrepayment: data.requiresPrepayment,
            isActive: data.isActive,
          },
          select: { id: true },
        });

        if (data.rates.length > 0) {
          await tx.priceListItemRate.createMany({
            data: data.rates.map((rate) => ({
              itemId: item.id,
              metal: rate.metal,
              priceMinor: rate.priceMinor,
              isFrom: rate.isFrom,
            })),
          });
        }

        await this.audit(tx, actor, 'CREATE', 'PriceListItem', item.id, null, {
          ...data,
          priceListId: versionId,
        });
        this.logger.log(`Позиция прейскуранта создана: ${data.code}`);
        return item;
      });
    } catch (error) {
      throw translateDuplicate(error, 'Артикул уже есть в этой версии прейскуранта');
    }
  }

  /**
   * Изменить позицию.
   *
   * Ставки по металлам заменяются целиком (`deleteMany` + вставка), а не
   * доливаются: иначе удаление колонки из прейскуранта оставляло бы старую
   * ставку, и цена по удалённому металлу продолжала бы применяться.
   */
  async updateItem(
    itemId: string,
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<{ id: string }> {
    const data = parseOrThrow(updatePriceListItemSchema, input);

    const current = await this.prisma.priceListItem.findUnique({
      where: { id: itemId },
      include: { priceList: { select: { id: true, status: true } } },
    });
    if (!current) throw notFound('Позиция прейскуранта не найдена');
    this.assertEditable(current.priceList.status);

    if (data.categoryId !== undefined && data.categoryId !== null) {
      await this.requireCategory(data.categoryId);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.priceListItem.update({
          where: { id: itemId },
          data: {
            ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
            ...(data.code !== undefined ? { code: data.code } : {}),
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.unit !== undefined ? { unit: data.unit } : {}),
            ...(data.priceMinor !== undefined ? { priceMinor: data.priceMinor } : {}),
            ...(data.priceFrom !== undefined ? { priceFrom: data.priceFrom } : {}),
            ...(data.metalCostSeparate !== undefined
              ? { metalCostSeparate: data.metalCostSeparate }
              : {}),
            ...(data.costMinor !== undefined ? { costMinor: data.costMinor } : {}),
            ...(data.durationHours !== undefined ? { durationHours: data.durationHours } : {}),
            ...(data.warrantyMonths !== undefined ? { warrantyMonths: data.warrantyMonths } : {}),
            ...(data.requiresPrepayment !== undefined
              ? { requiresPrepayment: data.requiresPrepayment }
              : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });

        if (data.rates !== undefined) {
          await tx.priceListItemRate.deleteMany({ where: { itemId } });
          if (data.rates.length > 0) {
            await tx.priceListItemRate.createMany({
              data: data.rates.map((rate) => ({
                itemId,
                metal: rate.metal,
                priceMinor: rate.priceMinor,
                isFrom: rate.isFrom,
              })),
            });
          }
        }

        const after = await tx.priceListItem.findUniqueOrThrow({
          where: { id: itemId },
          select: { id: true, code: true, name: true, priceMinor: true, isActive: true },
        });
        await this.audit(tx, actor, 'UPDATE', 'PriceListItem', itemId, current, after);
        this.logger.log(`Позиция прейскуранта изменена: ${after.code}`);
        return after;
      });
    } catch (error) {
      throw translateDuplicate(error, 'Артикул уже есть в этой версии прейскуранта');
    }
  }

  /**
   * Отключить позицию (`isActive: false`).
   *
   * Удаления нет намеренно. На позицию ссылаются строки работ заказов
   * (`OrderWork.priceListItemId`); удаление обнулило бы ссылку и лишило бы
   * аналитику «какие работы популярны» даже по прошлым заказам. Отключённая
   * позиция исчезает из выбора при приёме, но остаётся объяснением старых сумм.
   */
  async deactivateItem(
    itemId: string,
    actor: AuthenticatedUser,
  ): Promise<{ id: string; isActive: boolean }> {
    const current = await this.prisma.priceListItem.findUnique({
      where: { id: itemId },
      include: { priceList: { select: { id: true, status: true } } },
    });
    if (!current) throw notFound('Позиция прейскуранта не найдена');
    this.assertEditable(current.priceList.status);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.priceListItem.update({
        where: { id: itemId },
        data: { isActive: false },
        select: { id: true, isActive: true },
      });
      await this.audit(tx, actor, 'UPDATE', 'PriceListItem', itemId, current, updated);
      this.logger.log(`Позиция прейскуранта отключена: ${current.code}`);
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Действия над статусом
  // -------------------------------------------------------------------------

  /**
   * Выполнить действие над версией: отправка, утверждение, отклонение, архив,
   * возврат в черновик, создание новой версии на основе этой.
   *
   * Один метод на все действия, а не пять отдельных: проверка допустимости
   * перехода и запись в аудит у них общие, а разные — только тело. Разнеси я их
   * по методам, каждый пришлось бы не забыть снабдить проверкой перехода, и
   * забытая проверка означала бы, например, правку утверждённой версии.
   */
  async applyAction(
    id: string,
    action: PriceListAction,
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    const version = await this.requireVersion(id, actor);

    if (!canApplyPriceListAction(action, version.status)) {
      throw new ConflictException({
        code: 'PRICE_LIST_ACTION_NOT_ALLOWED',
        message: `Действие «${action}» недоступно для версии в статусе «${version.status}»`,
      });
    }

    if (action === 'COPY') return this.copyVersion(version, input, actor);
    if (action === 'REJECT') return this.rejectVersion(version, input, actor);
    if (action === 'APPROVE') return this.approveVersion(version, actor);
    if (action === 'SUBMIT') return this.submitVersion(version, actor);

    /*
     * `EDIT` — не переход статуса, а право менять содержимое. Оно уже проверено
     * выше (`canApplyPriceListAction`), и отдельного действия не требует: правки
     * приходят на маршруты позиций. Попадание сюда означало бы, что вызов
     * пришёл из кода, который ждёт смены статуса, — поэтому это ошибка, а не
     * «ничего не делать».
     */
    if (action === 'EDIT') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Правка выполняется отдельными запросами к позициям прейскуранта',
      });
    }

    return this.setStatus(version, action, actor);
  }

  /**
   * Отправить на утверждение.
   *
   * Пустую версию отправлять нельзя: утверждать в ней нечего, а утверждённой
   * стала бы версия без работ — приём перестал бы находить цены.
   */
  private async submitVersion(
    version: { id: string; version: number },
    actor: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    const activeItems = await this.prisma.priceListItem.count({
      where: { priceListId: version.id, isActive: true },
    });
    if (activeItems === 0) {
      throw new ConflictException({
        code: 'PRICE_LIST_EMPTY',
        message: 'В версии нет ни одной активной позиции — утверждать нечего',
      });
    }

    return this.setStatus(version, 'SUBMIT', actor);
  }

  /**
   * Утвердить версию.
   *
   * Предыдущая утверждённая версия того же магазина уходит в архив: одновременно
   * действующих прейскурантов быть не должно, иначе расчёт цены недетерминирован —
   * `findActivePriceList` выбирал бы между двумя.
   */
  private async approveVersion(
    version: { id: string; storeId: string | null; version: number },
    actor: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.priceListVersion.findMany({
        where: {
          storeId: version.storeId,
          status: PriceListStatus.APPROVED,
          id: { not: version.id },
        },
        select: { id: true, version: true },
      });

      for (const old of previous) {
        await tx.priceListVersion.update({
          where: { id: old.id },
          data: { status: PriceListStatus.ARCHIVED, effectiveTo: new Date() },
        });
        await this.audit(
          tx,
          actor,
          'UPDATE',
          'PriceListVersion',
          old.id,
          { status: PriceListStatus.APPROVED },
          { status: PriceListStatus.ARCHIVED },
        );
      }

      const approved = await tx.priceListVersion.update({
        where: { id: version.id },
        data: {
          status: PriceListStatus.APPROVED,
          approvedById: actor.id,
          approvedAt: new Date(),
        },
        select: PRICE_LIST_SELECT,
      });

      await this.audit(tx, actor, 'UPDATE', 'PriceListVersion', version.id, null, approved);
      this.logger.log(`Прейскурант утверждён: версия ${approved.version}`);
      return approved;
    });
  }

  /** Отклонить версию с обязательной причиной. */
  private async rejectVersion(
    version: { id: string },
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    const data = parseOrThrow(rejectPriceListSchema, input);

    return this.prisma.$transaction(async (tx) => {
      const rejected = await tx.priceListVersion.update({
        where: { id: version.id },
        data: { status: PriceListStatus.REJECTED, rejectionReason: data.reason },
        select: PRICE_LIST_SELECT,
      });
      await this.audit(tx, actor, 'UPDATE', 'PriceListVersion', version.id, null, rejected);
      this.logger.log(`Прейскурант отклонён: версия ${rejected.version}`);
      return rejected;
    });
  }

  /**
   * Создать новую версию на основе существующей.
   *
   * Номер выдаёт сервер: клиент не должен его присылать, иначе два
   * администратора получили бы одинаковый номер и уникальное ограничение
   * `[storeId, version]` отвергло бы второго с невнятной ошибкой.
   */
  private async copyVersion(
    version: { id: string; storeId: string | null; version: number },
    input: unknown,
    actor: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    const data = parseOrThrow(copyPriceListSchema, input);

    // Копирование запрещено из читаемых-только статусов версии-ИСТОЧНИКА?
    // Нет: `COPY` разрешён именно из `APPROVED` и `ARCHIVED`, потому что правка
    // их запрещена — новая версия и есть способ изменить цены.
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.priceListVersion.findFirst({
        where: { storeId: version.storeId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const newVersionNo = (last?.version ?? 0) + 1;

      const created = await tx.priceListVersion.create({
        data: {
          version: newVersionNo,
          storeId: version.storeId,
          effectiveFrom: data.effectiveFrom,
          comment: data.comment ?? `На основе версии ${version.version}`,
          createdById: actor.id,
          status: PriceListStatus.DRAFT,
        },
        select: { id: true },
      });

      if (data.withItems) {
        const items = await tx.priceListItem.findMany({
          where: { priceListId: version.id },
          include: { rates: true },
        });

        for (const item of items) {
          const copy = await tx.priceListItem.create({
            data: {
              priceListId: created.id,
              categoryId: item.categoryId,
              code: item.code,
              name: item.name,
              description: item.description,
              unit: item.unit,
              priceMinor: item.priceMinor,
              priceFrom: item.priceFrom,
              metalCostSeparate: item.metalCostSeparate,
              costMinor: item.costMinor,
              durationHours: item.durationHours,
              warrantyMonths: item.warrantyMonths,
              requiresPrepayment: item.requiresPrepayment,
              isActive: item.isActive,
            },
            select: { id: true },
          });

          if (item.rates.length > 0) {
            await tx.priceListItemRate.createMany({
              data: item.rates.map((rate) => ({
                itemId: copy.id,
                metal: rate.metal,
                priceMinor: rate.priceMinor,
                isFrom: rate.isFrom,
              })),
            });
          }
        }
      }

      const result = await tx.priceListVersion.findUniqueOrThrow({
        where: { id: created.id },
        select: PRICE_LIST_SELECT,
      });

      await this.audit(tx, actor, 'CREATE', 'PriceListVersion', created.id, null, {
        copyOf: version.id,
        withItems: data.withItems,
      });
      this.logger.log(`Создана версия ${newVersionNo} на основе ${version.version}`);
      return result;
    });
  }

  /** Простой переход статуса (архив, возврат в черновик). */
  private async setStatus(
    version: { id: string },
    action: 'ARCHIVE' | 'RESTORE_TO_DRAFT' | 'SUBMIT',
    actor: AuthenticatedUser,
  ): Promise<PriceListVersionListItem> {
    const status =
      action === 'ARCHIVE'
        ? PriceListStatus.ARCHIVED
        : action === 'SUBMIT'
          ? PriceListStatus.PENDING_APPROVAL
          : PriceListStatus.DRAFT;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.priceListVersion.update({
        where: { id: version.id },
        data: {
          status,
          // Сброс подписи при возврате в черновик: иначе версия выглядела бы
          // утверждённой тем же руководителем, который её и вернул на доработку.
          ...(action === 'RESTORE_TO_DRAFT'
            ? { approvedById: null, approvedAt: null, rejectionReason: null }
            : {}),
        },
        select: PRICE_LIST_SELECT,
      });
      await this.audit(tx, actor, 'UPDATE', 'PriceListVersion', version.id, null, updated);
      this.logger.log(`Статус прейскуранта изменён: версия ${updated.version} → ${status}`);
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Вспомогательные проверки
  // -------------------------------------------------------------------------

  /** Версия обязана существовать; заодно проверяется доступ к магазину. */
  private async requireVersion(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<{
    id: string;
    version: number;
    storeId: string | null;
    /** Статус из БД. Тип — `PriceListStatus` схемы, а не строковый код
     *  `@app/shared`: значения совпадают, но так проверка правки не требует
     *  утверждения типа, которое может скрыть настоящее расхождение. */
    status: PriceListStatus;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }> {
    const version = await this.prisma.priceListVersion.findUnique({
      where: { id },
      select: {
        id: true,
        version: true,
        storeId: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    });
    if (!version) throw notFound('Версия прейскуранта не найдена');

    /*
     * Область видимости. `ADMIN` видит всю сеть; остальным доступны только
     * версии их магазинов. Общий прейскурант (`storeId: null`) доступен всем —
     * он и есть прейскурант сети.
     */
    if (version.storeId !== null && !actor.storeIds.includes(version.storeId)) {
      // Не 403, а 404: иначе по коду ответа перебором выяснялось бы, какие
      // магазины существуют и какие у них есть версии прейскуранта.
      throw notFound('Версия прейскуранта не найдена');
    }

    return version;
  }

  /** Правка разрешена только в редактируемых статусах (задача 1.4.3). */
  private assertEditable(status: PriceListStatusCode | PriceListStatus): void {
    if (isPriceListEditable(status)) return;
    throw new ConflictException({
      code: PRICE_LIST_EDIT_DENIED_CODE[status],
      message: PRICE_LIST_EDIT_DENIED_MESSAGE[status],
    });
  }

  /** Категория работ обязана существовать: иначе был бы нарушен внешний ключ. */
  private async requireCategory(id: string): Promise<void> {
    const category = await this.prisma.workCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!category) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Категория работ не найдена',
        details: { categoryId: ['Категория работ не найдена'] },
      });
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
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

function parseOrThrow<Output, Input = unknown>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.flatten().fieldErrors);
  return parsed.data;
}

function translateDuplicate(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException({ code: 'CODE_TAKEN', message });
  }
  return error;
}
