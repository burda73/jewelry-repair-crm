/**
 * Схемы валидации (Zod). Используются и API (проверка входящих DTO),
 * и веб-интерфейсом (валидация форм) — правила ввода не дублируются.
 */

import { z } from 'zod';
import { ORDER_STATUS } from '../domain/order-status.js';
import { ROLE, DATA_SCOPE } from '../domain/roles.js';

/** Сумма в минорных единицах: целое, неотрицательное, в разумных границах. */
export const minorAmountSchema = z
  .number()
  .int('Сумма должна быть целым числом копеек')
  .min(0, 'Сумма не может быть отрицательной')
  .max(1_000_000_000_00, 'Сумма слишком велика');

export const positiveMinorAmountSchema = minorAmountSchema.refine(
  (v) => v > 0,
  'Сумма должна быть больше нуля',
);

/** Телефон: принимаем любой формат, нормализуем на сервере. */
export const phoneSchema = z
  .string()
  .min(5, 'Телефон слишком короткий')
  .max(25, 'Телефон слишком длинный')
  .refine((v) => v.replace(/\D/g, '').length >= 10, 'Укажите телефон полностью');

export const emailSchema = z.string().email('Некорректный email').toLowerCase();

/** Парольная политика: минимум 12 символов (docs/10-nfr-security.md §3.1). */
export const passwordSchema = z
  .string()
  .min(12, 'Пароль должен содержать минимум 12 символов')
  .max(128, 'Пароль слишком длинный')
  .refine((v) => /[a-z]/.test(v), 'Пароль должен содержать строчную букву')
  .refine((v) => /[A-Z]/.test(v), 'Пароль должен содержать заглавную букву')
  .refine((v) => /\d/.test(v), 'Пароль должен содержать цифру');

// ---------------------------------------------------------------------------
// Аутентификация
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Введите пароль'),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Введите текущий пароль'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Пароли не совпадают',
    path: ['confirmPassword'],
  });

// ---------------------------------------------------------------------------
// Клиент
// ---------------------------------------------------------------------------

export const customerSchema = z.object({
  fullName: z.string().min(2, 'Укажите ФИО').max(200),
  phone: phoneSchema,
  email: emailSchema.optional().or(z.literal('')),
  birthDate: z.coerce.date().optional(),
  /** ТЗ п. 2.4: обязательный пункт заявки о записи разговоров. */
  consentCallRecording: z.boolean(),
  consentMarketing: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});

/**
 * Изменение данных клиента.
 *
 * Отдельная схема, а не `customerSchema.partial()`. Причина в дефолте
 * `consentMarketing: z.boolean().default(false)`: при `.partial()` он
 * подставился бы в любом PATCH без этого поля, то есть молча сбрасывал бы
 * юридически значимое согласие (ТЗ п. 2.4). Здесь каждое поле по-настоящему
 * необязательно, и «не передано» остаётся отличимым от «передано `false`».
 *
 * Телефон меняется реже ФИО, но допускается: мастер мог ошибиться при вводе.
 * Нормализация и проверка на дубликат для него — те же, что при создании
 * (customers.service).
 */
export const updateCustomerSchema = z
  .object({
    fullName: z.string().min(2, 'Укажите ФИО').max(200).optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.optional().or(z.literal('')),
    notes: z.string().max(2000).optional(),
    consentCallRecording: z.boolean().optional(),
    consentMarketing: z.boolean().optional(),
  })
  // Пустой PATCH бессмысленен: он записал бы в аудит «до» и «после» без
  // изменений и засорил бы след юридически значимых согласий.
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Укажите хотя бы одно поле для изменения',
  });

// ---------------------------------------------------------------------------
// Изделие
// ---------------------------------------------------------------------------

export const itemSchema = z.object({
  name: z.string().min(2, 'Укажите наименование изделия').max(200),
  metal: z.string().max(50).optional(),
  weightGram: z.number().positive('Вес должен быть больше нуля').max(10_000).optional(),
  size: z.string().max(30).optional(),
  hallmark: z.string().max(50).optional(),
  defects: z.string().max(2000).optional(),
  completeness: z.string().max(500).optional(),
  inventoryNo: z.string().max(50).optional(),
});

// ---------------------------------------------------------------------------
// Калькуляция
// ---------------------------------------------------------------------------

export const orderWorkSchema = z.object({
  itemId: z.string().cuid().optional(),
  /**
   * Индекс изделия, к которому относится работа (в массиве `items`).
   *
   * Нужен для выбора цены: прейскурант задаёт отдельную цену по золоту и по
   * серебру, поэтому цена работы зависит от металла КОНКРЕТНОГО изделия.
   * Без этого индекса все работы привязывались бы к первому изделию, и в
   * заказе из золотого кольца и серебряной цепочки серебряная работа была бы
   * посчитана по золотому тарифу. По умолчанию 0 — обычный случай, когда
   * изделие в заказе одно.
   */
  itemIndex: z.number().int().min(0).max(50).default(0),
  priceListItemId: z.string().cuid().optional(),
  code: z.string().min(1).max(50),
  name: z.string().min(2, 'Укажите название работы').max(200),
  quantity: z.number().positive('Количество должно быть больше нуля').max(10_000).default(1),
  unit: z.string().max(20).default('шт'),
  unitPriceMinor: minorAmountSchema,
  durationHours: z.number().int().min(0).max(1000).optional(),
  warrantyMonths: z.number().int().min(0).max(60).default(6),
  isCustom: z.boolean().default(false),
  comment: z.string().max(1000).optional(),
});

export const orderStoneSchema = z.object({
  itemId: z.string().cuid().optional(),
  /** Индекс изделия, к которому относится камень (см. `orderWorkSchema.itemIndex`). */
  itemIndex: z.number().int().min(0).max(50).default(0),
  stoneTypeId: z.string().cuid().optional(),
  name: z.string().min(1, 'Укажите название камня').max(200),
  quantity: z.number().int().positive().max(10_000).default(1),
  caratWeight: z.number().positive().max(10_000).optional(),
  unitPriceMinor: minorAmountSchema,
  comment: z.string().max(1000).optional(),
});

/** Корректировка с обязательной причиной (ТЗ п. 2.3). */
export const calcAdjustmentSchema = z.object({
  targetType: z.enum(['WORK', 'STONE', 'TOTAL']),
  targetId: z.string().cuid().optional(),
  amountAfterMinor: minorAmountSchema,
  reason: z.string().min(3, 'Причина обязательна (минимум 3 символа)').max(1000),
});

// ---------------------------------------------------------------------------
// Заказ
// ---------------------------------------------------------------------------

export const createOrderSchema = z.object({
  customerId: z.string().cuid().optional(),
  customer: customerSchema.optional(),
  createdStoreId: z.string().cuid(),
  pickupStoreId: z.string().cuid(),
  workshopId: z.string().cuid().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  description: z.string().max(4000).optional(),
  requiresPrepayment: z.boolean().default(false),
  prepaymentRequiredMinor: minorAmountSchema.default(0),
  discountMinor: minorAmountSchema.default(0),
  items: z.array(itemSchema).min(1, 'Добавьте хотя бы одно изделие'),
  works: z.array(orderWorkSchema).default([]),
  stones: z.array(orderStoneSchema).default([]),
  isWarranty: z.boolean().default(false),
  parentOrderId: z.string().cuid().optional(),
});

export const updateOrderSchema = z.object({
  version: z.number().int().nonnegative(),
  pickupStoreId: z.string().cuid().optional(),
  workshopId: z.string().cuid().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  description: z.string().max(4000).optional(),
  diagnosis: z.string().max(4000).optional(),
  requiresPrepayment: z.boolean().optional(),
  prepaymentRequiredMinor: minorAmountSchema.optional(),
  discountMinor: minorAmountSchema.optional(),
  productionManagerId: z.string().cuid().optional(),
});

/** Переход статуса (ТЗ п. 2.7: сроки и эскалации). */
export const transitionSchema = z.object({
  to: z.enum(Object.values(ORDER_STATUS) as [string, ...string[]]),
  version: z.number().int().nonnegative(),
  reason: z.string().max(1000).optional(),
  payload: z.record(z.unknown()).optional(),
});

export const cancelOrderSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().min(3, 'Укажите причину отмены').max(1000),
});

// ---------------------------------------------------------------------------
// Согласования (ТЗ п. 2.4)
// ---------------------------------------------------------------------------

export const approvalSchema = z
  .object({
    channel: z.enum(['IN_PERSON', 'PHONE_VERBAL', 'SMS', 'MESSENGER', 'EMAIL']),
    result: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'NO_ANSWER', 'CHANGED']).default('PENDING'),
    amountMinor: minorAmountSchema,
    termDays: z.number().int().min(0).max(365).optional(),
    promisedAt: z.coerce.date().optional(),
    comment: z.string().max(2000).optional(),
  })
  .refine(
    (data) =>
      data.channel !== 'PHONE_VERBAL' || data.result !== 'APPROVED' || data.termDays !== undefined,
    {
      message: 'Для устного согласия укажите согласованный срок',
      path: ['termDays'],
    },
  );

// ---------------------------------------------------------------------------
// Платежи (ТЗ п. 2.5, 2.8)
// ---------------------------------------------------------------------------

export const paymentSchema = z.object({
  kind: z.enum(['PREPAYMENT', 'FINAL', 'ADDITIONAL', 'REFUND', 'REVERSAL']),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE']),
  amountMinor: positiveMinorAmountSchema,
  storeId: z.string().cuid(),
  receiptNo: z.string().max(50).optional(),
  kktShiftNo: z.string().max(50).optional(),
  paidAt: z.coerce.date(),
  comment: z.string().max(1000).optional(),
});

export const reversePaymentSchema = z.object({
  reason: z.string().min(3, 'Укажите причину сторно').max(1000),
});

// ---------------------------------------------------------------------------
// Логистика (ТЗ п. 2.6)
// ---------------------------------------------------------------------------

export const createBatchSchema = z.object({
  direction: z.enum(['TO_PRODUCTION', 'TO_STORE']),
  fromStoreId: z.string().cuid().optional(),
  toStoreId: z.string().cuid().optional(),
  toWorkshopId: z.string().cuid().optional(),
  courierId: z.string().cuid().optional(),
  plannedAt: z.coerce.date(),
  comment: z.string().max(1000).optional(),
});

export const batchOrdersSchema = z.object({
  orderIds: z.array(z.string().cuid()).min(1, 'Выберите хотя бы один заказ'),
});

// ---------------------------------------------------------------------------
// Производство
// ---------------------------------------------------------------------------

export const performerSchema = z.object({
  workshopId: z.string().cuid(),
  fullName: z.string().min(2, 'Укажите ФИО исполнителя').max(200),
  specialization: z.string().max(100).optional(),
  grade: z.string().max(50).optional(),
});

export const assignmentSchema = z.object({
  performerId: z.string().cuid(),
  plannedHours: z.number().int().min(0).max(1000).optional(),
  comment: z.string().max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Прейскурант (ТЗ п. 2.2)
// ---------------------------------------------------------------------------

/**
 * Ставка цены для одного металла (утверждённый прейскурант, колонки
 * «Золото»/«Серебро»).
 *
 * `isFrom` — признак «от» именно для этого металла: в прейскуранте встречаются
 * позиции, где для золота цена фиксированная, а для серебра — «от».
 */
export const priceListItemRateSchema = z.object({
  metal: z.enum(['GOLD', 'SILVER', 'PLATINUM']),
  priceMinor: minorAmountSchema,
  isFrom: z.boolean().default(false),
});

export const priceListItemSchema = z
  .object({
    categoryId: z.string().cuid().optional(),
    code: z.string().min(1, 'Укажите артикул').max(50),
    name: z.string().min(2, 'Укажите название работы').max(200),
    description: z.string().max(2000).optional(),
    unit: z.string().max(20).default('шт'),
    priceMinor: minorAmountSchema,
    /** Цена указана как «от» (минимальная) — 5 позиций в прейскуранте заказчика. */
    priceFrom: z.boolean().default(false),
    /**
     * Стоимость металла в цену не входит и считается отдельно — 4 позиции
     * («Изготовление замка коробка (стоимость металла считается отдельно)»).
     */
    metalCostSeparate: z.boolean().default(false),
    /** Ставки по металлам. Пустой массив — позиция с единственной ценой. */
    rates: z.array(priceListItemRateSchema).default([]),
    costMinor: minorAmountSchema.optional(),
    durationHours: z.number().int().min(0).max(1000).optional(),
    warrantyMonths: z.number().int().min(0).max(60).default(6),
    requiresPrepayment: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    /*
     * Дубль металла отклоняем здесь, а не отдаём нарушение уникального
     * ограничения БД: иначе пользователь получил бы 500 или невнятную
     * ошибку Prisma вместо указания на конкретную строку. Цена при дубле
     * недетерминирована — неизвестно, какую из двух ставок применять.
     */
    const seen = new Set<string>();
    value.rates.forEach((rate, index) => {
      if (seen.has(rate.metal)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rates', index, 'metal'],
          message: `Металл ${rate.metal} указан дважды`,
        });
      }
      seen.add(rate.metal);
    });
  });

export const createPriceListSchema = z.object({
  storeId: z.string().cuid().optional(),
  effectiveFrom: z.coerce.date(),
  comment: z.string().max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Гарантия и рекламация (ТЗ п. 2.9)
// ---------------------------------------------------------------------------

export const warrantyClaimSchema = z.object({
  reason: z.string().min(3, 'Опишите причину рекламации').max(4000),
  clientStatement: z.string().max(4000).optional(),
});

export const resolveClaimSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'RESOLVED_REPAIR', 'RESOLVED_REFUND', 'CLOSED']),
  resolution: z.string().min(3, 'Опишите решение').max(4000),
});

// ---------------------------------------------------------------------------
// Пользователи и роли
// ---------------------------------------------------------------------------

export const createUserSchema = z.object({
  email: emailSchema,
  fullName: z.string().min(2, 'Укажите ФИО').max(200),
  phone: phoneSchema.optional(),
  password: passwordSchema,
  roles: z
    .array(
      z.object({
        role: z.enum(Object.values(ROLE) as [string, ...string[]]),
        storeId: z.string().cuid().optional(),
        scope: z.enum(Object.values(DATA_SCOPE) as [string, ...string[]]).optional(),
      }),
    )
    .min(1, 'Назначьте хотя бы одну роль'),
  storeIds: z.array(z.string().cuid()).default([]),
});

export const assignRoleSchema = z.object({
  role: z.enum(Object.values(ROLE) as [string, ...string[]]),
  storeId: z.string().cuid().optional(),
  scope: z.enum(Object.values(DATA_SCOPE) as [string, ...string[]]).optional(),
});

// ---------------------------------------------------------------------------
// Отчёты
// ---------------------------------------------------------------------------

export const reportQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  storeId: z.array(z.string().cuid()).optional(),
  workshopId: z.array(z.string().cuid()).optional(),
  groupBy: z.enum(['day', 'week', 'month', 'store', 'stage', 'performer', 'workType']).optional(),
  format: z.enum(['json', 'xlsx', 'csv']).default('json'),
});

// ---------------------------------------------------------------------------
// Публичный доступ (задел под личный кабинет клиента, ответ на вопрос 2 ТЗ)
// ---------------------------------------------------------------------------

export const requestStatusCodeSchema = z.object({
  orderNo: z.string().min(3, 'Укажите номер заказа').max(50),
  phone: phoneSchema,
});

export const checkStatusSchema = z.object({
  orderNo: z.string().min(3).max(50),
  code: z
    .string()
    .length(4, 'Код состоит из 4 цифр')
    .regex(/^\d{4}$/, 'Код состоит из 4 цифр'),
});

// ---------------------------------------------------------------------------
// Типы, выведенные из схем
// ---------------------------------------------------------------------------

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CustomerInput = z.infer<typeof customerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ItemInput = z.infer<typeof itemSchema>;
export type OrderWorkInput = z.infer<typeof orderWorkSchema>;
export type OrderStoneInput = z.infer<typeof orderStoneSchema>;
export type CalcAdjustmentInput = z.infer<typeof calcAdjustmentSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type TransitionInput = z.infer<typeof transitionSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type ApprovalInput = z.infer<typeof approvalSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type CreateBatchInput = z.infer<typeof createBatchSchema>;
export type PerformerInput = z.infer<typeof performerSchema>;
export type AssignmentInput = z.infer<typeof assignmentSchema>;
export type PriceListItemInput = z.infer<typeof priceListItemSchema>;
export type WarrantyClaimInput = z.infer<typeof warrantyClaimSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type ReportQueryInput = z.infer<typeof reportQuerySchema>;
