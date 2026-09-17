/**
 * Начальные данные системы.
 *
 * Запуск: npm run db:seed
 *
 * Создаёт минимально необходимое для старта разработки:
 * справочники, нормативы этапов, версию прейскуранта, пользователей по ролям.
 *
 * ВАЖНО: это данные для разработки и демонстрации. Для продакшна пароли и
 * справочники заполняются заказчиком через интерфейс администратора.
 */

import { PrismaClient, RoleCode, DataScope, PriceListStatus, OrderStatus } from '@prisma/client';
import { hash } from 'argon2';
import { addWorkingDays, buildOrderQrPayload, METAL_KIND, type WorkingCalendar } from '@app/shared';
import { PRICE_LIST_CATEGORIES, PRICE_LIST_POSITIONS } from './price-list-spec.js';

const prisma = new PrismaClient();

/** Пароль для всех демонстрационных пользователей. ТОЛЬКО для dev-окружения. */
const DEMO_PASSWORD = 'DemoPassword123';

/** Простой календарь без праздников — только выходные. */
const calendar: WorkingCalendar = { overrides: new Map(), defaultHours: 8 };

async function hashDemoPassword(): Promise<string> {
  return hash(DEMO_PASSWORD, {
    type: 2, // argon2id
    memoryCost: 65536, // 64 МБ
    timeCost: 3,
    parallelism: 4,
  });
}

// ---------------------------------------------------------------------------
// Магазины и цеха
// ---------------------------------------------------------------------------

async function seedStores() {
  const stores = [
    { code: 'MSK1', name: 'Магазин на Тверской', address: 'Москва, ул. Тверская, 12', phone: '+74951234567' },
    { code: 'MSK2', name: 'Магазин в ТЦ «Афимолл»', address: 'Москва, Пресненская наб., 2', phone: '+74952345678' },
    { code: 'SPB1', name: 'Магазин на Невском', address: 'Санкт-Петербург, Невский пр., 88', phone: '+78123456789' },
  ];

  const result = [];
  for (const store of stores) {
    result.push(
      await prisma.store.upsert({
        where: { code: store.code },
        update: {},
        create: store,
      }),
    );
  }
  console.log(`  Магазинов: ${result.length}`);
  return result;
}

async function seedWorkshops() {
  const workshops = [
    { code: 'CENTER', name: 'Центральный цех', address: 'Москва, ул. Складочная, 1' },
    { code: 'SOUTH', name: 'Южный цех (закрепка)', address: 'Москва, Каширское ш., 24' },
  ];

  const result = [];
  for (const workshop of workshops) {
    result.push(
      await prisma.workshop.upsert({
        where: { code: workshop.code },
        update: {},
        create: workshop,
      }),
    );
  }
  console.log(`  Цехов: ${result.length}`);
  return result;
}

/** Исполнители производства — ювелиры. НЕ пользователи системы (решение заказчика). */
async function seedPerformers(workshopId: string) {
  const performers = [
    { fullName: 'Петров Пётр Петрович', specialization: 'пайка', grade: 'ювелир 5 разряда' },
    { fullName: 'Сидорова Анна Ивановна', specialization: 'закрепка', grade: 'ювелир 6 разряда' },
    { fullName: 'Кузнецов Дмитрий Олегович', specialization: 'полировка', grade: 'ювелир 4 разряда' },
  ];

  for (const performer of performers) {
    const existing = await prisma.performer.findFirst({
      where: { fullName: performer.fullName, workshopId },
    });
    if (!existing) {
      await prisma.performer.create({ data: { ...performer, workshopId } });
    }
  }
  console.log(`  Исполнителей производства: ${performers.length}`);
}

// ---------------------------------------------------------------------------
// Пользователи и роли
// ---------------------------------------------------------------------------

async function seedUsers(stores: { id: string; code: string }[]) {
  const passwordHash = await hashDemoPassword();
  const msk1 = stores.find((s) => s.code === 'MSK1')!;
  const msk2 = stores.find((s) => s.code === 'MSK2')!;

  const users: {
    email: string;
    fullName: string;
    phone: string;
    role: RoleCode;
    storeId?: string;
    scope: DataScope;
  }[] = [
    { email: 'admin@remixgold.ru', fullName: 'Администратор Системы', phone: '+79000000001', role: RoleCode.ADMIN, scope: DataScope.ALL_STORES },
    { email: 'manager@remixgold.ru', fullName: 'Руководитель Сети', phone: '+79000000002', role: RoleCode.MANAGER, scope: DataScope.ALL_STORES },
    { email: 'receiver1@remixgold.ru', fullName: 'Иванова Мария Сергеевна', phone: '+79000000003', role: RoleCode.RECEIVER, storeId: msk1.id, scope: DataScope.STORE_PLUS_GLOBAL_SEARCH },
    { email: 'receiver2@remixgold.ru', fullName: 'Смирнов Алексей Петрович', phone: '+79000000004', role: RoleCode.RECEIVER, storeId: msk2.id, scope: DataScope.STORE_PLUS_GLOBAL_SEARCH },
    // Менеджер обработки поступающих ремонтов — ответственный за приёмку и эксплуатацию (ответ A2).
    { email: 'production@remixgold.ru', fullName: 'Морозов Виктор Андреевич', phone: '+79000000005', role: RoleCode.PRODUCTION_MANAGER, scope: DataScope.PRODUCTION },
    { email: 'logist@remixgold.ru', fullName: 'Волков Игорь Николаевич', phone: '+79000000006', role: RoleCode.LOGISTICIAN, scope: DataScope.PRODUCTION },
    { email: 'cashier@remixgold.ru', fullName: 'Фёдорова Ольга Дмитриевна', phone: '+79000000007', role: RoleCode.CASHIER, storeId: msk1.id, scope: DataScope.STORE_PLUS_GLOBAL_SEARCH },
    { email: 'auditor@remixgold.ru', fullName: 'Аудитор Внешний', phone: '+79000000008', role: RoleCode.AUDITOR, scope: DataScope.READ_ALL },
    // Главный бухгалтер — соутверждает прейскурант (ответ A2).
    { email: 'accountant@remixgold.ru', fullName: 'Главный Бухгалтер Предприятия', phone: '+79000000009', role: RoleCode.CHIEF_ACCOUNTANT, scope: DataScope.ALL_STORES },
  ];

  for (const user of users) {
    const created = await prisma.user.upsert({
      where: { email: user.email },
      update: {},
      create: {
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        passwordHash,
        isActive: true,
      },
    });

    const existingRole = await prisma.userRole.findFirst({
      where: { userId: created.id, role: user.role, storeId: user.storeId ?? null },
    });
    if (!existingRole) {
      await prisma.userRole.create({
        data: { userId: created.id, role: user.role, storeId: user.storeId, scope: user.scope },
      });
    }

    if (user.storeId) {
      await prisma.userStore.upsert({
        where: { userId_storeId: { userId: created.id, storeId: user.storeId } },
        update: {},
        create: { userId: created.id, storeId: user.storeId, isDefault: true },
      });
    }
  }

  console.log(`  Пользователей: ${users.length} (пароль: ${DEMO_PASSWORD})`);
  return users.length;
}

// ---------------------------------------------------------------------------
// Рабочий календарь
// ---------------------------------------------------------------------------

async function seedWorkingCalendar() {
  // Заполняем текущий и следующий год: отмечаем выходные как нерабочие дни.
  // Праздники заказчик добавляет через интерфейс администратора.
  //
  // ВНИМАНИЕ: для общего календаря (storeId = null) нельзя использовать upsert
  // по составному ключу [storeId, date] — в PostgreSQL NULL не равен NULL,
  // и upsert создавал бы дубликат при каждом запуске. Поэтому ищем существующую
  // запись явно.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const daysToCreate = 548; // ~1.5 года

  const existingDates = new Set(
    (
      await prisma.workingCalendar.findMany({
        where: { storeId: null },
        select: { date: true },
      })
    ).map((row) => row.date.toISOString().slice(0, 10)),
  );

  const toCreate: { storeId: null; date: Date; isWorkday: boolean; hours: number }[] = [];

  for (let i = 0; i < daysToCreate; i += 1) {
    const date = new Date(start.getTime());
    date.setUTCDate(date.getUTCDate() + i);
    const key = date.toISOString().slice(0, 10);
    if (existingDates.has(key)) continue;

    const dayOfWeek = date.getUTCDay(); // 0 = вс, 6 = сб
    const isWorkday = dayOfWeek !== 0 && dayOfWeek !== 6;
    toCreate.push({ storeId: null, date, isWorkday, hours: isWorkday ? 8 : 0 });
  }

  if (toCreate.length > 0) {
    await prisma.workingCalendar.createMany({ data: toCreate, skipDuplicates: true });
  }
  console.log(`  Дней рабочего календаря добавлено: ${toCreate.length} (уже было: ${existingDates.size})`);
}

// ---------------------------------------------------------------------------
// Нормативы этапов (ТЗ п. 2.7)
//
// ВАЖНО: у заказчика утверждённых нормативов НЕТ (ответ A3,
// docs/00-decisions.md §6.11). Это СТАРТОВЫЕ значения на основе отраслевой
// практики; менеджер обработки поступающих ремонтов корректирует их по факту
// в первый месяц пилота через интерфейс, без участия разработчика.
//
// Изменение норматива не пересчитывает dueAt у уже начатых этапов —
// иначе отчётность по срокам станет недостоверной.
// ---------------------------------------------------------------------------

async function seedStageNorms() {
  const norms = [
    { stage: 'APPROVAL', workType: 'ANY', value: 3, unit: 'WORKDAY', escalateToRole: RoleCode.RECEIVER },
    { stage: 'PREPAYMENT', workType: 'ANY', value: 5, unit: 'WORKDAY', escalateToRole: RoleCode.RECEIVER },
    { stage: 'DISPATCH', workType: 'ANY', value: 24, unit: 'WORKHOUR', escalateToRole: RoleCode.PRODUCTION_MANAGER },
    { stage: 'DELIVERY_OUT', workType: 'ANY', value: 8, unit: 'WORKHOUR', escalateToRole: RoleCode.LOGISTICIAN },
    { stage: 'PRODUCTION', workType: 'SIMPLE', value: 5, unit: 'WORKDAY', escalateToRole: RoleCode.PRODUCTION_MANAGER },
    { stage: 'PRODUCTION', workType: 'COMPLEX', value: 15, unit: 'WORKDAY', escalateToRole: RoleCode.PRODUCTION_MANAGER },
    { stage: 'DELIVERY_IN', workType: 'ANY', value: 8, unit: 'WORKHOUR', escalateToRole: RoleCode.LOGISTICIAN },
    { stage: 'STORAGE', workType: 'ANY', value: 30, unit: 'CALENDAR_DAY', escalateToRole: RoleCode.RECEIVER },
    { stage: 'CLAIM', workType: 'ANY', value: 10, unit: 'WORKDAY', escalateToRole: RoleCode.PRODUCTION_MANAGER },
  ];

  const effectiveFrom = new Date();
  effectiveFrom.setUTCHours(0, 0, 0, 0);

  for (const norm of norms) {
    await prisma.stageNorm.upsert({
      where: { version_stage_workType: { version: 1, stage: norm.stage, workType: norm.workType } },
      update: {},
      create: { ...norm, version: 1, isActive: true, effectiveFrom },
    });
  }
  console.log(`  Нормативов этапов: ${norms.length}`);
}

// ---------------------------------------------------------------------------
// Прейскурант (ТЗ п. 2.2) — черновик версии 1
// ---------------------------------------------------------------------------

async function seedPriceList() {
  const existing = await prisma.priceListVersion.findFirst({ where: { version: 1 } });
  if (existing) {
    console.log('  Прейскурант версии 1 уже существует');
    return;
  }

  const admin = await prisma.user.findFirstOrThrow({
    where: { email: 'admin@remixgold.ru' },
  });

  /**
   * Демонстрационный прейскурант создаётся СРАЗУ утверждённым.
   *
   * Статус `DRAFT` здесь сделал бы систему неработоспособной «из коробки»:
   * расчёт заказа идёт только по утверждённым ценам, поэтому
   * `GET /price-lists/active` возвращал бы `null`, шаг «Работы» мастера приёма
   * не показывал бы ни одной позиции, а создать заказ можно было бы только
   * нетиповой работой. Смысл демо-данных — рабочий сквозной сценарий, поэтому
   * версия должна быть `APPROVED`.
   *
   * `approvedById`/`approvedAt` заполняются не для красоты: утверждённая
   * версия обязана иметь утвердившего, иначе аудит не ответит на вопрос «кто
   * согласовал эти цены». `createdById` указывает на администратора.
   */
  const version = await prisma.priceListVersion.create({
    data: {
      version: 1,
      status: PriceListStatus.APPROVED,
      effectiveFrom: new Date(),
      comment: 'Начальный прейскурант (демонстрационные данные)',
      createdById: admin.id,
      approvedById: admin.id,
      approvedAt: new Date(),
    },
  });

  // Категории и позиции — из утверждённого файла «Прейскурант Ремонт.docx».
  // Данные вынесены в `price-list-spec.ts`: это юридически значимые цены,
  // их сверяет с документом отдельный тест (`price-list-spec.spec.ts`).
  const categoryMap = new Map<string, string>();
  for (const category of PRICE_LIST_CATEGORIES) {
    const created = await prisma.workCategory.upsert({
      where: { code: category.code },
      update: { name: category.name, sortOrder: category.sortOrder },
      create: category,
    });
    categoryMap.set(category.code, created.id);
  }

  /*
   * Позиции создаются вместе со ставками по металлам.
   *
   * `priceMinor` (цена по умолчанию) берётся из ставки по золоту: золото —
   * самый частый металл в ремонте, и позиция без явного выбора металла
   * не должна показывать ноль. Значение всё равно перекрывается ставкой,
   * когда металл изделия распознан.
   */
  for (const position of PRICE_LIST_POSITIONS) {
    const goldRate = position.rates.find((rate) => rate.metal === METAL_KIND.GOLD);
    await prisma.priceListItem.create({
      data: {
        priceListId: version.id,
        categoryId: categoryMap.get(position.category),
        code: position.code,
        name: position.name,
        unit: position.unit,
        priceMinor: goldRate?.priceMinor ?? position.rates[0]?.priceMinor ?? 0,
        // Признаки «от» и «металл отдельно» обязательны: без них приёмщик
        // посчитает минимальную цену как итоговую, а работу с отдельным
        // металлом — как полную стоимость.
        priceFrom: position.rates.some((rate) => rate.isFrom),
        metalCostSeparate: position.metalCostSeparate,
        durationHours: position.durationHours,
        warrantyMonths: position.warrantyMonths,
        requiresPrepayment: position.requiresPrepayment,
        isActive: true,
        rates: {
          create: position.rates.map((rate) => ({
            metal: rate.metal,
            priceMinor: rate.priceMinor,
            isFrom: rate.isFrom,
          })),
        },
      },
    });
  }

  console.log(`  Позиций прейскуранта: ${PRICE_LIST_POSITIONS.length} (золото/серебро)`);


  const stoneTypes = [
    { code: 'CUBIC', name: 'Фианит', priceMinor: 30000 },
    { code: 'ZIRCON', name: 'Циркон', priceMinor: 50000 },
    { code: 'SAPPHIRE', name: 'Сапфир синтетический', priceMinor: 120000 },
    { code: 'RUBY', name: 'Рубин синтетический', priceMinor: 130000 },
    { code: 'DIAMOND-S', name: 'Бриллиант (мелкий)', priceMinor: 450000 },
  ];

  for (const stone of stoneTypes) {
    await prisma.stoneType.upsert({
      where: { code: stone.code },
      update: {},
      create: { ...stone, unit: 'шт', isActive: true },
    });
  }

  console.log(
    `  Прейскурант: версия 1, позиций ${PRICE_LIST_POSITIONS.length}, камней ${stoneTypes.length}`,
  );
}

// ---------------------------------------------------------------------------
// Шаблоны уведомлений
// ---------------------------------------------------------------------------

async function seedNotificationTemplates() {
  const templates = [
    { code: 'ORDER_ACCEPTED', subject: 'Заказ принят', body: 'Заказ {{orderNo}} принят в работу. Плановая готовность: {{dueDate}}.' },
    { code: 'APPROVAL_REQUEST', subject: 'Требуется согласование', body: 'Согласуйте стоимость ремонта по заказу {{orderNo}}: {{amount}}.' },
    { code: 'PREPAYMENT_RECEIVED', subject: 'Предоплата получена', body: 'Предоплата по заказу {{orderNo}} получена. Работы начаты.' },
    { code: 'READY_FOR_PICKUP', subject: 'Заказ готов', body: 'Заказ {{orderNo}} готов к выдаче в {{storeName}}.' },
    { code: 'UNCLAIMED_REMINDER', subject: 'Напоминание о заказе', body: 'Заказ {{orderNo}} ожидает вас более 30 дней.' },
    { code: 'WARRANTY_ISSUED', subject: 'Гарантия оформлена', body: 'Гарантия по заказу {{orderNo}} действует до {{warrantyUntil}}.' },
    { code: 'ORDER_OVERDUE', subject: 'Просрочка по заказу', body: 'Заказ {{orderNo}} просрочен на {{overdueDays}} дн. Этап: {{stage}}.' },
    { code: 'ESCALATION_MANAGER', subject: 'Эскалация: просрочка более 1 дня', body: 'Заказ {{orderNo}} просрочен более чем на рабочий день. Ответственный: {{responsible}}.' },
    { code: 'CLAIM_DEADLINE', subject: 'Срок рекламации', body: 'По рекламации {{claimNo}} истекает срок рассмотрения {{dueDate}}.' },
  ];

  for (const template of templates) {
    await prisma.notificationTemplate.upsert({
      where: { code: template.code },
      update: {},
      create: { ...template, channel: 'IN_APP', locale: 'ru', isActive: true },
    });
  }
  console.log(`  Шаблонов уведомлений: ${templates.length}`);
}

// ---------------------------------------------------------------------------
// Демонстрационный заказ — чтобы интерфейс было чем наполнять
// ---------------------------------------------------------------------------

async function seedDemoOrder() {
  const existing = await prisma.order.findFirst();
  if (existing) {
    console.log('  Заказы уже существуют — демо-заказ не создаётся');
    return;
  }

  const store = await prisma.store.findFirstOrThrow({ where: { code: 'MSK1' } });
  const workshop = await prisma.workshop.findFirstOrThrow({ where: { code: 'CENTER' } });
  const receiver = await prisma.user.findFirstOrThrow({ where: { email: 'receiver1@remixgold.ru' } });
  const priceList = await prisma.priceListVersion.findFirstOrThrow({ where: { version: 1 } });
  /*
   * Демо-заказ: запайка одного места излома цепи, браслета (позиция 1
   * прейскуранта) для золотого изделия. Цена берётся из СТАВКИ ПО ЗОЛОТУ,
   * а не из `priceMinor`: при пересмотре тарифов ставка — источник истины
   * для конкретного металла, и демо-данные должны повторять поведение API.
   */
  const work = await prisma.priceListItem.findFirstOrThrow({
    where: { priceListId: priceList.id, code: 'PRICE-1' },
    include: { rates: true },
  });
  const goldRate = work.rates.find((rate) => rate.metal === METAL_KIND.GOLD);
  if (!goldRate) {
    throw new Error('У позиции PRICE-1 нет ставки по золоту — прейскурант загружен неверно');
  }

  const customer = await prisma.customer.create({
    data: {
      fullName: 'Клиентов Иван Петрович',
      phone: '+7 916 123-45-67',
      phoneNormalized: '+79161234567',
      consentCallRecording: true,
    },
  });

  const order = await prisma.order.create({
    data: {
      orderNo: 'MSK1-2509-000001',
      // QR-код квитанции (ответ A4, docs/00-decisions.md §6.14). Генерируется
      // вместе с номером и не меняется при перепечати — иначе ранее напечатанные
      // квитанции перестанут считываться сканером.
      qrPayload: buildOrderQrPayload('MSK1-2509-000001'),
      status: OrderStatus.ACCEPTED,
      customerId: customer.id,
      createdStoreId: store.id,
      pickupStoreId: store.id,
      workshopId: workshop.id,
      createdById: receiver.id,
      worksTotalMinor: goldRate.priceMinor,
      totalAmountMinor: goldRate.priceMinor,
      requiresPrepayment: false,
      // Простая пайка — применяется норматив производства SIMPLE (5 дней),
      // а не общий. См. OrderWorkflowService.loadStageNorm.
      complexity: 'SIMPLE',
      acceptedAt: new Date(),
      dueAt: addWorkingDays(new Date(), 5, calendar),
      description: 'Разрыв шинки, требуется пайка',
      priceListVersionId: priceList.id,
      priceFixedAt: new Date(),
      items: {
        create: {
          name: 'Кольцо золото 585',
          metal: 'Au585',
          weightGram: 4.2,
          size: '17',
          defects: 'Разрыв шинки у основания',
          completeness: 'Без вставки',
          inventoryNo: 'Б-000123',
        },
      },
    },
    include: { items: true },
  });

  const item = order.items[0]!;
  await prisma.orderWork.create({
    data: {
      orderId: order.id,
      itemId: item.id,
      priceListItemId: work.id,
      code: work.code,
      name: work.name,
      quantity: 1,
      unit: 'шт',
      unitPriceMinor: goldRate.priceMinor,
      amountMinor: goldRate.priceMinor,
      durationHours: work.durationHours,
      warrantyMonths: work.warrantyMonths,
      createdById: receiver.id,
    },
  });

  await prisma.orderStatusHistory.create({
    data: {
      orderId: order.id,
      fromStatus: null,
      toStatus: OrderStatus.DRAFT,
      stage: 'INTAKE',
      changedById: receiver.id,
      reason: 'Заказ создан (демонстрационные данные)',
    },
  });

  await prisma.counter.upsert({
    where: { scope: `ORDER:MSK1:${new Date().getUTCFullYear()}` },
    update: { value: 1 },
    create: { scope: `ORDER:MSK1:${new Date().getUTCFullYear()}`, value: 1 },
  });

  console.log(`  Демо-заказ: ${order.orderNo}`);
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

async function main() {
  console.log('Наполнение базы начальными данными...\n');

  console.log('Справочники:');
  const stores = await seedStores();
  const workshops = await seedWorkshops();
  await seedPerformers(workshops[0]!.id);

  console.log('\nДоступ и правила:');
  await seedUsers(stores);
  await seedWorkingCalendar();
  await seedStageNorms();

  console.log('\nКоммерческие данные:');
  await seedPriceList();
  await seedNotificationTemplates();

  console.log('\nДемонстрационные данные:');
  await seedDemoOrder();

  console.log('\nГотово.');
  console.log('\nТестовые учётные записи (пароль одинаковый):');
  console.log(`  admin@remixgold.ru        — Администратор          | пароль: ${DEMO_PASSWORD}`);
  console.log(`  manager@remixgold.ru      — Руководитель           | пароль: ${DEMO_PASSWORD}`);
  console.log(`  accountant@remixgold.ru   — Главный бухгалтер      | пароль: ${DEMO_PASSWORD}`);
  console.log(`  receiver1@remixgold.ru    — Приёмщик (MSK1)        | пароль: ${DEMO_PASSWORD}`);
  console.log(`  receiver2@remixgold.ru    — Приёмщик (MSK2)        | пароль: ${DEMO_PASSWORD}`);
  console.log(`  production@remixgold.ru   — Менеджер производства  | пароль: ${DEMO_PASSWORD}`);
  console.log(`  logist@remixgold.ru       — Логист                | пароль: ${DEMO_PASSWORD}`);
  console.log(`  cashier@remixgold.ru      — Кассир (MSK1)          | пароль: ${DEMO_PASSWORD}`);
  console.log(`  auditor@remixgold.ru      — Наблюдатель (readonly) | пароль: ${DEMO_PASSWORD}`);
  console.log('\nВНИМАНИЕ: смените эти пароли перед любым использованием вне dev-окружения.');
}

main()
  .catch((error: unknown) => {
    console.error('Ошибка наполнения базы:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });