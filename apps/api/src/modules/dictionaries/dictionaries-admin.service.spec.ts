/**
 * Тесты администрирования справочников (задача 1.3.1).
 *
 * Проверяются правила, которые схема валидации проверить не может, потому что
 * они зависят от состояния базы, — и которые при ошибке ломают работу:
 *  * удаления нет: «удаление» обязано быть отключением, иначе разорвётся связь
 *    с заказами и прейскурантом;
 *  * код магазина участвует в номере заказа, поэтому его смена запрещена,
 *    пока у магазина есть заказы;
 *  * нельзя отключить последний активный магазин — приём заказов остановится;
 *  * нельзя отключить магазин с активными сотрудниками, цех с активными
 *    исполнителями или незавершёнными заказами, исполнителя с незакрытыми
 *    назначениями: они «повиснут» без площадки или без ответственного;
 *  * каждый метод пишет запись в журнал в той же транзакции, что и изменение.
 *
 * Prisma подменяется управляемым двойником: правила живут в сервисе, и
 * проверять их через настоящую базу значило бы проверять поведение Postgres.
 * Двойник намеренно НЕ реализует `delete`: если сервис когда-нибудь начнёт
 * удалять записи, тест упадёт на обращении к отсутствующему методу.
 */

import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DictionariesAdminService } from './dictionaries-admin.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { DATA_SCOPE, ROLE } from '@app/shared';

/** Идентификаторы в формате cuid: схемы требуют `z.string().cuid()`. */
const ADMIN_ID = 'cmu4cpwbg000bdl0ubltmh740';
const STORE = 'cmu5p70yu0001bm7pzqlcawsw';
const WORKSHOP = 'cmu5p70yu0002cm7pzqlcawsz';
const PERFORMER = 'cmu5p70yu0003dm7pzqlcawt0';
const CATEGORY = 'cmu5p70yu0004em7pzqlcawt1';
const STONE = 'cmu5p70yu0005fm7pzqlcawt2';

const ADMIN: AuthenticatedUser = {
  id: ADMIN_ID,
  email: 'admin@remixgold.ru',
  fullName: 'Администратор Системы',
  roles: [ROLE.ADMIN],
  primaryRole: ROLE.ADMIN,
  permissions: ['settings:manage'],
  scope: DATA_SCOPE.ALL_STORES,
  storeIds: [],
  mustChangePassword: false,
};

const storeRow = (overrides: Record<string, unknown> = {}) => ({
  id: STORE,
  code: 'MSK1',
  name: 'Москва, Тверская',
  address: null,
  phone: null,
  timezone: 'Europe/Moscow',
  isActive: true,
  ...overrides,
});

const workshopRow = (overrides: Record<string, unknown> = {}) => ({
  id: WORKSHOP,
  code: 'CENTER',
  name: 'Центральный цех',
  address: null,
  isActive: true,
  ...overrides,
});

const performerRow = (overrides: Record<string, unknown> = {}) => ({
  id: PERFORMER,
  fullName: 'Иванов Иван Иванович',
  specialization: 'Пайка',
  grade: 'Сеньор',
  isActive: true,
  workshop: { id: WORKSHOP, code: 'CENTER', name: 'Центральный цех' },
  ...overrides,
});

const categoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: CATEGORY,
  code: 'SOLDER',
  name: 'Пайка',
  sortOrder: 1,
  isActive: true,
  ...overrides,
});

const stoneRow = (overrides: Record<string, unknown> = {}) => ({
  id: STONE,
  code: 'DIAMOND-S',
  name: 'Алмаз (мелкий)',
  unit: 'шт',
  priceMinor: 450000,
  isActive: true,
  ...overrides,
});

/**
 * Двойник PrismaService.
 *
 * `$transaction` выполняется сразу: сервис пишет изменение и запись журнала в
 * одной транзакции, и подмена транзакционности на проверяемое поведение не
 * влияет. Счётчики (`count`) по умолчанию нулевые — то есть «препятствий нет»;
 * тесты, проверяющие запрет, задают их явно.
 */
function createPrismaMock() {
  const tx = {
    store: { create: vi.fn(), update: vi.fn() },
    workshop: { create: vi.fn(), update: vi.fn() },
    performer: { create: vi.fn(), update: vi.fn() },
    workCategory: { create: vi.fn(), update: vi.fn() },
    stoneType: { create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  };

  const prisma = {
    store: {
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    workshop: { findUnique: vi.fn() },
    performer: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    workCategory: { findUnique: vi.fn() },
    stoneType: { findUnique: vi.fn() },
    priceListItem: { count: vi.fn().mockResolvedValue(0) },
    order: { count: vi.fn().mockResolvedValue(0) },
    orderAssignment: { count: vi.fn().mockResolvedValue(0) },
    userRole: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    _tx: tx,
  };

  return prisma;
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  return new DictionariesAdminService(prisma as never);
}

describe('DictionariesAdminService: магазины', () => {
  it('создаёт магазин и пишет в журнал в той же транзакции', async () => {
    const prisma = createPrismaMock();
    prisma._tx.store.create.mockResolvedValue(storeRow());

    const created = await makeService(prisma).createStore(
      { code: 'MSK1', name: 'Москва, Тверская' },
      ADMIN,
    );

    expect(created.code).toBe('MSK1');
    // Часовой пояс подставляется схемой, а не остаётся пустым.
    expect(prisma._tx.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ timezone: 'Europe/Moscow', address: null, phone: null }),
      }),
    );
    expect(prisma._tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      actorId: ADMIN_ID,
      action: 'CREATE',
      entity: 'Store',
      entityId: STORE,
    });
    // У создания нет «до»: иначе в журнале было бы пустое состояние, похожее
    // на реальное.
    expect(audit.before).toBe(Prisma.JsonNull);
  });

  it('превращает конфликт кода от базы в понятную ошибку', async () => {
    const prisma = createPrismaMock();
    prisma._tx.store.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.19.3',
      }),
    );

    await expect(
      makeService(prisma).createStore({ code: 'MSK1', name: 'Дубликат' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'CODE_TAKEN' } });
  });

  it('ЗАПРЕЩАЕТ менять код магазина, у которого есть заказы', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.order.count.mockResolvedValue(2);

    await expect(
      makeService(prisma).updateStore(STORE, { code: 'MSK9' }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);

    // Изменение не должно дойти до базы.
    expect(prisma._tx.store.update).not.toHaveBeenCalled();
  });

  it('разрешает менять код магазина без заказов', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.order.count.mockResolvedValue(0);
    prisma._tx.store.update.mockResolvedValue(storeRow({ code: 'MSK9' }));

    const updated = await makeService(prisma).updateStore(STORE, { code: 'MSK9' }, ADMIN);

    expect(updated.code).toBe('MSK9');
    expect(prisma._tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('ЗАПРЕЩАЕТ отключать единственный активный магазин', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.store.count.mockResolvedValue(0); // других активных нет

    await expect(
      makeService(prisma).updateStore(STORE, { isActive: false }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'LAST_ACTIVE_STORE' } });
  });

  it('ЗАПРЕЩАЕТ отключать магазин с активными сотрудниками', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.userRole.count.mockResolvedValue(3);

    await expect(
      makeService(prisma).updateStore(STORE, { isActive: false }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'STORE_HAS_ACTIVE_USERS' } });
  });

  it('отключает магазин, когда препятствий нет', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma._tx.store.update.mockResolvedValue(storeRow({ isActive: false }));

    const updated = await makeService(prisma).updateStore(STORE, { isActive: false }, ADMIN);

    expect(updated.isActive).toBe(false);
    // «До» и «после» обязаны различаться: иначе по журналу нельзя доказать,
    // что магазин был отключён.
    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.before).toMatchObject({ isActive: true });
    expect(audit.after).toMatchObject({ isActive: false });
  });

  it('НЕ проверяет препятствия, если запись уже отключена', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(storeRow({ isActive: false }));
    prisma._tx.store.update.mockResolvedValue(storeRow({ isActive: false, name: 'Новое имя' }));

    // Повторное `isActive: false` идемпотентно: требовать «другой активный
    // магазин» значило бы запретить правку названия у закрытой точки.
    await makeService(prisma).updateStore(STORE, { isActive: false, name: 'Новое имя' }, ADMIN);

    expect(prisma.userRole.count).not.toHaveBeenCalled();
    expect(prisma._tx.store.update).toHaveBeenCalled();
  });

  it('возвращает 404 на неизвестный магазин', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).updateStore(STORE, { name: 'Новое имя' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DictionariesAdminService: цеха', () => {
  it('ЗАПРЕЩАЕТ отключать цех с активными исполнителями', async () => {
    const prisma = createPrismaMock();
    prisma.workshop.findUnique.mockResolvedValue(workshopRow());
    prisma.performer.count.mockResolvedValue(2);

    await expect(
      makeService(prisma).updateWorkshop(WORKSHOP, { isActive: false }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'WORKSHOP_HAS_ACTIVE_PERFORMERS' } });
  });

  it('ЗАПРЕЩАЕТ отключать цех с незавершёнными заказами', async () => {
    const prisma = createPrismaMock();
    prisma.workshop.findUnique.mockResolvedValue(workshopRow());
    prisma.performer.count.mockResolvedValue(0);
    prisma.order.count.mockResolvedValue(4);

    await expect(
      makeService(prisma).updateWorkshop(WORKSHOP, { isActive: false }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'WORKSHOP_HAS_OPEN_ORDERS' } });
  });

  it('считает незавершёнными только заказы вне терминальных статусов', async () => {
    const prisma = createPrismaMock();
    prisma.workshop.findUnique.mockResolvedValue(workshopRow());
    prisma._tx.workshop.update.mockResolvedValue(workshopRow({ isActive: false }));

    await makeService(prisma).updateWorkshop(WORKSHOP, { isActive: false }, ADMIN);

    // Заказы в COMPLETED/REFUSED/CANCELLED не должны считаться препятствием:
    // иначе закрыть отработавший цех было бы невозможно.
    const where = prisma.order.count.mock.calls[0][0].where;
    expect(where.status.notIn).toEqual(
      expect.arrayContaining(['COMPLETED', 'REFUSED', 'CANCELLED']),
    );
  });
});

describe('DictionariesAdminService: исполнители', () => {
  it('ЗАПРЕЩАЕТ заводить исполнителя в отключённом цехе', async () => {
    const prisma = createPrismaMock();
    prisma.workshop.findUnique.mockResolvedValue(workshopRow({ isActive: false }));

    await expect(
      makeService(prisma).createPerformer({ workshopId: WORKSHOP, fullName: 'Петров Пётр' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'WORKSHOP_INACTIVE' } });

    expect(prisma._tx.performer.create).not.toHaveBeenCalled();
  });

  it('отдаёт ошибку валидации на несуществующий цех, а не падает по внешнему ключу', async () => {
    const prisma = createPrismaMock();
    prisma.workshop.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).createPerformer({ workshopId: WORKSHOP, fullName: 'Петров Пётр' }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ЗАПРЕЩАЕТ отключать исполнителя с незакрытыми назначениями', async () => {
    const prisma = createPrismaMock();
    prisma.performer.findUnique.mockResolvedValue(performerRow());
    prisma.orderAssignment.count.mockResolvedValue(1);

    await expect(
      makeService(prisma).updatePerformer(PERFORMER, { isActive: false }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'PERFORMER_HAS_OPEN_ASSIGNMENTS' } });
  });

  it('разрешает перевод исполнителя в другой цех', async () => {
    const prisma = createPrismaMock();
    const other = 'cmu5p70yu0006gm7pzqlcawt3';
    prisma.performer.findUnique.mockResolvedValue(performerRow());
    prisma.workshop.findUnique.mockResolvedValue(workshopRow({ id: other }));
    prisma._tx.performer.update.mockResolvedValue(
      performerRow({ workshop: { id: other, code: 'SOUTH', name: 'Южный цех' } }),
    );

    const updated = await makeService(prisma).updatePerformer(
      PERFORMER,
      { workshopId: other },
      ADMIN,
    );

    expect(updated.workshop.id).toBe(other);
  });
});

describe('DictionariesAdminService: категории работ', () => {
  it('ЗАПРЕЩАЕТ отключать категорию с активными работами прейскуранта', async () => {
    const prisma = createPrismaMock();
    prisma.workCategory.findUnique.mockResolvedValue(categoryRow());
    prisma.priceListItem.count.mockResolvedValue(7);

    await expect(
      makeService(prisma).updateWorkCategory(CATEGORY, { isActive: false }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'CATEGORY_HAS_ACTIVE_ITEMS' } });
  });

  it('меняет порядок сортировки без проверки препятствий', async () => {
    const prisma = createPrismaMock();
    prisma.workCategory.findUnique.mockResolvedValue(categoryRow());
    prisma._tx.workCategory.update.mockResolvedValue(categoryRow({ sortOrder: 9 }));

    const updated = await makeService(prisma).updateWorkCategory(CATEGORY, { sortOrder: 9 }, ADMIN);

    expect(updated.sortOrder).toBe(9);
    expect(prisma.priceListItem.count).not.toHaveBeenCalled();
  });
});

describe('DictionariesAdminService: типы камней', () => {
  it('меняет цену камня', async () => {
    const prisma = createPrismaMock();
    prisma.stoneType.findUnique.mockResolvedValue(stoneRow());
    prisma._tx.stoneType.update.mockResolvedValue(stoneRow({ priceMinor: 500000 }));

    const updated = await makeService(prisma).updateStoneType(STONE, { priceMinor: 500000 }, ADMIN);

    expect(updated.priceMinor).toBe(500000);
    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    // Цена попадает в журнал: изменение прайса камней должно быть объяснимо.
    expect(audit.before).toMatchObject({ priceMinor: 450000 });
    expect(audit.after).toMatchObject({ priceMinor: 500000 });
  });

  it('отклоняет дробную цену', async () => {
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).createStoneType(
        { code: 'TOPAZ', name: 'Топаз', priceMinor: 1234.56 },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma._tx.stoneType.create).not.toHaveBeenCalled();
  });
});

describe('DictionariesAdminService: общие правила', () => {
  it('отклоняет пустой PATCH', async () => {
    const prisma = createPrismaMock();

    await expect(makeService(prisma).updateStore(STORE, {}, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('отклоняет код со строчными буквами или пробелом', async () => {
    const prisma = createPrismaMock();

    for (const code of ['msk1', 'MSK 1', '-MSK', 'МСК1']) {
      await expect(
        makeService(prisma).createStore({ code, name: 'Проверка' }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    expect(prisma._tx.store.create).not.toHaveBeenCalled();
  });

  it('НЕ удаляет записи: двойник без delete остаётся нетронутым', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma._tx.store.update.mockResolvedValue(storeRow({ isActive: false }));

    await makeService(prisma).updateStore(STORE, { isActive: false }, ADMIN);

    // Ключевой инвариант задачи: удаление заменено отключением. Если сервис
    // когда-нибудь начнёт удалять, здесь появится обращение к отсутствующему
    // методу `delete` и тест упадёт.
    for (const model of Object.values(prisma._tx)) {
      expect(model).not.toHaveProperty('delete');
    }
  });

  it('не подставляет часовой пояс при изменении, если он не передан', async () => {
    const prisma = createPrismaMock();
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma._tx.store.update.mockResolvedValue(storeRow({ name: 'Новое имя' }));

    await makeService(prisma).updateStore(STORE, { name: 'Новое имя' }, ADMIN);

    const data = prisma._tx.store.update.mock.calls[0][0].data;
    // Правка названия не должна молча переписывать часовой пояс дефолтом
    // `createStoreSchema`.
    expect(data.timezone).toBeUndefined();
    expect(data.name).toBe('Новое имя');
  });
});
