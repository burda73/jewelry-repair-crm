/**
 * Сводка главного экрана (задача 5.8, docs/06 §6.5).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СЕРВИС, А НЕ СУММА СУЩЕСТВУЮЩИХ. Дашборд собирается из
 * СЕМИ разных источников: счётчики заказов, четыре отчёта и два счётчика
 * рекламаций. Считать их на клиенте нельзя — список заказов ограничен областью
 * видимости роли и размером страницы, и «просрочено: 1» вместо фактических 40
 * ввело бы руководителя в заблуждение.
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ. Значение каждого блока берётся из ТОГО ЖЕ источника, что
 * показывает соответствующий отчёт. Дашборд и отчёт об одном и том же обязаны
 * показывать одно число: если дашборд посчитает выручку сам, а отчёт — иначе,
 * руководитель увидит два разных числа и не будет доверять ни одному. Поэтому
 * выручка берётся через `ReportsService`, а не отдельным запросом.
 *
 * БЛОКИ ФИЛЬТРУЮТСЯ ПО ПРАВАМ. Кассир видит деньги, но не загрузку цеха;
 * руководитель производства — наоборот. Состав блоков и их права лежат в домене
 * (`DASHBOARD_BLOCKS`), и здесь выполняется только запрос: дублировать матрицу
 * прав в сервисе значило бы завести второе место, где её можно забыть обновить.
 */

import { Injectable } from '@nestjs/common';
import {
  DASHBOARD_BLOCK,
  DASHBOARD_BLOCKS,
  REPORT_NAME,
  visibleDashboardBlocks,
  type DashboardBlockCode,
  type DashboardUnit,
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { ROLE_PERMISSIONS } from '@app/shared';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import type { OrderStatus } from '@app/shared';
import type { ClaimStatus } from '@prisma/client';
import type { Permission } from '@app/shared';
import { ORDER_STATUS } from '@app/shared';

/**
 * Статусы, которые в счётчик «просрочено» не попадают.
 *
 * Совпадает со списком воркера эскалаций и с `OVERDUE_EXCLUDED_STATUSES` в
 * `OrdersService`: три места, показывающие одну просрочку, обязаны считать её
 * одинаково, иначе дашборд и отчёт разойдутся.
 */
const OVERDUE_EXCLUDED_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.DRAFT,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.AWAITING_PREPAYMENT,
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.REFUSED,
  ORDER_STATUS.REFUSED_BEFORE_WORK,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.UNCLAIMED,
];

/** Статус, означающий «заказ закрыт»: в работе его больше нет. */
const CLOSED_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.REFUSED,
  ORDER_STATUS.REFUSED_BEFORE_WORK,
  ORDER_STATUS.CANCELLED,
];

/**
 * Рекламации, работа по которым ещё идёт.
 *
 * Открытая и рассматриваемая: обе требуют действия от сотрудника. Одобренная и
 * решённая считаются закрытыми — работа по ним уже распределена.
 */
const OPEN_CLAIM_STATUSES: readonly ClaimStatus[] = ['OPENED', 'IN_REVIEW'];

/** Один блок в ответе. */
export interface DashboardBlock {
  code: DashboardBlockCode;
  title: string;
  unit: DashboardUnit;
  /** Готовое значение; `null` — данных нет (не ноль). */
  value: number | null;
  /** Куда ведёт клик. */
  href: string;
  /** Отчёт-источник или `null` для счётчиков заказов. */
  report: string | null;
}

export interface DashboardSummary {
  /** Момент сбора сводки. */
  generatedAt: string;
  /** Период денежных блоков — текущий месяц. */
  period: { from: string; to: string };
  blocks: DashboardBlock[];
}

/**
 * Начало текущего месяца и конец текущих суток.
 *
 * Денежные блоки показывают ТЕКУЩИЙ месяц (docs/06 §6.5, «выручка за месяц»).
 * Месяц берётся календарный, а не «30 дней назад»: руководитель сверяет цифру с
 * бухгалтерией, а та закрывает месяц календарно.
 */
export function currentMonthPeriod(now: Date): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Конец текущих суток, а не `now`: иначе выручка, внесённая час назад, не
  // попала бы в отчёт, потому что платёж записан моментом позже начала запроса.
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999),
  );
  return { from, to };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
  ) {}

  /**
   * Собрать сводку для сотрудника.
   *
   * Блоки, на которые у сотрудника нет права, не запрашиваются ВООБЩЕ: не
   * «запрашиваются и скрываются», а не считаются. Разница практическая — если
   * считать всё, то дашборд кассира грузил бы тяжёлый отчёт по загрузке цеха,
   * который он никогда не увидит, и наоборот.
   */
  async build(user: AuthenticatedUser, now: Date = new Date()): Promise<DashboardSummary> {
    const permissions = this.permissionsOf(user);
    const visible = visibleDashboardBlocks(permissions);
    const codes = new Set(visible.map((block) => block.code));

    const period = currentMonthPeriod(now);

    // Область видимости строится один раз: она одинакова для всех счётчиков
    // заказов, и повторять её — верный способ однажды поправить в одном месте.
    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scopes: user.scopes,
      storeIds: user.storeIds,
      userId: user.id,
    });

    const [overdueCount, openClaims] = await Promise.all([
      codes.has(DASHBOARD_BLOCK.OVERDUE)
        ? this.prisma.order.count({
            where: {
              AND: [
                scopeFilter,
                { dueAt: { lt: now } },
                { status: { notIn: [...OVERDUE_EXCLUDED_STATUSES] } },
              ],
            },
          })
        : Promise.resolve<number | null>(null),
      codes.has(DASHBOARD_BLOCK.OPEN_CLAIMS)
        ? this.prisma.warrantyClaim.count({ where: { status: { in: [...OPEN_CLAIM_STATUSES] } } })
        : Promise.resolve<number | null>(null),
    ]);

    const values = new Map<DashboardBlockCode, number | null>();

    if (codes.has(DASHBOARD_BLOCK.IN_WORK)) {
      values.set(
        DASHBOARD_BLOCK.IN_WORK,
        await this.prisma.order.count({
          where: { AND: [scopeFilter, { status: { notIn: [...CLOSED_STATUSES] } }] },
        }),
      );
    }

    if (overdueCount !== null) values.set(DASHBOARD_BLOCK.OVERDUE, overdueCount);
    if (openClaims !== null) values.set(DASHBOARD_BLOCK.OPEN_CLAIMS, openClaims);

    /*
     * Денежные и операционные числа берутся ИЗ ОТЧЁТОВ — тех же, что открываются
     * по клику. Свой запрос здесь дал бы второе определение выручки, и два числа
     * на одном экране разошлись бы при первой же правке одного из них.
     */
    if (codes.has(DASHBOARD_BLOCK.REVENUE_MONTH)) {
      const revenue = await this.reports.build(
        REPORT_NAME.REVENUE,
        {
          from: period.from,
          to: period.to,
          storeIds: [],
          workshopIds: [],
          groupBy: null,
          limit: 1,
        },
        user,
      );
      values.set(DASHBOARD_BLOCK.REVENUE_MONTH, asNumber(revenue.totals.netRevenueMinor));
    }

    if (codes.has(DASHBOARD_BLOCK.PREPAYMENTS_IN_WORK)) {
      const prepayments = await this.reports.build(
        REPORT_NAME.PREPAYMENTS,
        {
          from: period.from,
          to: period.to,
          storeIds: [],
          workshopIds: [],
          groupBy: null,
          limit: 1,
        },
        user,
      );
      values.set(DASHBOARD_BLOCK.PREPAYMENTS_IN_WORK, asNumber(prepayments.totals.inWorkMinor));
    }

    if (codes.has(DASHBOARD_BLOCK.AVG_REPAIR)) {
      const deadlines = await this.reports.build(
        REPORT_NAME.STAGE_DURATIONS,
        {
          from: period.from,
          to: period.to,
          storeIds: [],
          workshopIds: [],
          groupBy: null,
          limit: 1,
        },
        user,
      );
      values.set(DASHBOARD_BLOCK.AVG_REPAIR, asNumber(deadlines.totals.avgHours));
    }

    if (codes.has(DASHBOARD_BLOCK.WORKSHOP_LOAD)) {
      const load = await this.reports.build(
        REPORT_NAME.WORKSHOP_LOAD,
        {
          from: period.from,
          to: period.to,
          storeIds: [],
          workshopIds: [],
          groupBy: null,
          limit: 1,
        },
        user,
      );
      /*
       * Загрузка показывается ДОЛЕЙ, а не часами: «87 %» руководителю понятнее,
       * чем «142 из 163 ч». Если плановых часов нет, значение не определено —
       * `null`, а не 0: ноль процентов означал бы «цех простаивает», что
       * неправда.
       */
      const planned = asNumber(load.totals.plannedHours);
      const fact = asNumber(load.totals.factHours);
      values.set(
        DASHBOARD_BLOCK.WORKSHOP_LOAD,
        planned === null || planned === 0 || fact === null ? null : round4(fact / planned),
      );
    }

    return {
      generatedAt: now.toISOString(),
      period: {
        from: period.from.toISOString().slice(0, 10),
        to: period.to.toISOString().slice(0, 10),
      },
      blocks: visible.map((block) => ({
        code: block.code,
        title: block.title,
        unit: block.unit,
        value: values.get(block.code) ?? null,
        href: block.href,
        report: block.report,
      })),
    };
  }

  /**
   * Права сотрудника.
   *
   * Собираются по его ролям: у одного человека их может быть несколько, и права
   * складываются. Пустой набор прав даёт пустой экран — это честнее выдуманных
   * чисел, и интерфейс показывает пояснение, а не «0».
   */
  private permissionsOf(user: AuthenticatedUser): readonly Permission[] {
    const granted = new Set<Permission>();
    for (const role of user.roles) {
      for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
    }
    return [...granted];
  }
}

/** Число из значения итогов: `null` и отсутствие поля дают `null`, а не 0. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export { DASHBOARD_BLOCKS };
