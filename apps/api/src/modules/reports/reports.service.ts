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
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
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

    const computed = await this.compute(name, scoped);
    return {
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
  }

  private async compute(name: string, query: ReportQuery): Promise<ComputedReport> {
    switch (name) {
      case REPORT_NAME.STAGE_DURATIONS:
        return this.stageDurations(query);
      case REPORT_NAME.WORKSHOP_LOAD:
        return this.workshopLoad(query);
      case REPORT_NAME.OVERDUE:
        return this.overdue(query);
      default:
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `Отчёт «${name}» не поддерживается`,
          details: { supported: Object.values(REPORT_NAME) },
        });
    }
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
