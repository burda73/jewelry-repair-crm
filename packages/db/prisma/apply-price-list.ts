/**
 * Загрузить утверждённый прейскурант в существующую базу.
 *
 * Запуск: npx tsx packages/db/prisma/apply-price-list.ts
 *
 * Зачем отдельный скрипт, если есть `seed.ts`. `seed` заполняет ПУСТУЮ базу и
 * пропускает всё, что уже существует. В развёрнутой системе версия 1 уже
 * создана с демонстрационными ценами, и `seed` её не тронет — поэтому нужно
 * отдельное средство, которое заменяет содержимое версии.
 *
 * Что делает:
 *   1. находит версию 1 (или создаёт её, если базы ещё не касались);
 *   2. приводит её в `APPROVED` — иначе `GET /price-lists/active` вернёт
 *      `null` и мастер приёма не покажет ни одной работы;
 *   3. синхронизирует категории работ;
 *   4. ПОЛНОСТЬЮ заменяет позиции и их ставки по металлам на утверждённые.
 *
 * Безопасность повторного запуска: операция идемпотентна и её можно выполнять
 * сколько угодно раз — результат один и тот же. Позиции заменяются целиком
 * (`deleteMany` + вставка), а не доливаются: иначе при повторном запуске
 * возникали бы дубли артикулов или оставались позиции, которых уже нет в
 * документе.
 *
 * Про ссылки из уже принятых заказов. `OrderWork` хранит КОПИЮ цены и
 * названия (`docs/03-data-model.md` §3.3), поэтому удаление позиции
 * прейскуранта не меняет суммы в принятых заказах — юридически значимая
 * копия остаётся. Ссылка `priceListItemId` при этом обнуляется (связь
 * необязательная), теряется только аналитика «какие работы популярны» по
 * старым заказам.
 */

import { PrismaClient, PriceListStatus } from '@prisma/client';
import { METAL_KIND } from '@app/shared';
import { PRICE_LIST_CATEGORIES, PRICE_LIST_POSITIONS } from './price-list-spec.js';

const prisma = new PrismaClient();

/**
 * Вернуть демонстрационному заказу ссылку на действующий прейскурант.
 *
 * При замене позиций `priceListItemId` у работ обнуляется (связь необяза-
 * тельная, а позиция удалена). Суммы в заказах от этого не страдают —
 * `OrderWork` хранит копию цены, — но ссылка нужна, чтобы демонстрационный
 * заказ выглядел целостно и не показывал «работа вне прейскуранта».
 *
 * Обновляется только работа с кодом, которого больше нет в прейскуранте,
 * и только если нашлась позиция с тем же названием и ценой: подставлять
 * первую попавшуюся нельзя — это изменило бы смысл заказа.
 */
async function relinkDemoOrder(priceListId: string): Promise<void> {
  const works = await prisma.orderWork.findMany({
    where: { priceListItemId: null },
    select: { id: true, name: true, unitPriceMinor: true },
  });
  if (works.length === 0) return;

  for (const work of works) {
    const match = await prisma.priceListItem.findFirst({
      where: {
        priceListId,
        name: work.name,
        rates: { some: { priceMinor: work.unitPriceMinor } },
      },
      select: { id: true, code: true },
    });
    if (!match) {
      console.log(`  Работа «${work.name}» осталась без ссылки — позиции нет в прейскуранте`);
      continue;
    }
    await prisma.orderWork.update({
      where: { id: work.id },
      data: { priceListItemId: match.id, code: match.code },
    });
    console.log(`  Работа «${work.name}» привязана к ${match.code}`);
  }
}

async function main(): Promise<void> {
  // Роли — отдельная таблица `UserRole`; поле называется `role`, не `roleCode`.
  const admin = await prisma.user.findFirst({
    where: { roles: { some: { role: 'ADMIN' } } },
  });
  if (!admin) {
    throw new Error('Не найден пользователь с ролью ADMIN — некому приписать утверждение');
  }

  let version = await prisma.priceListVersion.findFirst({ where: { version: 1 } });

  if (!version) {
    version = await prisma.priceListVersion.create({
      data: {
        version: 1,
        status: PriceListStatus.APPROVED,
        effectiveFrom: new Date(),
        comment: 'Утверждённый прейскурант заказчика',
        createdById: admin.id,
        approvedById: admin.id,
        approvedAt: new Date(),
      },
    });
    console.log('Создана версия прейскуранта 1');
  } else {
    // Статус обязателен именно APPROVED: только утверждённую версию видит
    // мастер приёма, и только по ней работает проверка цены на сервере.
    version = await prisma.priceListVersion.update({
      where: { id: version.id },
      data: {
        status: PriceListStatus.APPROVED,
        approvedById: version.approvedById ?? admin.id,
        approvedAt: version.approvedAt ?? new Date(),
        comment: 'Утверждённый прейскурант заказчика',
      },
    });
    console.log(`Обновлена версия прейскуранта ${String(version.version)}`);
  }

  // Категории: upsert, чтобы не потерять уже проставленные связи.
  const categoryMap = new Map<string, string>();
  for (const category of PRICE_LIST_CATEGORIES) {
    const created = await prisma.workCategory.upsert({
      where: { code: category.code },
      update: { name: category.name, sortOrder: category.sortOrder },
      create: category,
    });
    categoryMap.set(category.code, created.id);
  }
  console.log(`Категорий: ${String(categoryMap.size)}`);

  // Полная замена позиций. Ставки уходят каскадом (`onDelete: Cascade`).
  const removed = await prisma.priceListItem.deleteMany({
    where: { priceListId: version.id },
  });
  console.log(`Удалено прежних позиций: ${String(removed.count)}`);

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

  const [items, rates] = await Promise.all([
    prisma.priceListItem.count({ where: { priceListId: version.id } }),
    prisma.priceListItemRate.count({
      where: { item: { priceListId: version.id } },
    }),
  ]);
  console.log(`Позиций: ${String(items)}, ставок по металлам: ${String(rates)}`);

  /*
   * Удаляем категории, которых нет в утверждённом прейскуранте и на которые
   * не ссылается ни одна позиция.
   *
   * Зачем: прошлая демонстрационная версия содержала категорию «Гравировка»,
   * которой в документе нет. После замены позиций она осталась бы пустой
   * строкой в фильтре мастера приёма — приёмщик выбирает её и видит пустой
   * список. Пустая категория выглядит как сбой, а не как «здесь ничего нет».
   *
   * Условие «нет ни одной позиции» обязательно: удалять категорию, на которую
   * ссылаются позиции, нельзя — это разорвало бы связь. Поэтому фильтр идёт
   * по обеим таблицам, а не только по списку кодов из спецификации.
   */
  const orphanCategories = await prisma.workCategory.findMany({
    where: {
      code: { notIn: PRICE_LIST_CATEGORIES.map((category) => category.code) },
      items: { none: {} },
    },
    select: { id: true, code: true },
  });
  if (orphanCategories.length > 0) {
    await prisma.workCategory.deleteMany({
      where: { id: { in: orphanCategories.map((category) => category.id) } },
    });
    console.log(
      `Удалено пустых категорий: ${String(orphanCategories.length)} ` +
        `(${orphanCategories.map((category) => category.code).join(', ')})`,
    );
  }

  await relinkDemoOrder(version.id);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
