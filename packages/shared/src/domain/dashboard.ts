/**
 * Главный дашборд по ролям (задача 5.8, docs/06 §6.5).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ В ДОМЕНЕ. Дашборд — единственный экран, который видят
 * ВСЕ роли, и собирается он из блоков разных отчётов. Набор блоков зависит от
 * прав: кассир должен видеть выручку, но не загрузку цеха; руководитель
 * производства — наоборот. Если решать это в сервисе, то каждый новый блок
 * придётся помнить и в коде дашборда, и в матрице прав, — а забытая проверка не
 * сломает ничего видимого: блок просто окажется доступен не тому. Здесь набор
 * блоков и их права лежат рядом, и тест проверяет их вместе.
 */

import { PERMISSION, type Permission } from './roles.js';

/**
 * Блоки главного экрана (docs/06 §6.5).
 *
 * Ключ — он же идентификатор блока в ответе API: интерфейс по нему решает, куда
 * ведёт клик, и менять его нельзя без правки интерфейса.
 */
export const DASHBOARD_BLOCK = {
  /** Заказов в работе. */
  IN_WORK: 'in-work',
  /** Просрочено сейчас. */
  OVERDUE: 'overdue',
  /** Выручка за текущий месяц. */
  REVENUE_MONTH: 'revenue-month',
  /** Предоплаты в работе. */
  PREPAYMENTS_IN_WORK: 'prepayments-in-work',
  /** Средний срок ремонта. */
  AVG_REPAIR: 'avg-repair',
  /** Загрузка цеха. */
  WORKSHOP_LOAD: 'workshop-load',
  /** Рекламации в работе. */
  OPEN_CLAIMS: 'open-claims',
} as const;

export type DashboardBlockCode = (typeof DASHBOARD_BLOCK)[keyof typeof DASHBOARD_BLOCK];

/** Единица измерения — интерфейс форматирует значение по ней. */
export const DASHBOARD_UNIT = {
  COUNT: 'count',
  MONEY: 'money',
  HOURS: 'hours',
  PERCENT: 'percent',
} as const;

export type DashboardUnit = (typeof DASHBOARD_UNIT)[keyof typeof DASHBOARD_UNIT];

export interface DashboardBlockDefinition {
  code: DashboardBlockCode;
  /** Заголовок блока. */
  title: string;
  unit: DashboardUnit;
  /**
   * Право, без которого блок не показывается.
   *
   * Именно право на ОТЧЁТ или сущность, а не роль: роли меняются, права — нет, и
   * проверка по роли рано или поздно разошлась бы с матрицей `ROLE_PERMISSIONS`.
   */
  permission: Permission;
  /**
   * Куда ведёт клик по блоку (docs/06 §6.5: «каждый блок кликабелен»).
   *
   * Путь интерфейса, а не API: дашборд показывает число, а разбираться человек
   * идёт в список или отчёт.
   */
  href: string;
  /** Отчёт, из которого берётся значение, — `null` для счётчиков заказов. */
  report: string | null;
}

/**
 * Состав экрана. Порядок — порядок карточек: сначала то, за чем следят ежедневно.
 */
export const DASHBOARD_BLOCKS: readonly DashboardBlockDefinition[] = [
  {
    code: DASHBOARD_BLOCK.IN_WORK,
    title: 'Заказов в работе',
    unit: DASHBOARD_UNIT.COUNT,
    permission: PERMISSION.ORDER_READ,
    href: '/orders',
    report: null,
  },
  {
    code: DASHBOARD_BLOCK.OVERDUE,
    title: 'Просрочено',
    unit: DASHBOARD_UNIT.COUNT,
    permission: PERMISSION.REPORT_OPERATIONAL,
    href: '/reports/overdue',
    report: 'overdue',
  },
  {
    code: DASHBOARD_BLOCK.REVENUE_MONTH,
    title: 'Выручка за месяц',
    unit: DASHBOARD_UNIT.MONEY,
    permission: PERMISSION.REPORT_REVENUE,
    href: '/reports/revenue',
    report: 'revenue',
  },
  {
    code: DASHBOARD_BLOCK.PREPAYMENTS_IN_WORK,
    title: 'Предоплаты в работе',
    unit: DASHBOARD_UNIT.MONEY,
    permission: PERMISSION.REPORT_REVENUE,
    href: '/reports/prepayments',
    report: 'prepayments',
  },
  {
    code: DASHBOARD_BLOCK.AVG_REPAIR,
    title: 'Средний срок ремонта',
    unit: DASHBOARD_UNIT.HOURS,
    permission: PERMISSION.REPORT_OPERATIONAL,
    href: '/reports/deadlines',
    report: 'deadlines',
  },
  {
    code: DASHBOARD_BLOCK.WORKSHOP_LOAD,
    title: 'Загрузка цеха',
    unit: DASHBOARD_UNIT.PERCENT,
    permission: PERMISSION.REPORT_OPERATIONAL,
    href: '/reports/production-load',
    report: 'production-load',
  },
  {
    code: DASHBOARD_BLOCK.OPEN_CLAIMS,
    title: 'Рекламации в работе',
    unit: DASHBOARD_UNIT.COUNT,
    permission: PERMISSION.CLAIM_READ,
    href: '/claims',
    report: null,
  },
];

/**
 * Блоки, доступные сотруднику с таким набором прав.
 *
 * Возвращаются в порядке объявления: экран не должен переставляться от того, что
 * у одной роли блок есть, а у другой нет.
 */
export function visibleDashboardBlocks(
  permissions: readonly Permission[],
): readonly DashboardBlockDefinition[] {
  const granted = new Set<string>(permissions);
  return DASHBOARD_BLOCKS.filter((block) => granted.has(block.permission));
}

/**
 * Есть ли у сотрудника хотя бы один блок.
 *
 * Нужно интерфейсу: если блоков нет, главный экран показал бы пустую страницу, и
 * человек решил бы, что система сломана. Такое возможно у роли без права
 * `order:read` — например, у бухгалтера без доступа к заказам.
 */
export function hasAnyDashboardBlock(permissions: readonly Permission[]): boolean {
  return visibleDashboardBlocks(permissions).length > 0;
}
