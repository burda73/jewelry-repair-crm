/**
 * Схемы валидации (Zod). Используются и API (проверка входящих DTO),
 * и веб-интерфейсом (валидация форм) — правила ввода не дублируются.
 */

import { z } from 'zod';
import { ORDER_STATUS } from '../domain/order-status.js';
import { ROLE, DATA_SCOPE } from '../domain/roles.js';
import { DAY_MS } from '../utils/dates.js';
import { ALL_NORM_STAGES } from '../domain/order-status.js';

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
 * Отдельная схема, а не `customerSchema.partial()`, ради проверки «PATCH не
 * пустой» в конце: у `.partial()` её нет, и запрос `{}` прошёл бы, записав в
 * аудит «до» и «после» без изменений.
 *
 * Ранее здесь утверждалось, что `.partial()` подставил бы дефолт
 * `consentMarketing: z.boolean().default(false)` и молча сбросил бы юридически
 * значимое согласие (ТЗ п. 2.4). Это неверно: в Zod (проверено на 3.25)
 * `.partial()` не применяет дефолты к отсутствующим ключам, и
 * `customerSchema.partial().parse({ fullName, phone, consentCallRecording })`
 * возвращает объект БЕЗ `consentMarketing`. Согласие защищено самим
 * `.partial()`; отдельная схема нужна из-за пустого PATCH.
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

export const createBatchSchema = z
  .object({
    direction: z.enum(['TO_PRODUCTION', 'TO_STORE']),
    fromStoreId: z.string().cuid().optional(),
    toStoreId: z.string().cuid().optional(),
    toWorkshopId: z.string().cuid().optional(),
    courierId: z.string().cuid().nullable().optional(),
    plannedAt: z.coerce.date(),
    comment: z.string().max(1000).nullable().optional(),
    /*
     * Состав можно задать сразу при создании. Это не дублирование
     * `batchOrdersSchema`: партию часто создают из уже отобранных в интерфейсе
     * заказов, и два запроса вместо одного дали бы партию без состава, если
     * второй не дошёл.
     */
    orderIds: z.array(z.string().cuid()).max(500).optional(),
  })
  .strict()
  // Согласованность маршрута и направления: партия «в цех» без цеха или
  // «в магазин» без магазина выглядит допустимой, но её нельзя выполнить.
  .refine(
    (data) =>
      data.direction === 'TO_PRODUCTION'
        ? data.toWorkshopId !== undefined
        : data.toStoreId !== undefined,
    {
      message: 'Для партии в цех нужен цех, для партии в магазин — магазин назначения',
      path: ['toWorkshopId'],
    },
  )
  .refine(
    (data) =>
      data.direction !== 'TO_STORE' ||
      data.fromStoreId === undefined ||
      data.fromStoreId !== data.toStoreId,
    {
      message: 'Магазин отправления и назначения не могут совпадать',
      path: ['toStoreId'],
    },
  );

export const batchOrdersSchema = z.object({
  orderIds: z.array(z.string().cuid()).min(1, 'Выберите хотя бы один заказ').max(500),
});

/** Исключение заказа из партии: причина обязательна (docs/07 §8). */
export const removeBatchOrderSchema = z.object({
  reason: z.string().trim().min(3, 'Укажите причину').max(300),
});

/** Список партий: фильтры и keyset-пагинация — как у списка заказов. */
export const batchListQuerySchema = z
  .object({
    status: z
      .array(z.enum(['DRAFT', 'ACT_FORMED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED']))
      .optional(),
    direction: z.enum(['TO_PRODUCTION', 'TO_STORE']).optional(),
    fromStoreId: z.string().cuid().optional(),
    toWorkshopId: z.string().cuid().optional(),
    plannedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

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

/**
 * Правка учётной записи администратором.
 *
 * Пароль здесь НЕ меняется: для этого есть отдельный сценарий сброса
 * (`resetUserPasswordSchema`). Смешивать их нельзя — смена пароля завершает все
 * сессии пользователя, и правка, например, ФИО не должна разлогинивать человека.
 *
 * `.partial()` сохраняет правила полей, но делает их необязательными: правка
 * приходит только с теми полями, которые администратор действительно изменил.
 */
export const updateUserSchema = z
  .object({
    email: emailSchema,
    fullName: z.string().min(2, 'Укажите ФИО').max(200),
    phone: phoneSchema,
    isActive: z.boolean(),
    storeIds: z.array(z.string().cuid()),
  })
  .partial();

/**
 * Сброс пароля администратором.
 *
 * `mustChangePassword` по умолчанию `true`: пароль задаёт администратор, а не
 * владелец учётной записи, поэтому при первом входе система обязана потребовать
 * сменить его на известный только владельцу.
 */
export const resetUserPasswordSchema = z.object({
  newPassword: passwordSchema,
  mustChangePassword: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Справочники (задача 1.3.1)
// ---------------------------------------------------------------------------

/**
 * Код справочника (`MSK1`, `SOLDER`, `DIAMOND-S`).
 *
 * Только заглавные латинские буквы, цифры и дефис. Причина не в эстетике:
 * код магазина попадает в человекочитаемый номер заказа
 * (`MSK1-2609-000001`), а коды справочников — в прейскурант и в документы.
 * Строчные буквы и кириллица сделали бы эти строки неоднородными, а пробелы
 * и знаки пунктуации сломали бы поиск и сортировку.
 *
 * Дефис разрешён, но не в начале и не в конце: `-MSK` и `MSK-` читаются как
 * обрывок и мешают сортировке.
 */
export const dictionaryCodeSchema = z
  .string()
  .min(2, 'Код слишком короткий')
  .max(20, 'Код слишком длинный')
  .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'Код: заглавные латинские буквы, цифры и дефис');

/** Название записи справочника. */
const dictionaryNameSchema = z.string().min(2, 'Укажите название').max(200);

/** Часовой пояс магазина. */
const timezoneSchema = z.string().min(3).max(64);

export const createStoreSchema = z.object({
  code: dictionaryCodeSchema,
  name: dictionaryNameSchema,
  address: z.string().max(300).optional(),
  phone: phoneSchema.optional(),
  timezone: timezoneSchema.default('Europe/Moscow'),
});

/**
 * Изменение магазина.
 *
 * Отдельная схема, а не `createStoreSchema.partial()`, по двум причинам — обе
 * про различия в правилах, а не про значения по умолчанию:
 *
 *  * `address` и `phone` можно ОЧИСТИТЬ (`null`). В `createStoreSchema` они
 *    объявлены `.optional()`, то есть принимают отсутствие поля, но не `null`;
 *    `.partial()` это не меняет, и стереть адрес было бы невозможно;
 *  * `isActive` участвует только в изменении — при создании запись всегда
 *    активна.
 *
 * О значениях по умолчанию: `.partial()` в Zod **не** подставляет их для
 * отсутствующих ключей (проверено на zod 3.x), поэтому «правка названия не
 * переписывает часовой пояс» обеспечивается самим `.partial()` и дополнительной
 * схемы для этого не требует. Инвариант закреплён тестом
 * (`schemas-dictionaries.spec.ts`), чтобы дефолт не появился здесь явно.
 *
 * `code` в схеме ЕСТЬ, но проверку «у магазина уже есть заказы» выполняет
 * сервис: схеме неизвестно состояние базы, а код входит в номера заказов
 * (`MSK1-2609-000001`), и его смена после первого заказа сделала бы выданные
 * номера несоответствующими магазину.
 */
export const updateStoreSchema = z
  .object({
    code: dictionaryCodeSchema,
    name: dictionaryNameSchema,
    address: z.string().max(300).nullable(),
    phone: phoneSchema.nullable(),
    timezone: timezoneSchema,
    isActive: z.boolean(),
  })
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Укажите хотя бы одно поле для изменения',
  });

export const createWorkshopSchema = z.object({
  code: dictionaryCodeSchema,
  name: dictionaryNameSchema,
  address: z.string().max(300).optional(),
});

export const updateWorkshopSchema = z
  .object({
    code: dictionaryCodeSchema,
    name: dictionaryNameSchema,
    address: z.string().max(300).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Укажите хотя бы одно поле для изменения',
  });

export const createPerformerSchema = performerSchema;

/**
 * Изменение исполнителя.
 *
 * `workshopId` включён: ювелира могут перевести в другой цех. Проверять, что
 * новый цех существует, обязан сервис — схема не имеет доступа к базе.
 */
export const updatePerformerSchema = performerSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Укажите хотя бы одно поле для изменения',
  });

export const createWorkCategorySchema = z.object({
  code: dictionaryCodeSchema,
  name: dictionaryNameSchema,
  /**
   * Порядок вывода в интерфейсе. Ограничен разумным диапазоном: отрицательные
   * значения и тысячи не имеют смысла, а опечатка вроде `sortOrder: 100000`
   * отправила бы категорию в конец списка, и администратор не понял бы, почему
   * её не видно на месте.
   */
  sortOrder: z.number().int().min(0).max(999).default(0),
});

export const updateWorkCategorySchema = z
  .object({
    code: dictionaryCodeSchema,
    name: dictionaryNameSchema,
    sortOrder: z.number().int().min(0).max(999),
    isActive: z.boolean(),
  })
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Укажите хотя бы одно поле для изменения',
  });

/**
 * Тип камня.
 *
 * `priceMinor` — цена за единицу в копейках. Принимается целым неотрицательным
 * числом: тип камня участвует в расчёте заказа, и дробная цена в минорных
 * единицах означала бы, что где-то уже потеряна точность.
 */
export const createStoneTypeSchema = z.object({
  code: dictionaryCodeSchema,
  name: dictionaryNameSchema,
  unit: z.string().min(1).max(20).default('шт'),
  priceMinor: z.number().int().min(0),
});

export const updateStoneTypeSchema = z
  .object({
    code: dictionaryCodeSchema,
    name: dictionaryNameSchema,
    unit: z.string().min(1).max(20),
    priceMinor: z.number().int().min(0),
    isActive: z.boolean(),
  })
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Укажите хотя бы одно поле для изменения',
  });

// ---------------------------------------------------------------------------
// Рабочий календарь (задача 1.3.3)
// ---------------------------------------------------------------------------

/**
 * Дата календаря в формате YYYY-MM-DD.
 *
 * Принимается строка, а не `Date`: календарная дата не имеет времени, и
 * `z.coerce.date()` превратил бы «2027-01-01» в момент времени, который в
 * таймзоне западнее UTC станет 31 декабря. Формат проверяется по календарю,
 * а не только регуляркой, иначе «2027-02-31» прошло бы проверку и было бы
 * молча превращено в 3 марта.
 */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    // Обратное форматирование совпадёт с вводом только для существующей даты.
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Такой даты не существует');

/** Часы рабочего дня: 0 для выходного, иначе от 1 до 24. */
const workHoursSchema = z.number().int().min(0).max(24);

export const createCalendarDaySchema = z
  .object({
    date: calendarDateSchema,
    isWorkday: z.boolean(),
    hours: workHoursSchema.optional(),
    note: z.string().max(200).nullable().optional(),
  })
  // Согласованность часов и признака рабочего дня: «рабочий день 0 часов» и
  // «выходной 8 часов» одинаково бессмысленны, но по отдельности каждое поле
  // выглядит допустимым. Проверка здесь, а не в сервисе, чтобы правило было
  // одно и то же и в интерфейсе, и в API.
  .refine((data) => (data.isWorkday ? (data.hours ?? 8) > 0 : (data.hours ?? 0) === 0), {
    message: 'Рабочий день не может длиться 0 часов, а выходной — больше 0',
    path: ['hours'],
  });

export const updateCalendarDaySchema = z
  .object({
    date: calendarDateSchema,
    isWorkday: z.boolean(),
    hours: workHoursSchema,
    note: z.string().max(200).nullable(),
  })
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Укажите хотя бы одно поле для изменения',
  })
  // Часы проверяются только когда в запросе есть ОБА поля: если меняется лишь
  // `isWorkday`, часы берутся из существующей записи, и осуждать их здесь не за
  // что. Иначе смена «выходной → рабочий» требовала бы прислать часы, хотя
  // сервис и так подставит обычные 8.
  .refine(
    (data) =>
      data.isWorkday === undefined ||
      data.hours === undefined ||
      (data.isWorkday ? data.hours > 0 : data.hours === 0),
    {
      message: 'Рабочий день не может длиться 0 часов, а выходной — больше 0',
      path: ['hours'],
    },
  );

/**
 * Фильтр списка календаря.
 *
 * Период обязателен с ограничением длины: календарь за 10 лет — это ~3650 строк
 * в ответе, и запрос «весь календарь» без периода превратил бы экран
 * администратора в выгрузку всей таблицы.
 */
export const calendarQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
  })
  .refine((data) => data.from <= data.to, {
    message: 'Начало периода позже окончания',
    path: ['to'],
  })
  .refine(
    (data) =>
      (new Date(`${data.to}T00:00:00Z`).getTime() - new Date(`${data.from}T00:00:00Z`).getTime()) /
        DAY_MS <=
      366,
    { message: 'Период не может превышать год', path: ['to'] },
  );

// ---------------------------------------------------------------------------
// Нормативы этапов (задача 1.3.4, ТЗ п. 2.7)
// ---------------------------------------------------------------------------

/**
 * Этап, для которого задаётся норматив.
 *
 * Проверка по `ALL_NORM_STAGES`, а не по свободной строке: именно расхождение
 * словарей («DISPATCH» в справочнике против «QUEUED_FOR_DISPATCH» в расчёте)
 * было причиной дефекта, когда норматив не находился никогда.
 */
export const normStageSchema = z.enum([...ALL_NORM_STAGES] as [string, ...string[]]);

/** Единица измерения норматива. */
export const normUnitSchema = z.enum(['WORKHOUR', 'WORKDAY', 'CALENDAR_DAY']);

/**
 * Тип работ: `ANY` — общий норматив этапа, `SIMPLE`/`COMPLEX` — для конкретного.
 *
 * `ANY` вместо `null` намеренно (см. комментарий к модели `StageNorm`): NULL в
 * уникальном индексе PostgreSQL не обеспечивает уникальность, поэтому
 * `workType = null` допускал бы неограниченные дубли.
 */
export const normWorkTypeSchema = z.enum(['ANY', 'SIMPLE', 'COMPLEX']);

/**
 * Один норматив в составе версии.
 *
 * Верхняя граница `value` — не формальность: норматив попадает в расчёт срока
 * выдачи, и «500 рабочих дней» вместо «5» — это ошибка ввода, которую дешевле
 * отклонить, чем объяснять клиенту, почему заказ ждут два года.
 */
export const normEntrySchema = z.object({
  stage: normStageSchema,
  workType: normWorkTypeSchema.default('ANY'),
  value: z.number().int().min(1).max(365),
  unit: normUnitSchema,
  escalateToRole: z
    .enum(Object.values(ROLE) as [string, ...string[]])
    .nullable()
    .optional(),
});

/**
 * Создание новой версии нормативов.
 *
 * Версия — это ПОЛНЫЙ набор нормативов, а не отдельная правка. Причина в
 * уникальности `[version, stage, workType]`: набор версии должен быть
 * самодостаточным, иначе «какая версия сейчас действует» нельзя ответить, не
 * собирая её из нескольких версий. Так же устроен прейскурант.
 *
 * `changeReason` обязателен: норматив меняет сроки всех новых заказов, и по
 * журналу должно быть понятно, почему.
 */
export const createNormVersionSchema = z
  .object({
    norms: z.array(normEntrySchema).min(1, 'Добавьте хотя бы один норматив').max(64),
    changeReason: z.string().min(5, 'Опишите причину изменения').max(500),
    effectiveFrom: calendarDateSchema.optional(),
  })
  .refine(
    (data) => {
      // Дубликат (этап, тип работ) внутри одной версии нарушил бы уникальный
      // индекс и оставил бы неопределённым, какое значение применять.
      const keys = data.norms.map((n) => `${n.stage}|${n.workType}`);
      return new Set(keys).size === keys.length;
    },
    { message: 'Этап и тип работ повторяются в наборе', path: ['norms'] },
  )
  .refine(
    (data) => {
      // Для производства обязаны быть оба типа работ либо общий норматив:
      // иначе для одного из типов срок не найдётся и заказ останется без dueAt.
      const production = data.norms.filter((n) => n.stage === 'PRODUCTION');
      if (production.length === 0) return true;
      const types = new Set(production.map((n) => n.workType));
      return types.has('ANY') || (types.has('SIMPLE') && types.has('COMPLEX'));
    },
    {
      message: 'Для производства задайте общий норматив либо оба: SIMPLE и COMPLEX',
      path: ['norms'],
    },
  );

export type NormEntryInput = z.infer<typeof normEntrySchema>;
export type CreateNormVersionInput = z.infer<typeof createNormVersionSchema>;

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
export type AddBatchOrdersInput = z.infer<typeof batchOrdersSchema>;
export type RemoveBatchOrderInput = z.infer<typeof removeBatchOrderSchema>;
export type BatchListQueryInput = z.infer<typeof batchListQuerySchema>;
export type PerformerInput = z.infer<typeof performerSchema>;
export type AssignmentInput = z.infer<typeof assignmentSchema>;
export type PriceListItemInput = z.infer<typeof priceListItemSchema>;
export type WarrantyClaimInput = z.infer<typeof warrantyClaimSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type AssignRoleInput = z.infer<typeof assignRoleSchema>;
export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;
export type ReportQueryInput = z.infer<typeof reportQuerySchema>;

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
export type CreateWorkshopInput = z.infer<typeof createWorkshopSchema>;
export type UpdateWorkshopInput = z.infer<typeof updateWorkshopSchema>;
export type CreatePerformerInput = z.infer<typeof createPerformerSchema>;
export type UpdatePerformerInput = z.infer<typeof updatePerformerSchema>;
export type CreateWorkCategoryInput = z.infer<typeof createWorkCategorySchema>;
export type UpdateWorkCategoryInput = z.infer<typeof updateWorkCategorySchema>;
export type CreateStoneTypeInput = z.infer<typeof createStoneTypeSchema>;
export type UpdateStoneTypeInput = z.infer<typeof updateStoneTypeSchema>;

export type CalendarDateInput = z.infer<typeof calendarDateSchema>;
export type CreateCalendarDayInput = z.infer<typeof createCalendarDaySchema>;
export type UpdateCalendarDayInput = z.infer<typeof updateCalendarDaySchema>;
export type CalendarQueryInput = z.infer<typeof calendarQuerySchema>;
