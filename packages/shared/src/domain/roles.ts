/**
 * Роли, права и области видимости. Единый источник правды для API и веба.
 * Документация: docs/02-domain-and-roles.md §2–§4.
 *
 * ВАЖНО: роль «Мастер-ювелир» сознательно отсутствует — по решению заказчика
 * исполнитель производства не является пользователем системы. См. docs/00-decisions.md §2.
 */

export const ROLE = {
  /** Приёмщик магазина */
  RECEIVER: 'RECEIVER',
  /** Менеджер обработки поступающих ремонтов. Ответственный за приёмку и эксплуатацию. */
  PRODUCTION_MANAGER: 'PRODUCTION_MANAGER',
  /** Логист / курьер */
  LOGISTICIAN: 'LOGISTICIAN',
  /** Кассир / бухгалтер точки */
  CASHIER: 'CASHIER',
  /** Руководитель */
  MANAGER: 'MANAGER',
  /** Администратор */
  ADMIN: 'ADMIN',
  /** Наблюдатель / аудитор (read-only) */
  AUDITOR: 'AUDITOR',
  /**
   * Главный бухгалтер. Соутверждает прейскурант (достаточно одной подписи —
   * руководителя ИЛИ главбуха, см. docs/00-decisions.md §1.2) и имеет доступ
   * к финансовой отчётности. Операционной работой с заказами не занимается.
   */
  CHIEF_ACCOUNTANT: 'CHIEF_ACCOUNTANT',
} as const;

export type RoleCode = (typeof ROLE)[keyof typeof ROLE];

export const ALL_ROLES: readonly RoleCode[] = Object.values(ROLE);

export const ROLE_LABELS: Record<RoleCode, string> = {
  RECEIVER: 'Приёмщик магазина',
  PRODUCTION_MANAGER: 'Менеджер обработки поступающих ремонтов',
  LOGISTICIAN: 'Логист / курьер',
  CASHIER: 'Кассир',
  MANAGER: 'Руководитель',
  ADMIN: 'Администратор',
  AUDITOR: 'Наблюдатель',
  CHIEF_ACCOUNTANT: 'Главный бухгалтер',
};

export function roleLabel(role: RoleCode): string {
  return ROLE_LABELS[role];
}

/** Область видимости данных. */
export const DATA_SCOPE = {
  /** Только заказы магазинов пользователя. */
  STORE: 'STORE',
  /** Свои заказы + глобальный поиск по точному номеру. */
  STORE_PLUS_GLOBAL_SEARCH: 'STORE_PLUS_GLOBAL_SEARCH',
  /** Все заказы, находящиеся в производстве или логистике. */
  PRODUCTION: 'PRODUCTION',
  /** Все магазины сети. */
  ALL_STORES: 'ALL_STORES',
  /** Полное чтение без права изменения. */
  READ_ALL: 'READ_ALL',
} as const;

export type DataScope = (typeof DATA_SCOPE)[keyof typeof DATA_SCOPE];

/** Область видимости по умолчанию для каждой роли. */
export const DEFAULT_ROLE_SCOPE: Record<RoleCode, DataScope> = {
  RECEIVER: DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH,
  PRODUCTION_MANAGER: DATA_SCOPE.PRODUCTION,
  LOGISTICIAN: DATA_SCOPE.PRODUCTION,
  CASHIER: DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH,
  MANAGER: DATA_SCOPE.ALL_STORES,
  ADMIN: DATA_SCOPE.ALL_STORES,
  AUDITOR: DATA_SCOPE.READ_ALL,
  // Главбух контролирует финансы всей сети, но не работает с заказами операционно.
  CHIEF_ACCOUNTANT: DATA_SCOPE.ALL_STORES,
};

/**
 * Права доступа. Формат `ресурс:действие`.
 * Матрица из docs/02-domain-and-roles.md §4 выражена в коде.
 */
export const PERMISSION = {
  ORDER_CREATE: 'order:create',
  ORDER_READ: 'order:read',
  ORDER_UPDATE: 'order:update',
  ORDER_TRANSITION: 'order:transition',
  ORDER_CANCEL: 'order:cancel',
  ORDER_SEARCH_GLOBAL: 'order:search:global',

  ITEM_MANAGE: 'item:manage',

  CALC_READ: 'calc:read',
  CALC_EDIT: 'calc:edit',
  CALC_ADJUST: 'calc:adjust',

  PRICELIST_READ: 'pricelist:read',
  PRICELIST_EDIT: 'pricelist:edit',
  PRICELIST_APPROVE: 'pricelist:approve',

  APPROVAL_CREATE: 'approval:create',
  APPROVAL_READ: 'approval:read',

  RECORDING_LISTEN: 'recording:listen',
  RECORDING_DELETE: 'recording:delete',

  PAYMENT_CREATE: 'payment:create',
  PAYMENT_READ: 'payment:read',
  PAYMENT_REVERSE: 'payment:reverse',

  LOGISTICS_MANAGE: 'logistics:manage',
  LOGISTICS_READ: 'logistics:read',

  PERFORMER_MANAGE: 'performer:manage',
  PRODUCTION_MANAGE: 'production:manage',
  PRODUCTION_READ: 'production:read',

  WARRANTY_MANAGE: 'warranty:manage',
  CLAIM_READ: 'claim:read',
  CLAIM_MANAGE: 'claim:manage',

  REPORT_OPERATIONAL: 'report:operational',
  REPORT_REVENUE: 'report:revenue',
  REPORT_EXPORT: 'report:export',

  AUDIT_READ: 'audit:read',
  USER_MANAGE: 'user:manage',
  SETTINGS_MANAGE: 'settings:manage',
  INTEGRATION_MANAGE: 'integration:manage',
} as const;

export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION];

const P = PERMISSION;

/** Матрица «роль → права». Соответствует таблице docs/02-domain-and-roles.md §4. */
export const ROLE_PERMISSIONS: Record<RoleCode, readonly Permission[]> = {
  [ROLE.RECEIVER]: [
    P.ORDER_CREATE,
    P.ORDER_READ,
    P.ORDER_UPDATE,
    P.ORDER_TRANSITION,
    P.ORDER_CANCEL,
    P.ORDER_SEARCH_GLOBAL,
    P.ITEM_MANAGE,
    P.CALC_READ,
    P.CALC_EDIT,
    P.CALC_ADJUST,
    P.PRICELIST_READ,
    P.APPROVAL_CREATE,
    P.APPROVAL_READ,
    P.RECORDING_LISTEN,
    P.PAYMENT_READ,
    P.PRODUCTION_READ,
    P.CLAIM_READ,
    P.WARRANTY_MANAGE,
    P.REPORT_OPERATIONAL,
  ],
  [ROLE.PRODUCTION_MANAGER]: [
    P.ORDER_READ,
    P.ORDER_UPDATE,
    P.ORDER_TRANSITION,
    P.ORDER_CANCEL,
    P.ORDER_SEARCH_GLOBAL,
    P.ITEM_MANAGE,
    P.CALC_READ,
    P.CALC_EDIT,
    P.CALC_ADJUST,
    P.PRICELIST_READ,
    P.APPROVAL_CREATE,
    P.APPROVAL_READ,
    P.RECORDING_LISTEN,
    P.PRODUCTION_MANAGE,
    P.PRODUCTION_READ,
    P.PERFORMER_MANAGE,
    P.LOGISTICS_MANAGE,
    P.LOGISTICS_READ,
    P.WARRANTY_MANAGE,
    P.CLAIM_READ,
    P.CLAIM_MANAGE,
    P.REPORT_OPERATIONAL,
  ],
  [ROLE.LOGISTICIAN]: [
    P.ORDER_READ,
    P.ORDER_TRANSITION,
    P.ORDER_SEARCH_GLOBAL,
    P.LOGISTICS_MANAGE,
    P.LOGISTICS_READ,
    P.PRODUCTION_READ,
  ],
  [ROLE.CASHIER]: [
    P.ORDER_READ,
    P.ORDER_TRANSITION,
    P.ORDER_SEARCH_GLOBAL,
    P.PAYMENT_CREATE,
    P.PAYMENT_READ,
    P.PAYMENT_REVERSE,
    P.PRICELIST_READ,
    P.CALC_READ,
    P.REPORT_REVENUE,
    P.REPORT_EXPORT,
  ],
  [ROLE.MANAGER]: [
    P.ORDER_READ,
    P.ORDER_CANCEL,
    P.ORDER_SEARCH_GLOBAL,
    P.CALC_READ,
    P.CALC_ADJUST,
    P.PRICELIST_READ,
    P.PRICELIST_APPROVE,
    P.APPROVAL_READ,
    P.RECORDING_LISTEN,
    P.PAYMENT_READ,
    P.PAYMENT_REVERSE,
    P.PRODUCTION_READ,
    P.LOGISTICS_READ,
    P.CLAIM_READ,
    P.CLAIM_MANAGE,
    P.REPORT_OPERATIONAL,
    P.REPORT_REVENUE,
    P.REPORT_EXPORT,
    P.AUDIT_READ,
  ],
  /**
   * Администратор: все права, КРОМЕ утверждения прейскуранта.
   *
   * ## Почему утверждение изъято
   *
   * Матрица прав (`docs/02-domain-and-roles.md` §4) ставит администратору
   * прочерк в строке «Прейскурант: утверждение»: утверждают руководитель и
   * главный бухгалтер. Причина — разделение обязанностей. Администратор правит
   * цены; если он же их утверждает, подпись под ценами перестаёт что-либо
   * значить, потому что один человек и назначает цену, и согласует её.
   *
   * Раньше здесь стоял `...Object.values(P)`, и прочерк в матрице не действовал:
   * администратор получал право, которого у него по документации нет. Хуже
   * того, дефект был невидим — `RolesGuard` пропускал администратора раньше
   * проверки прав, поэтому даже явный запрет на маршруте ничего не менял.
   *
   * ## Что это НЕ ломает
   *
   * Администратор сохраняет доступ ко всем остальным действиям, включая
   * настройку системы и правку прейскуранта. Изъято ровно одно право — то,
   * которое по смыслу должно принадлежать другому человеку.
   */
  [ROLE.ADMIN]: [...Object.values(P).filter((permission) => permission !== P.PRICELIST_APPROVE)],
  [ROLE.AUDITOR]: [
    P.ORDER_READ,
    P.ORDER_SEARCH_GLOBAL,
    P.CALC_READ,
    P.PRICELIST_READ,
    P.APPROVAL_READ,
    P.RECORDING_LISTEN,
    P.PAYMENT_READ,
    P.PRODUCTION_READ,
    P.LOGISTICS_READ,
    P.CLAIM_READ,
    P.REPORT_OPERATIONAL,
    P.REPORT_REVENUE,
    P.AUDIT_READ,
  ],
  /**
   * Главный бухгалтер (ответ A2, docs/00-decisions.md §1.2).
   *
   * Соутверждает прейскурант — достаточно ОДНОЙ подписи руководителя ИЛИ главбуха.
   * Доступ к финансам и аудиту. Операционная работа с заказами не входит:
   * нет прав на создание заказа, переходы статусов, калькуляцию и платежи.
   */
  [ROLE.CHIEF_ACCOUNTANT]: [
    P.ORDER_READ,
    P.ORDER_SEARCH_GLOBAL,
    P.CALC_READ,
    P.PRICELIST_READ,
    P.PRICELIST_APPROVE,
    P.APPROVAL_READ,
    P.PAYMENT_READ,
    P.PAYMENT_REVERSE,
    P.CLAIM_READ,
    P.REPORT_OPERATIONAL,
    P.REPORT_REVENUE,
    P.REPORT_EXPORT,
    P.AUDIT_READ,
  ],
};

/** Вычислить набор прав по списку ролей (пользователь может иметь несколько). */
export function permissionsFor(roles: readonly RoleCode[]): Set<Permission> {
  const result = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) {
      result.add(permission);
    }
  }
  return result;
}

export function hasPermission(roles: readonly RoleCode[], permission: Permission): boolean {
  return permissionsFor(roles).has(permission);
}

/** Проверить, требуется ли глобальный поиск для роли (приём оплаты в чужой точке). */
export function canSearchGlobally(roles: readonly RoleCode[]): boolean {
  return hasPermission(roles, PERMISSION.ORDER_SEARCH_GLOBAL);
}
