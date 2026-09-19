/**
 * Реестр рекламаций (этап 6, ТЗ п. 2.9).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Рекламация — это обращение клиента по гарантии, у которого
 * есть срок рассмотрения 10 рабочих дней. Без реестра такие обращения живут в
 * памяти приёмщика и в переписке: срок истекает незаметно, а доказать, что
 * случай разбирали, нечем. Реестр делает три вещи, которых иначе не сделать:
 * считает срок, хранит решение с обоснованием и связывает рекламацию с заказом,
 * в котором она возникла.
 *
 * ПОЧЕМУ РЕКЛАМАЦИЯ НЕ ОТДЕЛЬНЫЙ ЗАКАЗ. ТЗ п. 2.9 требует «запись в основном
 * заказе»: клиент приходит с изделием, по которому уже есть заказ, и заводить
 * второй заказ значило бы разорвать историю — гарантийный случай оказался бы
 * не связан с работой, из-за которой возник. Поэтому рекламация ссылается на
 * заказ (`orderId`) и пишется в его историю статусов (задача 6.5).
 *
 * ПОЧЕМУ СРОК СЧИТАЕТ СЕРВЕР, А НЕ КЛИЕНТ. Дата `dueAt` сохраняется в базе при
 * открытии. Если бы её считал интерфейс, то срок зависел бы от часов машины
 * сотрудника, а при смене календаря (новый праздник) задним числом уже
 * открытые рекламации остались бы с прежним сроком — и это правильно: срок
 * обязательства не должен пересчитываться после того, как клиенту его назвали.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReportsCacheService } from '../../common/cache/reports-cache.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import {
  CLAIM_STATUS,
  CLAIM_RESOLUTION_LABELS,
  CLAIM_REVIEW_WORKING_DAYS,
  CLAIM_STATUS_LABELS,
  CLAIM_TRANSITION_DENIED,
  ORDER_STATUS,
  REPORT_NAME,
  buildClaimNo,
  canTransitionClaim,
  claimTransitionDenial,
  claimWorkingDaysLeft,
  computeClaimDueAt,
  isClaimOverdue,
  isClaimResolved,
  isClaimTerminal,
  needsClaimWarning,
  openClaimSchema,
  transitionClaimSchema,
  workingDaysBetween,
  type ClaimStatus,
} from '@app/shared';

/** Строка реестра: то, что нужно списку, без тяжёлых связей. */
export interface ClaimListItem {
  id: string;
  claimNo: string;
  orderId: string;
  orderNo: string;
  status: ClaimStatus;
  statusLabel: string;
  reason: string;
  openedAt: string;
  dueAt: string;
  /** Осталось рабочих дней; отрицательное значение — просрочка. */
  workingDaysLeft: number;
  isOverdue: boolean;
  /** Пора предупредить о сроке (задача 6.6). */
  needsWarning: boolean;
  reviewerId: string | null;
  reviewerName: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Можно ли ещё изменить: терминальные статусы не переоткрываются. */
  isTerminal: boolean;
}

/** Карточка рекламации: строка реестра плюс подробности разбора. */
export interface ClaimDetail extends ClaimListItem {
  clientStatement: string | null;
  /** Исход рекламации: `RESOLVED_REPAIR` / `RESOLVED_REFUND` либо `null`. */
  resolution: string | null;
  /** Читаемая формулировка исхода — для карточки. */
  resolutionLabel: string | null;
  rejectionReason: string | null;
  isWarrantyCase: boolean;
  order: {
    id: string;
    orderNo: string;
    status: string;
    totalAmountMinor: number;
    isWarranty: boolean;
    warrantyUntil: string | null;
    customerName: string;
    customerPhone: string;
  };
  /** Допустимые следующие статусы — считает домен, а не интерфейс. */
  availableTransitions: ClaimStatus[];
}

/** Фильтры реестра. */
export interface ClaimFilters {
  /** Статус строкой: значение проверяется на допустимость в `list`. */
  status?: string;
  /** Только просроченные: срок истёк, решения нет. */
  overdueOnly?: boolean;
  orderId?: string;
}

/** Итог открытия рекламации. */
export interface OpenClaimResult {
  claim: ClaimDetail;
}

/**
 * Выборка строки реестра.
 *
 * `claimNo` и `orderNo` нужны списку, а `customer` — карточке: приёмщик ищет
 * рекламацию по номеру заказа или по фамилии клиента, а не по внутреннему `id`.
 */
const CLAIM_SELECT = Prisma.validator<Prisma.WarrantyClaimSelect>()({
  id: true,
  claimNo: true,
  orderId: true,
  status: true,
  reason: true,
  clientStatement: true,
  openedAt: true,
  dueAt: true,
  reviewerId: true,
  resolution: true,
  rejectionReason: true,
  resolvedAt: true,
  closedAt: true,
  isWarrantyCase: true,
  order: {
    select: {
      id: true,
      orderNo: true,
      status: true,
      totalAmountMinor: true,
      isWarranty: true,
      warrantyUntil: true,
      customer: { select: { fullName: true, phone: true } },
    },
  },
  reviewer: { select: { id: true, fullName: true } },
});

type ClaimRow = Prisma.WarrantyClaimGetPayload<{ select: typeof CLAIM_SELECT }>;

@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: OrderWorkflowService,
    private readonly cache: ReportsCacheService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Срок рассмотрения в рабочих днях.
   *
   * Читается из настройки `CLAIM_REVIEW_WORKDAYS`, а не берётся константой:
   * настройка объявлена с самого начала, но до этапа 6 не читалась нигде, и
   * изменение её значения ничего не меняло — тот же класс дефекта, что у флагов
   * каналов уведомлений (docs/15 «Дефект 41»). Значение по умолчанию совпадает
   * с константой домена, поэтому поведение без настройки прежнее.
   */
  private reviewWorkingDays(): number {
    const value = this.config.get<number>('CLAIM_REVIEW_WORKDAYS');
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : CLAIM_REVIEW_WORKING_DAYS;
  }

  /**
   * Открыть рекламацию по заказу.
   *
   * ПОЧЕМУ НОМЕР БЕРЁТСЯ ИЗ СЧЁТЧИКА, А НЕ ИЗ ЧИСЛА СТРОК. Счётчик в базе
   * (`Counter`) не повторяет номер после удаления рекламации: если считать
   * «сколько уже есть плюс один», удаление одной записи привело бы к повторному
   * номеру, а номер рекламации попадает в бумажный акт и называется клиенту.
   */
  async open(body: unknown, actor: AuthenticatedUser): Promise<ClaimDetail> {
    const parsed = openClaimSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const input = parsed.data;
    const reason = input.reason;

    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, orderNo: true, status: true, warrantyUntil: true },
    });
    if (order === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    /*
     * Рекламация по незавершённому заказу не имеет смысла: гарантия отсчитывается
     * от выдачи, а пока заказ в работе, речь идёт о переделке, а не о
     * гарантийном случае. Отклоняем явно, чтобы приёмщик не завёл рекламацию по
     * ошибке и не исказил статистику.
     */
    if (!isClaimableOrderStatus(order.status)) {
      throw new ConflictException({
        code: 'CLAIM_ORDER_NOT_COMPLETED',
        message: 'Рекламацию можно открыть только по выданному заказу',
      });
    }

    const calendar = await this.workflow.loadCalendar();
    const now = new Date();
    const dueAt = computeClaimDueAt(now, calendar, this.reviewWorkingDays());

    const created = await this.prisma.$transaction(async (tx) => {
      const counter = await tx.counter.upsert({
        where: { scope: `CLAIM:${now.getUTCFullYear()}` },
        create: { scope: `CLAIM:${now.getUTCFullYear()}`, value: 1 },
        update: { value: { increment: 1 } },
      });

      const claim = await tx.warrantyClaim.create({
        data: {
          claimNo: buildClaimNo(now, counter.value),
          orderId: order.id,
          status: CLAIM_STATUS.OPENED,
          reason,
          clientStatement: input.clientStatement ?? null,
          openedAt: now,
          dueAt,
          isWarrantyCase: true,
        },
        select: CLAIM_SELECT,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'CREATE',
          entity: 'WarrantyClaim',
          entityId: claim.id,
          after: {
            claimNo: claim.claimNo,
            orderNo: order.orderNo,
            reason,
            dueAt: dueAt.toISOString(),
          },
        },
      });

      return claim;
    });

    /*
     * Отчёт по рекламациям показывает открытые обращения и просрочку, поэтому
     * новая рекламация меняет его цифры. Без сброса отчёт отдавал бы старую
     * картину до истечения TTL (15 минут), и руководитель не понял бы, почему
     * только что заведённого обращения в отчёте нет.
     */
    this.cache.invalidate([REPORT_NAME.CLAIMS]);

    return this.toDetail(created, calendar, now);
  }

  /**
   * Реестр рекламаций.
   *
   * Сортировка — по сроку, а не по дате открытия: список читают, чтобы понять,
   * что делать сегодня, и ближайший срок важнее самой старой записи.
   */
  async list(filters: ClaimFilters = {}): Promise<ClaimListItem[]> {
    const where: Prisma.WarrantyClaimWhereInput = {};
    if (filters.status !== undefined) {
      /*
       * Статус приходит строкой из query-параметра. Неизвестное значение — это
       * ошибка запроса, а не «показать всё»: молча проигнорированный фильтр
       * выглядел бы как «рекламаций в этом статусе нет», и его искали бы в
       * другом месте.
       */
      if (!isClaimStatus(filters.status)) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Неизвестный статус рекламации',
          details: { status: [`Недопустимый статус: ${filters.status}`] },
        });
      }
      where.status = filters.status;
    }
    if (filters.orderId !== undefined) where.orderId = filters.orderId;

    const rows = await this.prisma.warrantyClaim.findMany({
      where,
      select: CLAIM_SELECT,
      orderBy: [{ dueAt: 'asc' }],
    });

    const calendar = await this.workflow.loadCalendar();
    const now = new Date();

    const items = rows.map((row) => this.toListItem(row, calendar, now));

    /*
     * Фильтр «только просроченные» применяется здесь, а не в запросе: просрочка
     * зависит от текущего момента, а не только от `dueAt`. Терминальные статусы
     * просроченными не считаются (домен), и в SQL это пришлось бы повторять —
     * то есть дублировать правило, которое уже описано в домене.
     */
    return filters.overdueOnly === true ? items.filter((item) => item.isOverdue) : items;
  }

  /** Карточка рекламации. */
  async get(id: string): Promise<ClaimDetail> {
    const row = await this.prisma.warrantyClaim.findUnique({
      where: { id },
      select: CLAIM_SELECT,
    });
    if (row === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Рекламация не найдена' });
    }

    const calendar = await this.workflow.loadCalendar();
    return this.toDetail(row, calendar, new Date());
  }

  /**
   * Сменить статус рекламации.
   *
   * ПРАВИЛА ПЕРЕХОДА ЖИВУТ В ДОМЕНЕ (`@app/shared`), и это не формальность:
   * интерфейс показывает только допустимые кнопки, а сервер обязан отклонять
   * остальные. Если бы правило было только в интерфейсе, обход через прямой
   * запрос позволил бы закрыть рекламацию без решения или переоткрыть закрытую.
   */
  async transition(id: string, body: unknown, actor: AuthenticatedUser): Promise<ClaimDetail> {
    const parsed = transitionClaimSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const input = parsed.data;

    const current = await this.prisma.warrantyClaim.findUnique({
      where: { id },
      select: {
        id: true,
        claimNo: true,
        status: true,
        orderId: true,
        order: { select: { status: true } },
      },
    });
    if (current === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Рекламация не найдена' });
    }

    const denial = claimTransitionDenial(current.status, input.to, {
      rejectionReason: input.rejectionReason ?? null,
    });
    if (denial !== null) {
      throw this.denialToException(denial, current.status, input.to);
    }

    const now = new Date();
    const calendar = await this.workflow.loadCalendar();

    const updated = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.warrantyClaim.update({
        where: { id },
        data: {
          status: input.to,
          /*
           * Рассматривающий назначается при взятии в работу. Проверять «а не
           * назначен ли уже» не нужно: в `IN_REVIEW` ведёт ТОЛЬКО из `OPENED`
           * (см. `CLAIM_TRANSITIONS`), а `reviewerId` заполняется единственный
           * раз — на этом переходе. Лишнее условие здесь было бы недостижимо
           * ложным и создавало бы видимость защиты, которой нет.
           */
          ...(input.to === CLAIM_STATUS.IN_REVIEW ? { reviewerId: actor.id } : {}),
          ...(input.rejectionReason !== undefined && input.rejectionReason !== null
            ? { rejectionReason: input.rejectionReason.trim() }
            : {}),
          /*
           * Исход сохраняется В ТЕЛЕ записи (`resolution`), а не только в
           * статусе. Это не дублирование, а необходимость: закрытие переводит
           * рекламацию в `CLOSED` и стирает `RESOLVED_REFUND`, после чего отчёт
           * уже не смог бы ответить, сколько денег вернули клиентам. Дефект
           * найден на живом сервере: закрытая рекламация с возвратом давала
           * `resolvedRefundCount: 0`.
           */
          ...(isClaimResolved(input.to) ? { resolvedAt: now, resolution: input.to } : {}),
          ...(input.to === CLAIM_STATUS.CLOSED ? { closedAt: now } : {}),
        },
        select: CLAIM_SELECT,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'UPDATE',
          entity: 'WarrantyClaim',
          entityId: id,
          before: { status: current.status },
          after: {
            status: input.to,
            ...(input.rejectionReason == null ? {} : { rejectionReason: input.rejectionReason }),
          },
        },
      });

      /*
       * Запись в основной заказ (задача 6.5, ТЗ п. 2.9). Пишется в историю
       * статусов, а не в отдельную таблицу: приёмщик, открывший карточку
       * заказа, должен видеть рекламацию там же, где остальные события, — иначе
       * о ней узнают только из реестра рекламаций, куда заглядывают редко.
       *
       * Статус заказа НЕ меняется: рекламация — это отдельный процесс, и
       * перевод заказа в «в работе» из-за обращения по гарантии исказил бы и
       * сроки, и отчётность по производству.
       */
      await tx.orderStatusHistory.create({
        data: {
          orderId: current.orderId,
          toStatus: current.order.status,
          isSystem: false,
          changedById: actor.id,
          reason: `Рекламация ${current.claimNo}: ${CLAIM_STATUS_LABELS[input.to]}`,
        },
      });

      return claim;
    });

    /*
     * Переход меняет и статус, и просрочку, и исход — то есть все цифры отчёта
     * по рекламациям. Сброс идёт ПОСЛЕ успешного перехода: отклонённый переход
     * ничего не изменил, и сбрасывать кэш по нему значило бы заставлять
     * следующий запрос считать отчёт заново без причины.
     */
    this.cache.invalidate([REPORT_NAME.CLAIMS]);

    return this.toDetail(updated, calendar, now);
  }

  /**
   * Рекламации, по которым пора предупредить о сроке (задача 6.6).
   *
   * Отметка `warningSentAt` ставится ПОСЛЕ успешной рассылки вызывающим кодом:
   * если бы отметку ставил этот метод, сбой отправки оставил бы рекламацию без
   * предупреждения навсегда.
   */
  async findNeedingWarning(): Promise<
    { id: string; claimNo: string; dueAt: Date; orderId: string }[]
  > {
    const rows = await this.prisma.warrantyClaim.findMany({
      where: {
        status: { notIn: [CLAIM_STATUS.CLOSED, CLAIM_STATUS.REJECTED] },
        warningSentAt: null,
      },
      select: { id: true, claimNo: true, dueAt: true, orderId: true, status: true },
      orderBy: { dueAt: 'asc' },
    });

    const calendar = await this.workflow.loadCalendar();
    const now = new Date();

    return rows
      .filter((row) => needsClaimWarning(row.status, row.dueAt, calendar, now))
      .map((row) => ({ id: row.id, claimNo: row.claimNo, dueAt: row.dueAt, orderId: row.orderId }));
  }

  /** Отметить, что предупреждение о сроке отправлено. */
  async markWarningSent(id: string): Promise<void> {
    await this.prisma.warrantyClaim.update({
      where: { id },
      data: { warningSentAt: new Date() },
    });
  }

  /**
   * Сводка по рекламациям для отчёта (задача 6.7).
   *
   * Считается по статусам, а не по «открытым/закрытым»: руководителю нужно
   * видеть, сколько случаев ещё разбирается, сколько урегулировано ремонтом и
   * сколько возвратом денег — это разные по стоимости исходы.
   */
  async summary(
    from: Date,
    to: Date,
  ): Promise<{
    total: number;
    byStatus: Record<string, number>;
    overdue: number;
    resolvedRepair: number;
    resolvedRefund: number;
    rejected: number;
    averageReviewWorkingDays: number | null;
  }> {
    const rows = await this.prisma.warrantyClaim.findMany({
      where: { openedAt: { gte: from, lte: to } },
      select: { status: true, openedAt: true, dueAt: true, resolvedAt: true, closedAt: true },
    });

    const calendar = await this.workflow.loadCalendar();
    const now = new Date();

    const byStatus: Record<string, number> = {};
    let overdue = 0;
    let reviewDaysSum = 0;
    let reviewDaysCount = 0;

    for (const row of rows) {
      const status = row.status;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (isClaimOverdue(status, row.dueAt, now)) overdue += 1;

      /*
       * Длительность разбора считается от открытия до решения. Берётся
       * `resolvedAt`, а не `closedAt`: закрытие может задержаться по причинам,
       * не связанным с рассмотрением (клиент не пришёл за изделием), и тогда
       * показатель говорил бы о дисциплине клиента, а не сотрудников.
       */
      const decidedAt = row.resolvedAt;
      if (decidedAt !== null) {
        reviewDaysSum += workingDaysBetween(row.openedAt, decidedAt, calendar);
        reviewDaysCount += 1;
      }
    }

    return {
      total: rows.length,
      byStatus,
      overdue,
      resolvedRepair: byStatus[CLAIM_STATUS.RESOLVED_REPAIR] ?? 0,
      resolvedRefund: byStatus[CLAIM_STATUS.RESOLVED_REFUND] ?? 0,
      rejected: byStatus[CLAIM_STATUS.REJECTED] ?? 0,
      averageReviewWorkingDays:
        reviewDaysCount === 0 ? null : Math.round((reviewDaysSum / reviewDaysCount) * 10) / 10,
    };
  }

  /** Преобразовать отказ домена в исключение с понятным кодом. */
  private denialToException(
    denial: string,
    from: ClaimStatus,
    to: ClaimStatus,
  ): BadRequestException | ConflictException {
    if (denial === CLAIM_TRANSITION_DENIED.TERMINAL) {
      return new ConflictException({
        code: denial,
        message: `Рекламация в статусе «${CLAIM_STATUS_LABELS[from]}» больше не изменяется`,
      });
    }
    if (denial === CLAIM_TRANSITION_DENIED.NO_REASON) {
      return new BadRequestException({
        code: denial,
        message: 'Укажите причину отказа',
      });
    }
    return new ConflictException({
      code: denial,
      message: `Нельзя перевести рекламацию из «${CLAIM_STATUS_LABELS[from]}» в «${CLAIM_STATUS_LABELS[to]}»`,
    });
  }

  /** Строка реестра из записи базы. */
  private toListItem(
    row: ClaimRow,
    calendar: Awaited<ReturnType<OrderWorkflowService['loadCalendar']>>,
    now: Date,
  ): ClaimListItem {
    const status = row.status;
    return {
      id: row.id,
      claimNo: row.claimNo,
      orderId: row.orderId,
      orderNo: row.order.orderNo,
      status,
      statusLabel: CLAIM_STATUS_LABELS[status] ?? status,
      reason: row.reason,
      openedAt: row.openedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      workingDaysLeft: claimWorkingDaysLeft(row.dueAt, calendar, now),
      isOverdue: isClaimOverdue(status, row.dueAt, now),
      needsWarning: needsClaimWarning(status, row.dueAt, calendar, now),
      reviewerId: row.reviewerId,
      reviewerName: row.reviewer?.fullName ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      isTerminal: isClaimTerminal(status),
    };
  }

  /** Карточка из записи базы. */
  private toDetail(
    row: ClaimRow,
    calendar: Awaited<ReturnType<OrderWorkflowService['loadCalendar']>>,
    now: Date,
  ): ClaimDetail {
    const status = row.status;
    return {
      ...this.toListItem(row, calendar, now),
      clientStatement: row.clientStatement,
      resolution: row.resolution,
      resolutionLabel:
        row.resolution === null
          ? null
          : (CLAIM_RESOLUTION_LABELS[row.resolution] ?? row.resolution),
      rejectionReason: row.rejectionReason,
      isWarrantyCase: row.isWarrantyCase,
      order: {
        id: row.order.id,
        orderNo: row.order.orderNo,
        status: row.order.status,
        totalAmountMinor: row.order.totalAmountMinor,
        isWarranty: row.order.isWarranty,
        warrantyUntil: row.order.warrantyUntil?.toISOString() ?? null,
        customerName: row.order.customer.fullName,
        customerPhone: row.order.customer.phone,
      },
      // Домен отдаёт допустимые переходы — интерфейс рисует по ним кнопки.
      availableTransitions: [...availableClaimTransitions(status)],
    };
  }
}

/**
 * Допустимый ли статус рекламации.
 *
 * Проверка нужна, потому что реестр читает статус из query-параметра, то есть из
 * недоверенного ввода. Значения берутся из `CLAIM_STATUS_LABELS`: это тот же
 * словарь, по которому строится вывод, поэтому новый статус нельзя добавить в
 * домен, забыв про фильтр.
 */
function isClaimStatus(value: string): value is ClaimStatus {
  return Object.prototype.hasOwnProperty.call(CLAIM_STATUS_LABELS, value);
}

/**
 * Допустимые следующие статусы.
 *
 * Обёртка нужна, чтобы интерфейс не зависел от формы `CLAIM_TRANSITIONS`
 * (объект-словарь) и получал готовый массив.
 */
function availableClaimTransitions(status: ClaimStatus): readonly ClaimStatus[] {
  const candidates: ClaimStatus[] = [
    CLAIM_STATUS.IN_REVIEW,
    CLAIM_STATUS.APPROVED,
    CLAIM_STATUS.REJECTED,
    CLAIM_STATUS.RESOLVED_REPAIR,
    CLAIM_STATUS.RESOLVED_REFUND,
    CLAIM_STATUS.CLOSED,
  ];
  return candidates.filter((candidate) => canTransitionClaim(status, candidate));
}

/**
 * Можно ли открыть рекламацию по заказу в этом статусе.
 *
 * Только по выданному (`COMPLETED`) или невостребованному (`UNCLAIMED`) заказу:
 * гарантия отсчитывается от выдачи, а до неё речь идёт о переделке в рамках
 * текущей работы, а не о гарантийном случае.
 */
function isClaimableOrderStatus(status: string): boolean {
  return status === ORDER_STATUS.COMPLETED || status === ORDER_STATUS.UNCLAIMED;
}
