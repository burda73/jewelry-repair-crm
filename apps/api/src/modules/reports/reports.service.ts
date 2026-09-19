/**
 * Отчёты (задача 5.1, ТЗ п. 2.11, docs/06).
 *
 * ЗАЧЕМ ЭТОТ МОДУЛЬ. Отчёты отвечают на вопросы, которые нельзя решить, глядя на
 * список заказов: где мы теряем время, справляется ли цех, кто систематически
 * нарушает сроки, сколько заработали. Список показывает состояние СЕЙЧАС; отчёт —
 * закономерность за период, и по ней принимают решения (нанимать ювелира,
 * разбираться с точкой).
 *
 * ПОЧЕМУ ВСЕ ОТЧЁТЫ В ОДНОМ СЕРВИСЕ. У них общая механика: период, область
 * видимости роли, разрезы, единый формат ответа. Вынести каждый в свой сервис
 * значило бы четыре раза повторить проверку прав и границ периода — и один из
 * четырёх однажды забыл бы её, показав приёмщику чужие данные.
 *
 * ПОЧЕМУ АГРЕГАЦИЯ ЧАСТЬЮ В ПАМЯТИ. Период отчёта ограничен (`MAX_PERIOD_DAYS`),
 * а область видимости сужает выборку до магазинов роли. Агрегаты по уже
 * отобранным строкам считаются теми же функциями, что покрыты тестами
 * (`percentile`, `inNormShare`), — расчёт в SQL дал бы вторую реализацию
 * перцентиля, которая разошлась бы с проверенной.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  REPORT_COLUMN_TYPE,
  REPORT_NAME,
  REPORT_GROUP_BY,
  average,
  inNormShare,
  percentile,
  round,
  type ReportColumn,
  type ReportColumnType,
  type ReportGroupBy,
  type ReportName,
  type ReportResult,
  type ReportRow,
  type OrderStatus,
  type DataScope,
  CLAIM_STATUS,
  CLAIM_STATUS_LABELS,
  isClaimOverdue,
  isClaimTerminal,
  workingDaysBetween,
  type ClaimStatus,
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ReportsCacheService,
  reportCacheKey,
  ttlForReport,
} from '../../common/cache/reports-cache.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/** Просроченный заказ в отчёте: поля, нужные для расчёта строки. */
interface OverdueOrderRow {
  orderNo: string;
  status: string;
  dueAt: Date | null;
  totalAmountMinor: number;
  createdStoreId: string;
  createdStore?: { name: string } | null;
}

/** Длина периода по умолчанию: текущий месяц. */
const DEFAULT_PERIOD_DAYS = 30;

/**
 * Предельная длина периода.
 *
 * Годовой срез считается, но «с 2015 года по сегодня» — это уже выгрузка всей
 * базы, которая займёт базу на минуты. Порог честнее показать ошибкой, чем
 * выполнять запрос, замедляющий работу приёмщиков.
 */
const MAX_PERIOD_DAYS = 800;

/** Сколько строк отчёта отдавать по умолчанию. */
const DEFAULT_LIMIT = 500;

/** Отчёт так, как он приходит в сервис после разбора параметров. */
export interface ReportQuery {
  from: Date;
  to: Date;
  storeIds: string[];
  workshopIds: string[];
  groupBy: ReportGroupBy | null;
  limit: number;
}

/** Колонки-помощники: одинаковые заголовки в разных отчётах выглядят одинаково. */
const COLUMN = {
  ordersCount: (title = 'Заказов'): ReportColumn => ({
    key: 'ordersCount',
    title,
    type: REPORT_COLUMN_TYPE.NUMBER,
  }),
  avgHours: (title = 'Среднее, ч'): ReportColumn => ({
    key: 'avgHours',
    title,
    type: REPORT_COLUMN_TYPE.DURATION,
  }),
  medianHours: (): ReportColumn => ({
    key: 'medianHours',
    title: 'Медиана, ч',
    type: REPORT_COLUMN_TYPE.DURATION,
  }),
  p90Hours: (): ReportColumn => ({
    key: 'p90Hours',
    title: '90-й перцентиль, ч',
    type: REPORT_COLUMN_TYPE.DURATION,
  }),
  inNormShare: (): ReportColumn => ({
    key: 'inNormShare',
    title: 'В норме, %',
    type: REPORT_COLUMN_TYPE.PERCENT,
  }),
  violations: (title = 'Нарушений'): ReportColumn => ({
    key: 'violations',
    title,
    type: REPORT_COLUMN_TYPE.NUMBER,
  }),
} as const;

/** Готовый отчёт вместе с отобранными строками — внутренний результат расчёта. */
interface ComputedReport {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, string | number | null>;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: OrderWorkflowService,
    private readonly cache: ReportsCacheService,
  ) {}

  /**
   * Построить отчёт по имени.
   *
   * Имя приходит из URL, поэтому проверяется по закрытому списку: произвольная
   * строка означала бы поиск «отчёта вообще», которого нет.
   */
  async build(name: string, query: ReportQuery, actor: AuthenticatedUser): Promise<ReportResult> {
    const generatedAt = new Date().toISOString();

    /*
     * Область видимости накладывается здесь, а не в контроллере: если бы её
     * применял контроллер, каждый новый отчёт нужно было бы не забыть обернуть
     * — и однажды забыли бы. Здесь же мимо неё не пройти.
     */
    const scoped: ReportQuery = {
      ...query,
      storeIds: scopedStoreIds(actor, query.storeIds),
      workshopIds:
        actor.scope === 'PRODUCTION' && query.workshopIds.length === 0 ? [] : query.workshopIds,
    };

    /*
     * Ключ строится ПОСЛЕ наложения области видимости и включает её: разные роли
     * не могут попасть в одну запись. Ключ по одним лишь параметрам запроса
     * означал бы, что приёмщик получит из кэша отчёт по всей сети.
     */
    const key = reportCacheKey(name, scoped);

    const cached = this.cache.get(key);
    if (cached !== null) {
      /*
       * `generatedAt` остаётся моментом ПОСТРОЕНИЯ отчёта, а не моментом выдачи:
       * иначе по нему нельзя было бы понять, насколько данные свежи, и «отчёт
       * построен только что» вводило бы в заблуждение. Признак `cached`
       * показывает, что ответ взят из кэша.
       */
      return { ...cached, meta: { ...cached.meta, cached: true } };
    }

    const computed = await this.compute(name, scoped);
    const result: ReportResult = {
      meta: {
        from: toDateKey(query.from),
        to: toDateKey(query.to),
        generatedAt,
        cached: false,
        rowCount: computed.rows.length,
      },
      columns: computed.columns,
      rows: computed.rows,
      totals: computed.totals,
    };

    const periodDays = (query.to.getTime() - query.from.getTime()) / 86_400_000;
    this.cache.set(key, result, ttlForReport(name, periodDays));
    return result;
  }

  /**
   * Сбросить кэш отчётов.
   *
   * Вызывается при изменении данных: переход статуса меняет и просрочки, и
   * сроки, и загрузку цеха, поэтому сбрасывается всё. Без сброса руководитель
   * видел бы старую картину до истечения TTL и не понял бы, почему только что
   * переведённый заказ в отчёте не появился.
   */
  invalidateCache(): number {
    return this.cache.invalidate();
  }

  private async compute(name: string, query: ReportQuery): Promise<ComputedReport> {
    switch (name) {
      case REPORT_NAME.STAGE_DURATIONS:
        return this.stageDurations(query);
      case REPORT_NAME.WORKSHOP_LOAD:
        return this.workshopLoad(query);
      case REPORT_NAME.OVERDUE:
        return this.overdue(query);
      case REPORT_NAME.REVENUE:
        return this.revenue(query);
      case REPORT_NAME.PREPAYMENTS:
        return this.prepayments(query);
      case REPORT_NAME.CLAIMS:
        return this.claims(query);
      default:
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `Отчёт «${name}» не поддерживается`,
          details: { supported: Object.values(REPORT_NAME) },
        });
    }
  }

  // -------------------------------------------------------------------------
  // 6.7. Рекламации (ТЗ п. 2.9)
  // -------------------------------------------------------------------------

  /**
   * Отчёт по рекламациям: сколько обращений, как быстро их разбирают и какие
   * исходы.
   *
   * ПОЧЕМУ ГРУППИРОВКА ПО СТАТУСУ, А НЕ ПО МЕСЯЦАМ ПО УМОЛЧАНИЮ. Главный вопрос
   * руководителя — «что сейчас висит и не просрочено ли», а не «сколько было в
   * марте». Разрез по периодам доступен через `groupBy` и строится по дате
   * открытия, но по умолчанию отчёт отвечает на текущее состояние.
   *
   * ПОЧЕМУ ПРОСРОЧКА СЧИТАЕТСЯ НА МОМЕНТ ПОСТРОЕНИЯ, А НЕ ПО ДАТЕ ВЫГРУЗКИ.
   * Просрочка — это состояние незавершённой рекламации относительно «сейчас».
   * Если считать её по дате открытия периода, отчёт за прошлый месяц показывал
   * бы просроченными рекламации, которые давно закрыты.
   */
  private async claims(query: ReportQuery): Promise<ComputedReport> {
    const rows = await this.prisma.warrantyClaim.findMany({
      where: { openedAt: { gte: query.from, lte: endOfPeriod(query.to) } },
      select: {
        status: true,
        reason: true,
        openedAt: true,
        dueAt: true,
        resolvedAt: true,
        closedAt: true,
        resolution: true,
        order: { select: { orderNo: true, isWarranty: true } },
      },
      orderBy: { openedAt: 'desc' },
      take: 20_000,
    });

    const calendar = await this.workflow.loadCalendar();
    const now = new Date();

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.status;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    /*
     * Порядок статусов задан явно, а не алфавитом: список читают сверху вниз как
     * жизненный цикл обращения (открыта → в работе → одобрена → урегулирована →
     * закрыта), и алфавитный порядок перемешал бы его.
     */
    const statusOrder: string[] = [
      CLAIM_STATUS.OPENED,
      CLAIM_STATUS.IN_REVIEW,
      CLAIM_STATUS.APPROVED,
      CLAIM_STATUS.RESOLVED_REPAIR,
      CLAIM_STATUS.RESOLVED_REFUND,
      CLAIM_STATUS.REJECTED,
      CLAIM_STATUS.CLOSED,
    ];

    const reportRows: ReportRow[] = statusOrder
      .filter((status) => groups.has(status))
      .map((status) => {
        const group = groups.get(status)!;
        const overdue = group.filter((row) => isClaimOverdue(row.status, row.dueAt, now)).length;

        const decided = group.filter((row) => row.resolvedAt !== null);
        /*
         * Средний разбор считается в РАБОЧИХ днях — той же мерой, что и срок 10
         * рабочих дней. Календарные дни в этом отчёте были бы несопоставимы со
         * сроком: «разобрали за 8 дней» и «уложились в 10 рабочих» выглядели бы
         * как одно и то же число при разном смысле.
         */
        const averageDays =
          decided.length === 0
            ? null
            : Math.round(
                (sum(
                  decided.map((row) => workingDaysBetween(row.openedAt, row.resolvedAt!, calendar)),
                ) /
                  decided.length) *
                  10,
              ) / 10;

        return {
          group: CLAIM_STATUS_LABELS[status as ClaimStatus] ?? status,
          claimsCount: group.length,
          overdueCount: overdue,
          averageReviewDays: averageDays,
        } satisfies ReportRow;
      });

    const overdueTotal = rows.filter((row) => isClaimOverdue(row.status, row.dueAt, now)).length;

    return {
      columns: [
        { key: 'group', title: 'Статус', type: REPORT_COLUMN_TYPE.STRING },
        { key: 'claimsCount', title: 'Рекламаций', type: REPORT_COLUMN_TYPE.NUMBER },
        { key: 'overdueCount', title: 'Просрочено', type: REPORT_COLUMN_TYPE.NUMBER },
        {
          key: 'averageReviewDays',
          title: 'Средний разбор, раб. дней',
          type: REPORT_COLUMN_TYPE.NUMBER,
        },
      ],
      rows: reportRows.slice(0, query.limit),
      totals: {
        claimsCount: rows.length,
        overdueCount: overdueTotal,
        /*
         * Исходы считаются по полю `resolution`, а НЕ по текущему статусу:
         * после закрытия статус становится `CLOSED`, и подсчёт по нему потерял
         * бы, чем закончилось дело. Дефект найден на живом сервере — закрытая
         * рекламация с возвратом давала `resolvedRefundCount: 0`.
         */
        resolvedRepairCount: rows.filter((row) => row.resolution === CLAIM_STATUS.RESOLVED_REPAIR)
          .length,
        resolvedRefundCount: rows.filter((row) => row.resolution === CLAIM_STATUS.RESOLVED_REFUND)
          .length,
        rejectedCount: rows.filter((row) => row.status === CLAIM_STATUS.REJECTED).length,
        openCount: rows.filter((row) => !isClaimTerminal(row.status)).length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 5.1. Сроки по этапам (docs/06 §1)
  // -------------------------------------------------------------------------

  /**
   * Сроки по этапам: где теряем время и укладываемся ли в нормативы.
   *
   * Источник — `OrderStatusHistory`: каждая строка несёт `durationMinutes`
   * (сколько заказ провёл в ПРЕДЫДУЩЕМ статусе) и `stage`. Поэтому строка
   * относится к этапу, ЗАВЕРШЁННОМУ переходом, а не к начатому: иначе
   * незавершённые этапы попадали бы в статистику с нулевой длительностью и
   * занижали среднее.
   */
  private async stageDurations(query: ReportQuery): Promise<ComputedReport> {
    const history = await this.prisma.orderStatusHistory.findMany({
      where: {
        createdAt: { gte: query.from, lte: endOfPeriod(query.to) },
        durationMinutes: { not: null },
        stage: { not: null },
        order: this.orderScope(query),
      },
      select: {
        stage: true,
        durationMinutes: true,
        order: { select: { createdStoreId: true, workshopId: true, complexity: true } },
      },
      take: 20_000,
    });

    const stageNormals = await this.stageNormHours();
    const storeNames = await this.storeNames();

    /*
     * Группировка по этапу или по этапу × магазин.
     *
     * Длительность и норматив хранятся ПАРОЙ, а не двумя массивами. Два массива
     * пришлось бы держать выровненными по индексу, и достаточно было бы одного
     * пропущенного норматива, чтобы все последующие значения сравнить с чужой
     * нормой — отчёт показал бы нарушения там, где их нет, и наоборот. Здесь
     * связь значения и нормы выражена типом и не может разъехаться.
     */
    const groups = new Map<
      string,
      { label: string; points: { durationHours: number; normHours: number | null }[] }
    >();
    for (const row of history) {
      const stage = row.stage as string;
      const minutes = row.durationMinutes as number;
      const storeId = row.order.createdStoreId;
      const key = query.groupBy === REPORT_GROUP_BY.STORE ? `${stage}::${storeId}` : stage;
      const label =
        query.groupBy === REPORT_GROUP_BY.STORE
          ? // Название магазина, а не идентификатор: в отчёте `cmu47z0xq…`
            // руководитель прочитать не может, и разрез по магазину терял бы смысл.
            `${stageLabel(stage)} · ${storeNames.get(storeId) ?? storeId}`
          : stageLabel(stage);

      const group = groups.get(key) ?? { label, points: [] };
      group.points.push({
        durationHours: minutes / 60,
        normHours: stageNormals.get(stage) ?? null,
      });
      groups.set(key, group);
    }

    const rows: ReportRow[] = [];
    let totalOrders = 0;
    let allValues: number[] = [];

    for (const [, group] of [...groups.entries()].sort((a, b) =>
      a[1].label.localeCompare(b[1].label, 'ru'),
    )) {
      const values = group.points.map((point) => point.durationHours);
      allValues = allValues.concat(values);
      /*
       * Нарушений нет у этапа без норматива: сравнивать не с чем. `null`, а не
       * ноль, — иначе «нарушений 0» читалось бы как «этап в норме», хотя
       * норматива для него просто не задано.
       */
      const violations = group.points.some((point) => point.normHours !== null)
        ? group.points.filter(
            (point) => point.normHours !== null && point.durationHours > point.normHours,
          ).length
        : null;

      rows.push({
        stage: group.label,
        ordersCount: values.length,
        avgHours: round(average(values)),
        medianHours: round(percentile(values, 0.5)),
        p90Hours: round(percentile(values, 0.9)),
        inNormShare: round(inNormShare(group.points), 4),
        violations: violations,
      });
      totalOrders += values.length;
    }

    return {
      columns: [
        { key: 'stage', title: 'Этап', type: REPORT_COLUMN_TYPE.STRING },
        COLUMN.ordersCount('Переходов'),
        COLUMN.avgHours(),
        COLUMN.medianHours(),
        COLUMN.p90Hours(),
        COLUMN.inNormShare(),
        COLUMN.violations(),
      ],
      rows: rows.slice(0, query.limit),
      totals: {
        transitions: totalOrders,
        avgHours: round(average(allValues)),
        medianHours: round(percentile(allValues, 0.5)),
        p90Hours: round(percentile(allValues, 0.9)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 5.2. Загрузка производства (docs/06 §2)
  // -------------------------------------------------------------------------

  /**
   * Загрузка производства: справляется ли цех.
   *
   * Три числа на исполнителя: сколько заказов в работе, плановая трудоёмкость и
   * фактическая. Плановая берётся из работ заказа (`OrderWork.durationHours`),
   * фактическая — из назначений (разница между началом и завершением).
   *
   * Расхождение плана и факта и есть ответ на вопрос «не пора ли нанимать»:
   * когда факт устойчиво выше плана, нормы труда не соответствуют реальности.
   */
  private async workshopLoad(query: ReportQuery): Promise<ComputedReport> {
    const performers = await this.prisma.performer.findMany({
      where: {
        isActive: true,
        ...(query.workshopIds.length > 0 ? { workshopId: { in: query.workshopIds } } : {}),
      },
      select: {
        id: true,
        fullName: true,
        specialization: true,
        workshop: { select: { name: true } },
      },
      orderBy: { fullName: 'asc' },
    });

    const assignments = await this.prisma.orderAssignment.findMany({
      where: {
        createdAt: { gte: query.from, lte: endOfPeriod(query.to) },
        performerId: { in: performers.map((performer) => performer.id) },
        order: this.orderScope(query),
      },
      select: {
        performerId: true,
        status: true,
        plannedHours: true,
        startedAt: true,
        finishedAt: true,
      },
      take: 20_000,
    });

    const byPerformer = new Map<
      string,
      { active: number; plannedHours: number; factHours: number; done: number }
    >();
    for (const assignment of assignments) {
      const entry = byPerformer.get(assignment.performerId) ?? {
        active: 0,
        plannedHours: 0,
        factHours: 0,
        done: 0,
      };
      if (assignment.status === 'IN_PROGRESS' || assignment.status === 'ASSIGNED') {
        entry.active += 1;
      }
      if (assignment.status === 'DONE') entry.done += 1;
      entry.plannedHours += assignment.plannedHours ?? 0;
      if (assignment.startedAt !== null && assignment.finishedAt !== null) {
        entry.factHours +=
          (assignment.finishedAt.getTime() - assignment.startedAt.getTime()) / 3_600_000;
      }
      byPerformer.set(assignment.performerId, entry);
    }

    /*
     * Очередь: заказы, ожидающие назначения в цех. Показывается общей строкой, а
     * не по исполнителю, — очередь ещё никому не назначена, и разносить её по
     * людям было бы вымыслом.
     */
    const queue = await this.prisma.order.count({
      where: {
        ...this.orderScope(query),
        status: { in: ['QUEUED_FOR_DISPATCH', 'IN_TRANSIT_TO_PRODUCTION'] },
      },
    });

    const rows: ReportRow[] = performers.map((performer) => {
      const entry = byPerformer.get(performer.id) ?? {
        active: 0,
        plannedHours: 0,
        factHours: 0,
        done: 0,
      };
      return {
        performer: performer.fullName,
        workshop: performer.workshop?.name ?? null,
        specialization: performer.specialization,
        ordersInWork: entry.active,
        plannedHours: round(entry.plannedHours),
        factHours: round(entry.factHours),
        completed: entry.done,
        // Отклонение факта от плана: положительное — работа дороже плана.
        deviationHours: round(entry.factHours - entry.plannedHours),
      };
    });

    const busy = rows.filter((row) => (row.ordersInWork as number) > 0);
    return {
      columns: [
        { key: 'performer', title: 'Исполнитель', type: REPORT_COLUMN_TYPE.STRING },
        { key: 'workshop', title: 'Цех', type: REPORT_COLUMN_TYPE.STRING },
        { key: 'specialization', title: 'Специализация', type: REPORT_COLUMN_TYPE.STRING },
        {
          key: 'ordersInWork',
          title: 'В работе',
          type: REPORT_COLUMN_TYPE.NUMBER,
        },
        { key: 'plannedHours', title: 'План, ч', type: REPORT_COLUMN_TYPE.DURATION },
        { key: 'factHours', title: 'Факт, ч', type: REPORT_COLUMN_TYPE.DURATION },
        { key: 'deviationHours', title: 'Отклонение, ч', type: REPORT_COLUMN_TYPE.DURATION },
        { key: 'completed', title: 'Завершено', type: REPORT_COLUMN_TYPE.NUMBER },
      ],
      rows: rows.slice(0, query.limit),
      totals: {
        performers: rows.length,
        performersBusy: busy.length,
        queue,
        plannedHours: round(rows.reduce((sum, row) => sum + (row.plannedHours as number), 0)),
        factHours: round(rows.reduce((sum, row) => sum + (row.factHours as number), 0)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 5.3. Просрочки (docs/06 §3)
  // -------------------------------------------------------------------------

  /**
   * Просрочки: кто и где систематически нарушает сроки.
   *
   * «Просрочено сейчас» и «просрочено за период» — разные числа, и оба нужны.
   * Первое показывает текущее состояние, второе — накопленную статистику: заказ,
   * просроченный и уже выданный, в текущем состоянии не виден, но в оценке
   * работы точки он остаётся.
   *
   * Разрез по этапу — по `status` заказа: именно там срок был нарушен.
   */
  private async overdue(query: ReportQuery): Promise<ComputedReport> {
    const now = new Date();
    const scope = this.orderScope(query);

    const overdueNow = await this.prisma.order.findMany({
      where: {
        ...scope,
        dueAt: { not: null, lt: now },
        status: { notIn: TERMINAL_STATUSES },
      },
      select: {
        id: true,
        orderNo: true,
        status: true,
        dueAt: true,
        totalAmountMinor: true,
        createdStoreId: true,
        createdStore: { select: { name: true } },
        productionManager: { select: { fullName: true } },
      },
      take: 20_000,
    });

    /*
     * «Просрочено за период»: заказы, у которых срок наступил в периоде и
     * которые на момент проверки его нарушили. Терминальные статусы здесь НЕ
     * исключаются: выданный с опозданием заказ — тоже нарушение сроков, и
     * исключить его значило бы улучшить статистику точки задним числом.
     */
    const overdueInPeriod = await this.prisma.order.findMany({
      where: {
        ...scope,
        dueAt: { gte: query.from, lte: query.to },
        status: { notIn: [ORDER_DRAFT, ORDER_CANCELLED] },
      },
      select: { id: true, dueAt: true, createdStoreId: true, status: true },
      take: 20_000,
    });

    const groups = new Map<string, { label: string; rows: OverdueOrderRow[] }>();
    for (const order of overdueNow) {
      const key = query.groupBy === REPORT_GROUP_BY.STAGE ? order.status : order.createdStoreId;
      const label =
        query.groupBy === REPORT_GROUP_BY.STAGE
          ? statusLabel(order.status)
          : (order.createdStore?.name ?? order.createdStoreId);
      const existing = groups.get(key) ?? { label, rows: [] };
      existing.rows.push(order);
      groups.set(key, existing);
    }

    const rows: ReportRow[] = [...groups.entries()]
      .sort((a, b) => b[1].rows.length - a[1].rows.length)
      .map(([, group]) => {
        const delays = group.rows.map(
          (order) => (now.getTime() - (order.dueAt as Date).getTime()) / 3_600_000,
        );
        const amount = group.rows.reduce((sum, order) => sum + order.totalAmountMinor, 0);
        return {
          group: group.label,
          overdueNow: group.rows.length,
          avgDelayHours: round(average(delays)),
          maxDelayHours: round(delays.length === 0 ? null : Math.max(...delays)),
          amountMinor: amount,
          maxOverdueOrder:
            group.rows.reduce(
              (worst, order) =>
                worst === null || (order.dueAt as Date) < (worst.dueAt as Date) ? order : worst,
              null as OverdueOrderRow | null,
            )?.orderNo ?? null,
        } satisfies ReportRow;
      });

    const allDelays = overdueNow.map(
      (order) => (now.getTime() - (order.dueAt as Date).getTime()) / 3_600_000,
    );
    const periodTotal = overdueInPeriod.length;
    const periodOverdue = overdueInPeriod.filter(
      (order) => order.dueAt !== null && order.dueAt.getTime() < now.getTime(),
    ).length;

    return {
      columns: [
        {
          key: 'group',
          title: query.groupBy === REPORT_GROUP_BY.STAGE ? 'Этап' : 'Магазин',
          type: REPORT_COLUMN_TYPE.STRING,
        },
        { key: 'overdueNow', title: 'Просрочено сейчас', type: REPORT_COLUMN_TYPE.NUMBER },
        { key: 'avgDelayHours', title: 'Средняя просрочка, ч', type: REPORT_COLUMN_TYPE.DURATION },
        { key: 'maxDelayHours', title: 'Максимальная, ч', type: REPORT_COLUMN_TYPE.DURATION },
        { key: 'amountMinor', title: 'Сумма', type: REPORT_COLUMN_TYPE.MONEY },
        { key: 'maxOverdueOrder', title: 'Худший заказ', type: REPORT_COLUMN_TYPE.STRING },
      ],
      rows: rows.slice(0, query.limit),
      totals: {
        overdueNow: overdueNow.length,
        avgDelayHours: round(average(allDelays)),
        maxDelayHours: round(allDelays.length === 0 ? null : Math.max(...allDelays)),
        // Доля просроченных считается по периоду: «из всех заказов периода
        // столько-то были просрочены».
        overdueInPeriod: periodOverdue,
        ordersInPeriod: periodTotal,
        overdueShare: round(periodTotal === 0 ? null : periodOverdue / periodTotal, 4),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 5.4. Выручка (docs/06 §4)
  // -------------------------------------------------------------------------

  /**
   * Выручка: сколько заработали и на чём.
   *
   * ГЛАВНОЕ ПРАВИЛО — ВЫРУЧКА СЧИТАЕТСЯ ПО ДАТЕ ПЛАТЕЖА (`paidAt`), А НЕ ПО ДАТЕ
   * ЗАКАЗА. Заказ, оформленный в августе и оплаченный в сентябре, — это
   * сентябрьская выручка. Иначе отчёт не сойдётся с 1С, где доход признаётся по
   * документу оплаты, и расхождение будут искать в интеграции, а не в отчёте.
   *
   * Возвраты и сторно вычитаются: «выручка» без них была бы оборотом, а не
   * заработком. Показываются отдельными числами, потому что рост возвратов —
   * самостоятельный сигнал, который в свёрнутом виде не виден.
   */
  private async revenue(query: ReportQuery): Promise<ComputedReport> {
    const payments = await this.prisma.payment.findMany({
      where: {
        paidAt: { gte: query.from, lte: endOfPeriod(query.to) },
        /*
         * Только подтверждённые платежи. `PENDING` — это намерение, а не деньги:
         * включать его значило бы показать выручку, которой ещё нет, а `FAILED`
         * — выручку, которой не будет.
         */
        status: 'CONFIRMED',
        store: this.storeScopeFilter(query),
      },
      select: {
        kind: true,
        method: true,
        amountMinor: true,
        paidAt: true,
        orderId: true,
        storeId: true,
        store: { select: { name: true } },
        order: { select: { isWarranty: true, createdStoreId: true } },
      },
      take: 20_000,
    });

    const revenuePayments = payments.filter(
      (payment) => payment.kind !== 'REFUND' && payment.kind !== 'REVERSAL',
    );
    const refunds = payments.filter(
      (payment) => payment.kind === 'REFUND' || payment.kind === 'REVERSAL',
    );

    const gross = sum(revenuePayments.map((payment) => payment.amountMinor));
    const refunded = sum(refunds.map((payment) => payment.amountMinor));

    /*
     * Группировка выбирается разрезом. `day`/`week`/`month`/`year` — это
     * временные срезы, остальные — аналитические. Ключ группы хранит и метку, и
     * порядок сортировки: для периодов это дата, для магазинов — название.
     */
    const groups = new Map<string, { label: string; sort: string; payments: typeof payments }>();
    for (const payment of revenuePayments) {
      const { key, label, sort } = this.revenueGroup(payment, query);
      const group = groups.get(key) ?? { label, sort, payments: [] };
      group.payments.push(payment);
      groups.set(key, group);
    }

    const rows: ReportRow[] = [...groups.entries()]
      .sort((a, b) => a[1].sort.localeCompare(b[1].sort))
      .map(([, group]) => {
        const amount = sum(group.payments.map((payment) => payment.amountMinor));
        const orders = new Set(group.payments.map((payment) => payment.orderId)).size;
        return {
          group: group.label,
          revenueMinor: amount,
          paymentsCount: group.payments.length,
          ordersCount: orders,
          // Средний чек: выручка на ЧИСЛО ЗАКАЗОВ, а не на число платежей.
          // Заказ может быть оплачен двумя платежами (предоплата + доплата), и
          // деление на платежи занизило бы чек вдвое.
          avgCheckMinor: orders === 0 ? null : Math.round(amount / orders),
        } satisfies ReportRow;
      });

    const orderCount = new Set(revenuePayments.map((payment) => payment.orderId)).size;
    const byMethod = groupByMethod(revenuePayments);

    return {
      columns: [
        {
          key: 'group',
          title: revenueGroupTitle(query),
          type: REPORT_COLUMN_TYPE.STRING,
        },
        { key: 'revenueMinor', title: 'Выручка', type: REPORT_COLUMN_TYPE.MONEY },
        { key: 'paymentsCount', title: 'Платежей', type: REPORT_COLUMN_TYPE.NUMBER },
        { key: 'ordersCount', title: 'Заказов', type: REPORT_COLUMN_TYPE.NUMBER },
        { key: 'avgCheckMinor', title: 'Средний чек', type: REPORT_COLUMN_TYPE.MONEY },
      ],
      rows: rows.slice(0, query.limit),
      totals: {
        revenueMinor: gross,
        refundsMinor: refunded,
        // Чистая выручка: заработок, а не оборот.
        netRevenueMinor: gross - refunded,
        ordersCount: orderCount,
        paymentsCount: revenuePayments.length,
        avgCheckMinor: orderCount === 0 ? null : Math.round(gross / orderCount),
        /*
         * Структура оплат — плоскими ключами (`methodCashMinor` и т.д.), а не
         * вложенным объектом: итоги имеют тип «имя показателя → число или
         * текст», и вложенность сломала бы и интерфейс, и выгрузку, которые
         * обходят итоги одним циклом.
         */
        ...methodTotals(byMethod),
      },
    };
  }

  /** Разрез строки отчёта о выручке. */
  private revenueGroup(
    payment: {
      paidAt?: Date;
      method: string;
      storeId: string;
      store: { name: string } | null;
      order: { isWarranty: boolean } | null;
    },
    query: ReportQuery,
  ): { key: string; label: string; sort: string } {
    switch (query.groupBy) {
      case REPORT_GROUP_BY.DAY:
      case REPORT_GROUP_BY.WEEK:
      case REPORT_GROUP_BY.MONTH:
      case REPORT_GROUP_BY.YEAR: {
        const key = periodKey(payment.paidAt ?? new Date(), query.groupBy);
        return { key, label: key, sort: key };
      }
      case REPORT_GROUP_BY.PAYMENT_METHOD:
        return { key: payment.method, label: methodLabel(payment.method), sort: payment.method };
      case REPORT_GROUP_BY.STORE:
        return {
          key: payment.storeId,
          label: payment.store?.name ?? payment.storeId,
          sort: payment.store?.name ?? payment.storeId,
        };
      default:
        return { key: '__all__', label: 'Всего', sort: '0' };
    }
  }

  // -------------------------------------------------------------------------
  // 5.5. Предоплаты (docs/06 §5)
  // -------------------------------------------------------------------------

  /**
   * Предоплаты: сколько денег клиентов «в работе» и нет ли зависших заказов.
   *
   * Два самостоятельных вопроса, и оба в одном отчёте, потому что ответ на
   * второй без первого не читается:
   *
   *  1. СКОЛЬКО ВНЕСЕНО И ГДЕ. Разрез по МАГАЗИНУ ВНЕСЕНИЯ (`Payment.storeId`),
   *     а не по магазину заказа: клиент часто платит не там, где оформил заказ, и
   *     отчёт по магазину заказа показал бы деньги не той точке, у которой они в
   *     кассе.
   *  2. ЧТО ЗАВИСЛО. Предоплата внесена, а работы не начаты дольше норматива —
   *     потенциальная потеря клиента. Это отдельный список заказов, а не число:
   *     по числу нельзя позвонить клиенту.
   */
  private async prepayments(query: ReportQuery): Promise<ComputedReport> {
    const payments = await this.prisma.payment.findMany({
      where: {
        paidAt: { gte: query.from, lte: endOfPeriod(query.to) },
        status: 'CONFIRMED',
        kind: 'PREPAYMENT',
        store: this.storeScopeFilter(query),
      },
      select: {
        amountMinor: true,
        paidAt: true,
        orderId: true,
        storeId: true,
        store: { select: { name: true } },
        order: {
          select: {
            orderNo: true,
            status: true,
            productionStartedAt: true,
            totalAmountMinor: true,
          },
        },
      },
      take: 20_000,
    });

    const refunds = await this.prisma.payment.findMany({
      where: {
        paidAt: { gte: query.from, lte: endOfPeriod(query.to) },
        status: 'CONFIRMED',
        kind: { in: ['REFUND', 'REVERSAL'] },
        store: this.storeScopeFilter(query),
      },
      select: { amountMinor: true, orderId: true },
      take: 20_000,
    });

    const refundedByOrder = new Map<string, number>();
    for (const refund of refunds) {
      refundedByOrder.set(
        refund.orderId,
        (refundedByOrder.get(refund.orderId) ?? 0) + refund.amountMinor,
      );
    }

    const byStore = new Map<string, { label: string; amount: number; count: number }>();
    for (const payment of payments) {
      const entry = byStore.get(payment.storeId) ?? {
        label: payment.store?.name ?? payment.storeId,
        amount: 0,
        count: 0,
      };
      entry.amount += payment.amountMinor;
      entry.count += 1;
      byStore.set(payment.storeId, entry);
    }

    /*
     * «Зачтено» — предоплаты по заказам, дошедшим до `COMPLETED`: деньги
     * отработаны. «В работе» — всё остальное: изделие ещё в производстве или
     * ждёт клиента.
     */
    const credited = payments.filter((payment) => payment.order?.status === 'COMPLETED');
    const inWork = payments.filter((payment) => payment.order?.status !== 'COMPLETED');

    const now = Date.now();
    /*
     * Зависшие: предоплата внесена, работы не начаты дольше норматива. Считается
     * от момента ПЛАТЕЖА, а не от создания заказа: клиент мог внести предоплату
     * через неделю после оформления, и отсчёт «зависло» начинается с его денег.
     */
    const stuck = inWork
      .map((payment) => ({
        orderNo: payment.order?.orderNo ?? payment.orderId,
        status: payment.order?.status ?? 'UNKNOWN',
        amountMinor: payment.amountMinor,
        paidAt: payment.paidAt,
        stuckDays: Math.floor((now - payment.paidAt.getTime()) / 86_400_000),
        productionStartedAt: payment.order?.productionStartedAt ?? null,
      }))
      .filter(
        (entry) => entry.productionStartedAt === null && entry.stuckDays >= STUCK_PREPAYMENT_DAYS,
      )
      .sort((a, b) => b.stuckDays - a.stuckDays);

    const totalPrepaid = sum(payments.map((payment) => payment.amountMinor));
    const rows: ReportRow[] = [...byStore.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([, entry]) => ({
        store: entry.label,
        prepaidMinor: entry.amount,
        paymentsCount: entry.count,
        avgPrepaymentMinor: entry.count === 0 ? null : Math.round(entry.amount / entry.count),
      }));

    return {
      columns: [
        { key: 'store', title: 'Магазин внесения', type: REPORT_COLUMN_TYPE.STRING },
        { key: 'prepaidMinor', title: 'Внесено предоплат', type: REPORT_COLUMN_TYPE.MONEY },
        { key: 'paymentsCount', title: 'Платежей', type: REPORT_COLUMN_TYPE.NUMBER },
        { key: 'avgPrepaymentMinor', title: 'Средняя предоплата', type: REPORT_COLUMN_TYPE.MONEY },
      ],
      rows: rows.slice(0, query.limit),
      totals: {
        prepaidMinor: totalPrepaid,
        paymentsCount: payments.length,
        avgPrepaymentMinor:
          payments.length === 0 ? null : Math.round(totalPrepaid / payments.length),
        creditedMinor: sum(credited.map((payment) => payment.amountMinor)),
        inWorkMinor: sum(inWork.map((payment) => payment.amountMinor)),
        refundedMinor: sum(refunds.map((refund) => refund.amountMinor)),
        // Зависшие показываются числом и суммой; список заказов — отдельным
        // запросом (docs/07 §12.4), потому что по числу нельзя позвонить клиенту.
        stuckCount: stuck.length,
        stuckMinor: sum(stuck.map((entry) => entry.amountMinor)),
        stuckOrders: stuck
          .slice(0, 20)
          .map((entry) => entry.orderNo)
          .join(', '),
      },
    };
  }

  /**
   * Область видимости по магазину ВНЕСЕНИЯ платежа.
   *
   * Отдельно от `orderScope`: у платежа свой магазин (`Payment.storeId`), и
   * фильтровать его по магазину заказа значило бы показать приёмщику деньги,
   * принятые в другой кассе, и скрыть свои.
   */
  private storeScopeFilter(query: ReportQuery): Prisma.StoreWhereInput | undefined {
    if (query.storeIds.length === 0) return undefined;
    return { id: { in: query.storeIds } };
  }

  // -------------------------------------------------------------------------
  // Общее
  // -------------------------------------------------------------------------

  /**
   * Область видимости роли в виде условия по заказу.
   *
   * Тот же принцип, что в остальных модулях: приёмщик видит свой магазин,
   * руководитель — всю сеть. Отчёты не исключение: цифра, посчитанная по всей
   * сети и показанная приёмщику, — это утечка, даже если в ней нет фамилий.
   *
   * Пустой список означает «вся сеть». Так решает `scopedStoreIds`: для роли с
   * полным доступом он возвращает пустой массив намеренно, и трактовать это как
   * «магазинов нет» значило бы показать пустой отчёт руководителю.
   */
  private orderScope(query: ReportQuery): Prisma.OrderWhereInput {
    if (query.storeIds.length === 0) return {};
    return { createdStoreId: { in: query.storeIds } };
  }

  /**
   * Названия магазинов по идентификатору.
   *
   * Нужны для разреза по магазину: идентификатор `cmu47z0xq…` в отчёте
   * нечитаем, и разрез терял бы смысл. Один запрос на отчёт, а не запрос на
   * строку.
   */
  private async storeNames(): Promise<Map<string, string>> {
    const stores = await this.prisma.store.findMany({ select: { id: true, name: true } });
    return new Map(stores.map((store) => [store.id, store.name]));
  }

  /** Нормативы этапов в часах: нужны для «доли в норме». */
  private async stageNormHours(): Promise<Map<string, number>> {
    const calendar = await this.workflow.loadCalendar();
    const norms = await this.prisma.stageNorm.findMany({
      where: { isActive: true },
      select: { stage: true, unit: true, value: true },
    });

    /*
     * Норматив приводится к часам. Единицы разные (`WORKHOUR`, `WORKDAY`,
     * `CALENDAR_DAY`), и сравнивать сроки с нормативом можно только в одной
     * единице. Рабочий день берётся из календаря, а не как 8 или 9 часов:
     * значение настраивается, и жёсткая константа разошлась бы с расчётом
     * сроков в `OrderWorkflowService`.
     */
    const workdayHours = calendarWorkdayHours(calendar);
    const result = new Map<string, number>();
    for (const norm of norms) {
      if (norm.stage === null) continue;
      const hours =
        norm.unit === 'WORKHOUR'
          ? norm.value
          : norm.unit === 'WORKDAY'
            ? norm.value * workdayHours
            : norm.value * 24;
      // Первый норматив по этапу: справочник версионируется, и активная версия
      // даёт по одной записи на этап.
      if (!result.has(norm.stage)) result.set(norm.stage, hours);
    }
    return result;
  }
}

/**
 * Конец периода.
 *
 * Верхняя граница задаётся датой (`2025-09-30`), а данные хранятся моментами
 * времени. Без расширения до конца суток отчёт за 30 сентября не увидел бы
 * ничего, что случилось после полуночи, — то есть ровно за последний день
 * периода.
 */
function endOfPeriod(to: Date): Date {
  return new Date(to.getTime() + 86_400_000 - 1);
}

/** Терминальные статусы: заказ закрыт, просрочки «сейчас» по нему нет. */
const TERMINAL_STATUSES: OrderStatus[] = ['COMPLETED', 'REFUSED', 'CANCELLED', 'UNCLAIMED'];

const ORDER_DRAFT = 'DRAFT';
const ORDER_CANCELLED = 'CANCELLED';

/** Человекочитаемые названия этапов. */
const STAGE_LABELS: Record<string, string> = {
  APPROVAL: 'Согласование',
  PREPAYMENT: 'Предоплата',
  QUEUE: 'Очередь',
  LOGISTICS_OUT: 'Доставка в цех',
  PRODUCTION: 'Производство',
  LOGISTICS_IN: 'Доставка в магазин',
  PICKUP: 'Хранение до выдачи',
  CLAIM: 'Рекламация',
};

/** Названия статусов для разреза по этапу. */
const STATUS_LABELS: Record<string, string> = {
  AWAITING_APPROVAL: 'Согласование клиента',
  AWAITING_PREPAYMENT: 'Ожидание предоплаты',
  QUEUED_FOR_DISPATCH: 'Очередь на отправку',
  IN_TRANSIT_TO_PRODUCTION: 'Доставка в цех',
  IN_PRODUCTION: 'Производство',
  REWORK: 'Переделка',
  IN_TRANSIT_TO_STORE: 'Доставка в магазин',
  READY_FOR_PICKUP: 'Хранение до выдачи',
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Магазины, доступные роли, с учётом запрошенных.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. Это единственное место, где решается, какие данные
 * увидит пользователь. Ошибка здесь не выглядит как ошибка: отчёт построится,
 * числа будут правдоподобными — просто по чужой сети.
 *
 * ЗАПРОШЕННЫЕ МАГАЗИНЫ ПЕРЕСЕКАЮТСЯ С ДОСТУПНЫМИ, а не заменяют их. Параметр
 * `storeId` приходит из строки запроса, то есть от клиента: приняв его как есть,
 * приёмщик одного магазина получил бы отчёт по всей сети, добавив в адрес
 * `?storeId[]=чужой`. Пересечение оставляет только то, что роль видит и так.
 *
 * @returns список доступных магазинов; ПУСТОЙ список означает «вся сеть»
 */
export function scopedStoreIds(
  actor: { scope: DataScope; storeIds: string[] | undefined },
  requested: readonly string[],
): string[] {
  // Роли с полным доступом: руководитель, администратор, производство и аудит.
  const seesAll =
    actor.scope === 'ALL_STORES' || actor.scope === 'READ_ALL' || actor.scope === 'PRODUCTION';

  if (seesAll) {
    /*
     * Запрошенные магазины принимаются как сужение: руководитель вправе
     * посмотреть одну точку. Пустой список означает «вся сеть».
     */
    return [...requested];
  }

  const allowed = actor.storeIds ?? [];
  if (allowed.length === 0) {
    /*
     * Магазинов нет — данных нет. Возвращать всю сеть было бы утечкой: роль без
     * магазинов не должна видеть чужие заказы.
     */
    return RESTRICTED_TO_NOTHING;
  }

  if (requested.length === 0) return [...allowed];

  /*
   * Пересечение: видно только то, что разрешено И запрошено.
   *
   * ПУСТОЕ ПЕРЕСЕЧЕНИЕ ОБЯЗАНО ВЕРНУТЬ МАРКЕР, А НЕ ПУСТОЙ СПИСОК. Здесь легко
   * ошибиться, и ошибка не видна: пустой список в этом модуле означает «вся
   * сеть» (так устроен фильтр для руководителя). Вернув `[]`, мы отдали бы
   * приёмщику отчёт по всей сети — ровно наоборот задуманному. Дефект найден
   * тестом «чужой магазин в запросе не проходит в выборку».
   */
  const intersection = allowed.filter((storeId) => requested.includes(storeId));
  return intersection.length === 0 ? RESTRICTED_TO_NOTHING : intersection;
}

/**
 * Маркер «доступа нет».
 *
 * Отдельное значение, потому что пустой список означает «вся сеть». Без него
 * роль без магазинов получила бы отчёт по всей сети — то есть ограничение
 * превратилось бы в свою противоположность.
 */
export const RESTRICTED_TO_NOTHING: string[] = ['__no_access__'];

/**
 * Разобрать параметры отчёта.
 *
 * ЗАЧЕМ ЯВНЫЙ РАЗБОР, А НЕ `z.coerce.date()`. Границы периода задаются
 * МОСКОВСКИМИ сутками, а не UTC: при `z.coerce.date()` строка `2025-09-01`
 * превратилась бы в полночь UTC, и отчёт за сентябрь захватил бы часть
 * 31 августа по московскому времени — то есть числа не сошлись бы с отчётом
 * за август.
 *
 * Длина периода ограничена: годовой срез считается, а «с 2015 года» — это уже
 * выгрузка всей базы, которая займёт её на минуты. Порог честнее показать
 * ошибкой, чем выполнять запрос, замедляющий работу приёмщиков.
 */
export function parseReportPeriod(
  raw: { from?: string | undefined; to?: string | undefined },
  now: Date = new Date(),
): { from: Date; to: Date } {
  const to = raw.to === undefined ? now : moscowDayStart(raw.to);
  const from =
    raw.from === undefined
      ? new Date(to.getTime() - DEFAULT_PERIOD_DAYS * 86_400_000)
      : moscowDayStart(raw.from);

  if (from.getTime() > to.getTime()) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Начало периода позже его окончания',
      details: { from: raw.from ?? null, to: raw.to ?? null },
    });
  }

  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > MAX_PERIOD_DAYS) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: `Период отчёта не может превышать ${MAX_PERIOD_DAYS} дней`,
      details: { days: Math.round(days) },
    });
  }

  return { from, to };
}

/** Начало московских суток для даты `ГГГГ-ММ-ДД`. */
export function moscowDayStart(dateKey: string): Date {
  /*
   * Москва — UTC+3 без перехода на летнее время, поэтому смещение можно задать
   * константой. Момент строится как `${дата}T00:00:00+03:00`.
   */
  const parsed = new Date(`${dateKey}T00:00:00+03:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: `Некорректная дата: ${dateKey}`,
    });
  }
  return parsed;
}

/** Сумма чисел; пустой список — ноль. */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Срок, после которого не начатая работа считается зависшей (docs/06 §5). */
export const STUCK_PREPAYMENT_DAYS = 14;

/** Названия способов оплаты. */
const METHOD_LABELS: Record<string, string> = {
  CASH: 'Наличные',
  CARD: 'Карта',
  BANK_TRANSFER: 'Перевод',
  ONLINE: 'Онлайн',
};

function methodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method;
}

/**
 * Структура оплат: доля каждого способа.
 *
 * Показывается в итогах, а не строкой отчёта: вопрос «сколько наличных» задают
 * вместе с общей выручкой, и отдельный отчёт ради четырёх чисел не нужен.
 */
function groupByMethod(
  payments: readonly { method: string; amountMinor: number }[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const payment of payments) {
    result[payment.method] = (result[payment.method] ?? 0) + payment.amountMinor;
  }
  return result;
}

/**
 * Структура оплат плоскими ключами итогов.
 *
 * Ключи строятся по ВСЕМ способам оплаты, а не только по встретившимся: если
 * наличных в периоде не было, показатель должен быть нулём, а не отсутствовать.
 * Отсутствующий ключ интерфейс показал бы прочерком, и «нет данных» смешалось бы
 * с «ноль наличных».
 */
function methodTotals(byMethod: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const method of ['CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE']) {
    // Ключ в camelCase (`methodBankTransferMinor`), а не `methodBANK_TRANSFERMinor`:
    // ключ итогов читает интерфейс, и имя из перечисления в нём выглядело бы
    // случайным набором заглавных.
    result[`method${camel(method)}Minor`] = byMethod[method] ?? 0;
  }
  return result;
}

/** `BANK_TRANSFER` → `BankTransfer`. */
function camel(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Ключ периода для временного разреза выручки.
 *
 * Неделя начинается с понедельника: отчёт читают по рабочим неделям, и
 * воскресенье в начале недели сдвинуло бы границы относительно привычных.
 */
export function periodKey(date: Date, groupBy: string): string {
  const key = toDateKey(date);
  switch (groupBy) {
    case REPORT_GROUP_BY.YEAR:
      return key.slice(0, 4);
    case REPORT_GROUP_BY.MONTH:
      return key.slice(0, 7);
    case REPORT_GROUP_BY.WEEK: {
      const day = new Date(`${key}T00:00:00Z`);
      // getUTCDay: 0 — воскресенье. Приводим к понедельнику.
      const weekday = (day.getUTCDay() + 6) % 7;
      day.setUTCDate(day.getUTCDate() - weekday);
      return day.toISOString().slice(0, 10);
    }
    default:
      return key;
  }
}

/** Заголовок первой колонки отчёта о выручке. */
function revenueGroupTitle(query: ReportQuery): string {
  switch (query.groupBy) {
    case REPORT_GROUP_BY.DAY:
      return 'День';
    case REPORT_GROUP_BY.WEEK:
      return 'Неделя с';
    case REPORT_GROUP_BY.MONTH:
      return 'Месяц';
    case REPORT_GROUP_BY.YEAR:
      return 'Год';
    case REPORT_GROUP_BY.PAYMENT_METHOD:
      return 'Способ оплаты';
    case REPORT_GROUP_BY.STORE:
      return 'Магазин';
    default:
      return 'Показатель';
  }
}

/** Дата в формате `ГГГГ-ММ-ДД` по Москве. */
export function toDateKey(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Длительность рабочего дня в часах.
 *
 * Берётся из календаря: значение настраивается, и жёсткая константа разошлась бы
 * с расчётом сроков в `OrderWorkflowService`.
 */
function calendarWorkdayHours(calendar: { defaultHours: number }): number {
  return calendar.defaultHours > 0 ? calendar.defaultHours : 9;
}

export { DEFAULT_PERIOD_DAYS, MAX_PERIOD_DAYS, DEFAULT_LIMIT, REPORT_COLUMN_TYPE };
export type { ReportName, ReportColumnType };
