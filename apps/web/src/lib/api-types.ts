import type { OrderStatus } from '@app/shared';

/**
 * Типы ответов API для фронтенда.
 *
 * Дублируют форму ответа сервера, а не импортируются из него: API — отдельное
 * приложение, и общий тип создал бы ложное впечатление, что изменения на
 * сервере автоматически попадут сюда. Эти типы зафиксированы по фактическому
 * ответу (`orders.service.ts`, `auth.service.ts`) и меняются вместе с ним.
 */

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  primaryRole: string;
  permissions: string[];
  scope: string;
  storeIds: string[];
  storeRoles: { role: string; storeId: string | null; scope: string }[];
}

/** Магазин в справочнике (`GET /stores`). */
export interface StoreOption {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
}

export interface LoginResponse {
  user: AuthenticatedUser;
}

export interface OrderCustomer {
  id?: string;
  fullName: string;
  phoneNormalized: string;
  phone?: string;
  email?: string | null;
}

export interface OrderStore {
  id?: string;
  code: string;
  name: string;
}

/** Строка списка заказов (`GET /orders`). */
export interface OrderListItem {
  id: string;
  orderNo: string;
  status: OrderStatus;
  statusLabel: string;
  priority: string;
  totalAmountMinor: number;
  paidAmountMinor: number;
  remainingMinor: number;
  dueAt: string | null;
  promisedAt: string | null;
  readyAt: string | null;
  createdAt: string;
  isWarranty: boolean;
  isOverdue: boolean;
  customer: OrderCustomer;
  createdStore: OrderStore;
}

export interface OrderListResponse {
  items: OrderListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Позиция изделия в карточке заказа. */
/**
 * Фотография изделия.
 *
 * Ключ хранилища наружу не отдаётся: `url` и `thumbnailUrl` — адреса API,
 * доступ к которым проверяется правами и областью видимости заказа.
 */
export interface ItemPhotoView {
  id: string;
  itemId: string;
  kind: 'INTAKE' | 'DEFECT' | 'RESULT' | 'AFTER_REPAIR';
  caption: string | null;
  sortOrder: number;
  createdAt: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  thumbnailUrl: string;
}

export interface OrderItem {
  id: string;
  name: string;
  metal: string | null;
  weightGram: number | string | null;
  size: string | null;
  hallmark: string | null;
  defects: string | null;
  completeness: string | null;
  inventoryNo: string | null;
  /** Фотографии изделия — приходят вместе с карточкой заказа. */
  photos: ItemPhotoView[];
}

export interface OrderWork {
  id: string;
  code: string;
  name: string;
  quantity: number | string;
  unit: string;
  unitPriceMinor: number;
  /**
   * Сумма строки: `quantity × unitPriceMinor`.
   *
   * Хранится в БД отдельным полем, а не считается в интерфейсе: при
   * корректировке строки меняется именно оно, и пересчёт «на месте» показал бы
   * прежнюю сумму, пока запрос не вернётся.
   */
  amountMinor: number;
  durationHours: number | null;
  comment: string | null;
  isCustom: boolean;
}

export interface OrderStone {
  id: string;
  name: string;
  quantity: number;
  caratWeight: number | string | null;
  unitPriceMinor: number;
  /** Сумма строки — см. `OrderWork.amountMinor`. */
  amountMinor: number;
}

/**
 * Платёж в составе карточки заказа.
 *
 * Поля описаны по фактическому ответу `GET /orders/:id`, а не по исходной
 * модели: `idempotencyKey` наружу не отдаётся (это техническая деталь защиты
 * от дублей), а `fiscalDocNo`/`externalId` пока всегда `null` — обмен с 1С
 * отложен, но поля существуют в схеме БД.
 */
export interface OrderPayment {
  id: string;
  orderId: string;
  kind: PaymentKind;
  method: PaymentMethod;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  storeId: string;
  cashierId: string;
  receiptNo: string | null;
  kktShiftNo: string | null;
  paidAt: string;
  comment: string | null;
  reversedById: string | null;
  reversedAt: string | null;
  createdAt: string;
}

export type PaymentKind = 'PREPAYMENT' | 'FINAL' | 'ADDITIONAL' | 'REFUND' | 'REVERSAL';
export type PaymentMethod = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'ONLINE';
export type PaymentStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERSED';

/**
 * Состояние оплаты заказа, возвращаемое вместе с платежом.
 *
 * Нужно, чтобы сразу после операции показать, снялась ли блокировка старта
 * работ, — без второго запроса и без риска показать устаревшие данные.
 */
export interface OrderPaymentState {
  orderId: string;
  totalAmountMinor: number;
  paidAmountMinor: number;
  prepaymentRequiredMinor: number;
  requiresPrepayment: boolean;
  remainingMinor: number;
  canStartWork: boolean;
  isPaidInFull: boolean;
}

export interface PaymentResult {
  payment: OrderPayment;
  order: OrderPaymentState;
}

export interface OrderApproval {
  id: string;
  amountMinor: number;
  isVerbal: boolean;
  result: string;
  channel: string | null;
  approvedAt: string | null;
  createdAt: string;
  createdBy: { fullName: string } | null;
}

export interface OrderAdjustment {
  id: string;
  deltaMinor: number;
  amountBeforeMinor: number;
  amountAfterMinor: number;
  reason: string;
  createdAt: string;
  adjustedBy: { fullName: string } | null;
}

export interface OrderStatusHistoryEntry {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  reason: string | null;
  isSystem: boolean;
  createdAt: string;
  changedBy: { fullName: string } | null;
}

export interface AvailableTransition {
  to: OrderStatus;
  label: string;
  requiresReason: boolean;
}

/** Карточка заказа (`GET /orders/:id`). */
export interface OrderDetail {
  id: string;
  orderNo: string;
  status: OrderStatus;
  statusLabel: string;
  priority: string;
  version: number;
  totalAmountMinor: number;
  worksTotalMinor: number;
  stonesTotalMinor: number;
  discountMinor: number;
  paidAmountMinor: number;
  remainingMinor: number;
  prepaymentRequiredMinor: number;
  requiresPrepayment: boolean;
  canStartWork: boolean;
  isOverdue: boolean;
  isWarranty: boolean;
  currency: string;
  dueAt: string | null;
  promisedAt: string | null;
  readyAt: string | null;
  acceptedAt: string | null;
  productionStartedAt: string | null;
  productionFinishedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  description: string | null;
  diagnosis: string | null;
  cancelReason: string | null;
  qrPayload: string | null;
  receiptPrintCount: number;
  customer: OrderCustomer;
  createdStore: OrderStore;
  pickupStore: OrderStore;
  workshop: { id: string; name: string } | null;
  createdBy: { id: string; fullName: string } | null;
  productionManager: { id: string; fullName: string } | null;
  items: OrderItem[];
  works: OrderWork[];
  stones: OrderStone[];
  payments: OrderPayment[];
  approvals: OrderApproval[];
  adjustments: OrderAdjustment[];
  statusHistory: OrderStatusHistoryEntry[];
  availableTransitions: AvailableTransition[];
}

/** Запись единой ленты событий (`GET /orders/:id/timeline`). */
export interface TimelineEntry {
  type: 'STATUS' | 'PAYMENT' | 'APPROVAL' | 'ADJUSTMENT';
  at: string;
  title: string;
  actor: string | null;
  details: Record<string, unknown>;
}

/** Результат глобального поиска (`GET /orders/search`). */
export interface SearchResultItem {
  id: string;
  orderNo: string;
  status: OrderStatus;
  statusLabel: string;
  totalAmountMinor: number;
  paidAmountMinor: number;
  dueAt: string | null;
  createdAt: string;
  customer: { fullName: string; phoneNormalized: string };
  createdStore: { code: string; name: string };
  outsideScope: boolean;
}

/** Фильтры списка заказов. */
export interface OrderFilters {
  status?: OrderStatus[];
  storeId?: string[];
  overdue?: boolean;
  isWarranty?: boolean;
  priority?: string;
  orderNo?: string;
  customerPhone?: string;
}

// ---------------------------------------------------------------------------
// Справочники и мастер создания заказа
// ---------------------------------------------------------------------------

/** Позиция прейскуранта (`GET /price-list-items`, `GET /price-lists/active`). */
export interface PriceListItemOption {
  id: string;
  priceListId: string;
  categoryId: string | null;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  /** Цена по умолчанию (по золоту). Для конкретного металла — `rates`. */
  priceMinor: number;
  /** Цена указана как «от» (минимальная) — 5 позиций прейскуранта. */
  priceFrom: boolean;
  /** Стоимость металла в цену не входит и считается отдельно (3 позиции). */
  metalCostSeparate: boolean;
  durationHours: number | null;
  warrantyMonths: number | null;
  requiresPrepayment: boolean;
  isActive: boolean;
  category: { id: string; code: string; name: string } | null;
  /**
   * Цены по металлам: золото и серебро заданы отдельными ставками.
   * Ставку выбирает `resolveItemPrice` из `@app/shared` — та же функция,
   * что и на сервере, иначе интерфейс и сервер разошлись бы в сумме.
   */
  rates: { metal: string; priceMinor: number; isFrom: boolean }[];
}

export interface PriceListVersion {
  id: string;
  version: number;
  storeId: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  comment: string | null;
  approvedAt: string | null;
  items: PriceListItemOption[];
}

export interface WorkCategoryOption {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface StoneTypeOption {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface WorkshopOption {
  id: string;
  code: string;
  name: string;
  address: string | null;
  isActive: boolean;
}

/** Результат поиска клиента (`GET /customers/search`). */
export interface CustomerSearchItem {
  id: string;
  fullName: string;
  phone: string;
  phoneNormalized: string;
  email: string | null;
  consentCallRecording: boolean;
  consentMarketing: boolean;
  createdAt: string;
  ordersCount: number;
  lastOrder: { orderNo: string; status: string; createdAt: string } | null;
}

/** Карточка клиента (`GET /customers/:id`). */
export interface CustomerDetail extends CustomerSearchItem {
  birthDate: string | null;
  notes: string | null;
  orders: { id: string; orderNo: string; status: string; createdAt: string }[];
}

/** Созданный заказ (`POST /orders`). */
export interface CreatedOrderResponse {
  id: string;
  orderNo: string;
  status: string;
  totalAmountMinor: number;
  prepaymentRequiredMinor: number;
  requiresPrepayment: boolean;
  dueAt: string;
}

// ---------------------------------------------------------------------------
// Администрирование: учётные записи и роли (задача 1.2.4)
// ---------------------------------------------------------------------------

/**
 * Роль в том виде, в каком её отдаёт API.
 *
 * `role` и `scope` — коды из `@app/shared`; `roleLabel` и `scopeLabel` сервер
 * отдаёт готовыми, чтобы интерфейс не дублировал словарь подписей и не
 * расходился с ним.
 */
export interface UserRoleView {
  id: string;
  role: string;
  roleLabel: string;
  storeId: string | null;
  storeName: string | null;
  scope: string;
  scopeLabel: string;
}

/** Учётная запись в списке (`GET /users`). */
export interface UserListItem {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
  roles: UserRoleView[];
  stores: { id: string; code: string; name: string; isDefault: boolean }[];
  /** Число активных сессий: администратору видно, работает ли сотрудник сейчас. */
  activeSessions: number;
}

/** Карточка учётной записи (`GET /users/:id`). */
export interface UserDetail extends UserListItem {
  /** Объединение прав всех ролей — то же, что отдаёт `GET /auth/me`. */
  permissions: string[];
}

/** Роль в справочнике (`GET /users/roles-catalog`). */
export interface RoleCatalogEntry {
  code: string;
  label: string;
  permissions: string[];
}

/** Справочник ролей и областей видимости (`GET /users/roles-catalog`). */
export interface RolesCatalog {
  roles: RoleCatalogEntry[];
  scopes: { code: string; label: string }[];
}

/** Фильтры списка учётных записей. */
export interface UserFilters {
  q?: string;
  /** `true` | `false`; без значения возвращаются все. */
  isActive?: string;
  role?: string;
}

/** Новый сотрудник (`POST /users`). */
export interface UserCreateInput {
  email: string;
  fullName: string;
  phone?: string;
  password: string;
  roles: { role: string; storeId?: string; scope?: string }[];
  storeIds: string[];
}

/** Правка учётной записи (`PATCH /users/:id`). */
export interface UserUpdateInput {
  email?: string;
  fullName?: string;
  phone?: string;
  isActive?: boolean;
  storeIds?: string[];
}

// ---------------------------------------------------------------------------
// Справочники: администрирование (задача 1.3.1)
// ---------------------------------------------------------------------------

/**
 * Запись справочника, отдаваемая `GET`-маршрутами.
 *
 * Отдельные интерфейсы, хотя поля во многом совпадают с `*Option`: `Option`
 * описывают то, что нужно для выбора в форме заказа (`id`, `code`, `name`,
 * `isActive`), а здесь администратору нужны все поля карточки — адрес,
 * телефон, часовой пояс, цена. Совместить их значило бы либо тащить лишние
 * поля в каждую форму заказа, либо потерять их в админке.
 */
export interface StoreAdminItem {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  isActive: boolean;
}

export interface WorkshopAdminItem {
  id: string;
  code: string;
  name: string;
  address: string | null;
  isActive: boolean;
}

export interface PerformerAdminItem {
  id: string;
  fullName: string;
  specialization: string | null;
  grade: string | null;
  isActive: boolean;
  workshop: { id: string; code: string; name: string };
}

export interface WorkCategoryAdminItem {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface StoneTypeAdminItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  priceMinor: number;
  isActive: boolean;
}

/** Тело создания/правки магазина (`POST`/`PATCH /stores`). */
export interface StoreAdminInput {
  code?: string;
  name?: string;
  address?: string | null;
  phone?: string | null;
  timezone?: string;
  isActive?: boolean;
}

export interface WorkshopAdminInput {
  code?: string;
  name?: string;
  address?: string | null;
  isActive?: boolean;
}

export interface PerformerAdminInput {
  workshopId?: string;
  fullName?: string;
  specialization?: string;
  grade?: string;
  isActive?: boolean;
}

export interface WorkCategoryAdminInput {
  code?: string;
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface StoneTypeAdminInput {
  code?: string;
  name?: string;
  unit?: string;
  priceMinor?: number;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Рабочий календарь (задача 1.3.3)
// ---------------------------------------------------------------------------

/**
 * Запись календаря — только ИСКЛЮЧЕНИЕ: праздник, перенос или особые часы.
 *
 * Обычные рабочие дни здесь не перечисляются: правило «пн–пт рабочие» и
 * государственные праздники РФ знает код, а таблица хранит лишь отклонения.
 * Иначе на каждый день появлялась бы строка, и праздник среди недели,
 * помеченный рабочим, снова сдвинул бы срок выдачи заказа.
 */
export interface CalendarDayItem {
  id: string;
  /** Дата в формате ГГГГ-ММ-ДД. */
  date: string;
  isWorkday: boolean;
  hours: number;
  note: string | null;
  /** Государственный праздник РФ по ТК РФ, независимо от наличия записи. */
  isHoliday: boolean;
  /**
   * Запись ничего не меняет: день и без неё такой же.
   *
   * Наследие прежнего заполнения календаря (была строка на каждый день).
   * Такие записи интерфейс показывает отдельно и предлагает снять: они
   * перекрывают встроенные праздники.
   */
  redundant: boolean;
}

/** Ответ списка: записи-исключения и праздники периода. */
export interface CalendarListResponse {
  days: CalendarDayItem[];
  /** Праздники РФ в периоде: нерабочие даже без записи в таблице. */
  holidays: string[];
}

/** Сводка по месяцу: сколько рабочих дней и нерабочих. */
export interface CalendarMonthSummary {
  month: string;
  workdays: number;
  holidays: number;
}

export interface CalendarDayInput {
  date?: string;
  isWorkday?: boolean;
  hours?: number;
  note?: string | null;
}

/**
 * Норматив этапа (задача 1.3.4, ТЗ п. 2.7).
 *
 * `stage` — ЭТАП, а не статус заказа: соответствие задаёт `stageForStatus()`.
 * Прежде расчёт искал норматив по имени статуса и не находил ни одного — см.
 * «Дефект 26» в docs/15-known-issues.md.
 */
export interface NormItem {
  id: string;
  /** Этап: APPROVAL | PREPAYMENT | QUEUE | LOGISTICS_OUT | PRODUCTION | LOGISTICS_IN | PICKUP | CLAIM. */
  stage: string;
  /** ANY — общий норматив этапа; SIMPLE/COMPLEX — для конкретной сложности. */
  workType: string;
  value: number;
  /** WORKHOUR | WORKDAY | CALENDAR_DAY. */
  unit: string;
  escalateToRole: string | null;
}

/**
 * Версия нормативов — набор ЦЕЛИКОМ.
 *
 * Правка создаёт новую версию, а не меняет строку: по прежней версии объясняют
 * сроки уже принятых заказов. Поэтому интерфейс показывает историю, а не только
 * действующий набор.
 */
export interface NormVersion {
  version: number;
  isActive: boolean;
  effectiveFrom: string;
  approvedAt: string | null;
  approvedById: string | null;
  norms: NormItem[];
}

/** Одна запись при создании версии. */
export interface NormEntryInput {
  stage: string;
  workType: string;
  value: number;
  unit: string;
  escalateToRole?: string | null;
}

export interface CreateNormVersionInput {
  norms: NormEntryInput[];
  changeReason: string;
  effectiveFrom?: string;
}

/** Состояние партии «в пути» (задача 2.6). */
export interface BatchTransitState {
  /** Часов с отправки; `null`, если рейс ещё не отправлен. */
  elapsedHours: number | null;
  /** Норматив в часах, взятый из настроек. */
  normHours: number;
  /** `ON_TIME` | `LATE` | `OVERDUE`. */
  level: string;
  /** Рейс вышел за норматив. */
  isOverdue: boolean;
  /** Готовая фраза для интерфейса. */
  message: string;
}

/** Партия — рейс с изделиями (задачи 2.1–2.6). */
export interface Batch {
  id: string;
  batchNo: string;
  direction: string;
  status: string;
  fromStoreId: string | null;
  fromStoreName: string | null;
  toStoreId: string | null;
  toStoreName: string | null;
  toWorkshopId: string | null;
  toWorkshopName: string | null;
  courierId: string | null;
  plannedAt: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
  itemsCount: number;
  comment: string | null;
  createdAt: string;
  transit: BatchTransitState;
}

/** Строка состава партии (задача 2.7). */
export interface BatchItem {
  orderId: string;
  orderNo: string;
  status: OrderStatus;
  customerName: string | null;
  totalAmountMinor: number;
  addedAt: string;
  addedById: string | null;
}

/** Партия с составом. */
export interface BatchDetail extends Batch {
  items: BatchItem[];
}
