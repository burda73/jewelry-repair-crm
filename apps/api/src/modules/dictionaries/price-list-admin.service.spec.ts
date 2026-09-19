/**
 * Редактирование прейскуранта (задачи 1.4.2–1.4.3).
 *
 * Проверяются правила, которые не видны в интерфейсе, но ломают деньги или
 * историю:
 *  * УТВЕРЖДЁННУЮ версию нельзя править — по ней уже посчитаны заказы;
 *  * утверждение архивирует предыдущую действующую версию: двух действующих
 *    прейскурантов быть не должно, иначе расчёт цены недетерминирован;
 *  * пустую версию нельзя отправить на утверждение — утверждать нечего;
 *  * номер новой версии выдаёт сервер, а не клиент: иначе два администратора
 *    получили бы один номер;
 *  * утверждение фиксирует автора подписи (`approvedById`) — это контрольная
 *    функция, и она должна быть именной;
 *  * ставки по металлам заменяются целиком: удалённая колонка не должна
 *    продолжать применяться.
 *
 * Prisma подменяется управляемым двойником: правила находятся в сервисе, и
 * проверять их через настоящую базу значило бы проверять поведение Postgres.
 */

import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PriceListStatus } from '@prisma/client';
import { PriceListAdminService } from './price-list-admin.service';
import { ROLE, DATA_SCOPE, PRICE_LIST_STATUS } from '@app/shared';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

const VERSION_ID = 'cmu5p70yu0000am7pzqlcawsv';
const ITEM_ID = 'cmu5p70yu0001bm7pzqlcawsw';
const STORE_ID = 'cmu5p70yu0002cm7pzqlcawsz';
const OTHER_STORE = 'cmu5p70yu0003dm7pzqlcawt0';
const CATEGORY_ID = 'cmu5p70yu0004em7pzqlcawt1';

const ADMIN: AuthenticatedUser = {
  id: 'cmu5p70yu0005fm7pzqlcawt2',
  email: 'admin@remixgold.ru',
  fullName: 'Администратор Системы',
  roles: [ROLE.ADMIN],
  primaryRole: ROLE.ADMIN,
  permissions: ['pricelist:edit', 'pricelist:approve'],
  scope: DATA_SCOPE.ALL_STORES,
  storeIds: [STORE_ID],
};

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    version: 1,
    storeId: STORE_ID,
    status: PriceListStatus.DRAFT,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    comment: null,
    approvedAt: null,
    rejectionReason: null,
    createdAt: new Date('2026-01-01'),
    store: { id: STORE_ID, code: 'MSK1', name: 'Тверская' },
    _count: { items: 0 },
    ...overrides,
  };
}

/**
 * Двойник Prisma.
 *
 * Транзакция «насквозь»: колбэк получает тот же объект. Проверять здесь
 * изоляцию транзакций значило бы проверять Postgres, а не правила сервиса.
 */
function createPrismaMock() {
  const mock = {
    priceListVersion: {
      findUnique: vi.fn().mockResolvedValue(versionRow()),
      findUniqueOrThrow: vi.fn().mockResolvedValue(versionRow()),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(versionRow()),
      update: vi.fn().mockResolvedValue(versionRow()),
    },
    priceListItem: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: ITEM_ID }),
      update: vi.fn().mockResolvedValue({ id: ITEM_ID, isActive: false, code: 'R-1' }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: ITEM_ID,
        code: 'R-1',
        name: 'Работа',
        priceMinor: 100,
        isActive: true,
      }),
      count: vi.fn().mockResolvedValue(1),
    },
    priceListItemRate: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    workCategory: { findUnique: vi.fn().mockResolvedValue({ id: CATEGORY_ID }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    ...mock,
    $transaction: (callback: (tx: typeof mock) => unknown) => callback(mock),
    /** Доступ к мокам для проверок — тем же объектом, что видит сервис. */
    _mock: mock,
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function makeService(prisma: PrismaMock): PriceListAdminService {
  return new PriceListAdminService(prisma as never);
}

describe('Прейскурант: создание версии', () => {
  it('номер версии выдаёт сервер, а не клиент', async () => {
    /*
     * Клиент номер не присылает. Иначе два администратора получили бы один
     * номер, и уникальное ограничение `[storeId, version]` отвергло бы второго
     * невнятной ошибкой Prisma.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findFirst.mockResolvedValue({ version: 4 });

    await makeService(prisma).createVersion(
      { storeId: STORE_ID, effectiveFrom: '2026-03-01' },
      ADMIN,
    );

    const args = prisma._mock.priceListVersion.create.mock.calls[0]?.[0];
    expect(args.data.version).toBe(5);
    expect(args.data.status).toBe(PriceListStatus.DRAFT);
  });

  it('новая версия создаётся черновиком', async () => {
    // Создать сразу утверждённую версию значило бы обойти подпись.
    const prisma = createPrismaMock();
    await makeService(prisma).createVersion({ effectiveFrom: '2026-03-01' }, ADMIN);
    const args = prisma._mock.priceListVersion.create.mock.calls[0]?.[0];
    expect(args.data.status).toBe(PriceListStatus.DRAFT);
  });

  it('запись попадает в журнал аудита', async () => {
    // ТЗ п. 4: каждое изменение справочника оставляет след.
    const prisma = createPrismaMock();
    await makeService(prisma).createVersion({ effectiveFrom: '2026-03-01' }, ADMIN);
    expect(prisma._mock.auditLog.create).toHaveBeenCalledTimes(1);
    const args = prisma._mock.auditLog.create.mock.calls[0]?.[0];
    expect(args.data.entity).toBe('PriceListVersion');
    expect(args.data.action).toBe('CREATE');
  });
});

describe('Прейскурант: запрет правки утверждённой версии', () => {
  it('УТВЕРЖДЁННУЮ версию нельзя править', async () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА ЗАДАЧИ 1.4.3. По утверждённому прейскуранту посчитаны
     * заказы, и правка цены задним числом сделала бы историю недостоверной —
     * причём незаметно, ведь суммы в заказах хранятся копией.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.APPROVED }),
    );

    await expect(
      makeService(prisma).updateVersion(VERSION_ID, { comment: 'правка' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'PRICE_LIST_APPROVED_IMMUTABLE' } });
  });

  it('в отказе объясняется, что делать дальше', async () => {
    /*
     * Код ошибки — для программы, текст — для человека. «Нельзя» без объяснения
     * заставляет звонить в поддержку, хотя выход очевиден: создать новую версию.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.APPROVED }),
    );

    const rejection = await makeService(prisma)
      .updateVersion(VERSION_ID, { comment: 'правка' }, ADMIN)
      .catch((error: unknown) => error as { response?: { message?: string } });

    expect(rejection.response?.message ?? '').toMatch(/новую версию/i);
  });

  it('версию на утверждении править нельзя', async () => {
    // Иначе администратор менял бы цены под руками у утверждающего.
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.PENDING_APPROVAL }),
    );

    await expect(
      makeService(prisma).updateVersion(VERSION_ID, { comment: 'правка' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'PRICE_LIST_PENDING_APPROVAL' } });
  });

  it('архивную версию править нельзя', async () => {
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.ARCHIVED }),
    );

    await expect(
      makeService(prisma).updateVersion(VERSION_ID, { comment: 'правка' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'PRICE_LIST_ARCHIVED' } });
  });

  it('черновик править можно', async () => {
    const prisma = createPrismaMock();
    await makeService(prisma).updateVersion(VERSION_ID, { comment: 'правка' }, ADMIN);
    expect(prisma._mock.priceListVersion.update).toHaveBeenCalled();
  });

  it('ОТКЛОНЁННУЮ версию править можно', async () => {
    /*
     * Отклонение — это «исправьте и пришлите снова». Запрет правки заставлял бы
     * создавать версию с нуля, теряя набранные позиции.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.REJECTED }),
    );

    await makeService(prisma).updateVersion(VERSION_ID, { comment: 'исправлено' }, ADMIN);
    expect(prisma._mock.priceListVersion.update).toHaveBeenCalled();
  });

  it('утверждённую версию нельзя и отключить по позиции', async () => {
    // Позиция — часть документа: правка её состава меняет цены так же.
    const prisma = createPrismaMock();
    prisma._mock.priceListItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      code: 'R-1',
      priceList: { id: VERSION_ID, status: PriceListStatus.APPROVED },
    });

    await expect(makeService(prisma).deactivateItem(ITEM_ID, ADMIN)).rejects.toMatchObject({
      response: { code: 'PRICE_LIST_APPROVED_IMMUTABLE' },
    });
  });
});

describe('Прейскурант: утверждение', () => {
  it('утверждение архивирует предыдущую действующую версию', async () => {
    /*
     * Двух действующих прейскурантов быть не должно: `findActivePriceList` выбрал
     * бы между ними, и цена одного и того же заказа зависела бы от порядка
     * сортировки, а не от правил.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.PENDING_APPROVAL, version: 2 }),
    );
    prisma._mock.priceListVersion.findMany.mockResolvedValue([{ id: 'old-1', version: 1 }]);

    await makeService(prisma).applyAction(VERSION_ID, 'APPROVE', {}, ADMIN);

    const archived = prisma._mock.priceListVersion.update.mock.calls.find(
      (call) => (call[0] as { where: { id: string } }).where.id === 'old-1',
    );
    expect(archived).toBeDefined();
    expect((archived?.[0] as { data: { status: string } }).data.status).toBe(
      PriceListStatus.ARCHIVED,
    );
  });

  it('утверждение фиксирует автора подписи', async () => {
    /*
     * Подпись под ценами — контрольная функция. Обезличенное утверждение не
     * позволило бы выяснить, кто согласовал цены, при разборе расхождения.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.PENDING_APPROVAL }),
    );

    await makeService(prisma).applyAction(VERSION_ID, 'APPROVE', {}, ADMIN);

    const args = prisma._mock.priceListVersion.update.mock.calls[0]?.[0];
    expect(args.data.approvedById).toBe(ADMIN.id);
    expect(args.data.approvedAt).toBeInstanceOf(Date);
    expect(args.data.status).toBe(PriceListStatus.APPROVED);
  });

  it('нельзя утвердить версию, не отправленную на утверждение', async () => {
    // `DRAFT → APPROVED` напрямую означало бы подпись под тем, что не смотрели.
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.DRAFT }),
    );

    await expect(
      makeService(prisma).applyAction(VERSION_ID, 'APPROVE', {}, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('нельзя отправить пустую версию', async () => {
    /*
     * Утверждать нечего, а действующим стал бы прейскурант без работ: приём
     * перестал бы находить цены, и заказ нельзя было бы посчитать.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListItem.count.mockResolvedValue(0);

    await expect(
      makeService(prisma).applyAction(VERSION_ID, 'SUBMIT', {}, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'PRICE_LIST_EMPTY' } });
  });

  it('отправка переводит черновик в «на утверждении»', async () => {
    const prisma = createPrismaMock();
    await makeService(prisma).applyAction(VERSION_ID, 'SUBMIT', {}, ADMIN);
    const args = prisma._mock.priceListVersion.update.mock.calls[0]?.[0];
    expect(args.data.status).toBe(PriceListStatus.PENDING_APPROVAL);
  });

  it('отклонение требует причину', async () => {
    /*
     * Без причины администратор не знает, что исправлять, и отправляет ту же
     * версию повторно — отклонение превращается в переписку.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.PENDING_APPROVAL }),
    );

    await expect(
      makeService(prisma).applyAction(VERSION_ID, 'REJECT', {}, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('отклонение сохраняет причину и автор не теряется', async () => {
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.PENDING_APPROVAL }),
    );

    await makeService(prisma).applyAction(
      VERSION_ID,
      'REJECT',
      { reason: 'Цена полировки завышена' },
      ADMIN,
    );

    const args = prisma._mock.priceListVersion.update.mock.calls[0]?.[0];
    expect(args.data.status).toBe(PriceListStatus.REJECTED);
    expect(args.data.rejectionReason).toBe('Цена полировки завышена');
  });

  it('возврат в черновик сбрасывает подпись', async () => {
    /*
     * Иначе версия выглядела бы утверждённой тем же руководителем, который её и
     * вернул на доработку, — и повторная отправка выглядела бы как «уже
     * подписано».
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.PENDING_APPROVAL }),
    );

    await makeService(prisma).applyAction(VERSION_ID, 'RESTORE_TO_DRAFT', {}, ADMIN);

    const args = prisma._mock.priceListVersion.update.mock.calls[0]?.[0];
    expect(args.data.status).toBe(PriceListStatus.DRAFT);
    expect(args.data.approvedById).toBeNull();
    expect(args.data.approvedAt).toBeNull();
  });
});

describe('Прейскурант: копирование версии', () => {
  it('копия создаётся черновиком с новым номером', async () => {
    /*
     * Это и есть способ изменить утверждённые цены: правка запрещена, поэтому
     * цены меняют новой версией, начиная с уже набранных позиций.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.APPROVED, version: 3 }),
    );
    prisma._mock.priceListVersion.findFirst.mockResolvedValue({ version: 3 });
    prisma._mock.priceListVersion.findUniqueOrThrow.mockResolvedValue(versionRow({ version: 4 }));

    await makeService(prisma).applyAction(
      VERSION_ID,
      'COPY',
      { effectiveFrom: '2026-04-01' },
      ADMIN,
    );

    const args = prisma._mock.priceListVersion.create.mock.calls[0]?.[0];
    expect(args.data.version).toBe(4);
    expect(args.data.status).toBe(PriceListStatus.DRAFT);
  });

  it('копия переносит позиции со ставками по металлам', async () => {
    /*
     * Ставки по металлам — то, ради чего прейскурант и существует: без них
     * серебряный ремонт посчитался бы по золотому тарифу. Потерять их при
     * копировании значило бы начать новую версию с неверных цен.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.APPROVED }),
    );
    prisma._mock.priceListItem.findMany.mockResolvedValue([
      {
        id: 'src-item',
        categoryId: CATEGORY_ID,
        code: 'R-1',
        name: 'Запайка',
        description: null,
        unit: 'шт',
        priceMinor: 90000,
        priceFrom: false,
        metalCostSeparate: false,
        costMinor: null,
        durationHours: null,
        warrantyMonths: 6,
        requiresPrepayment: false,
        isActive: true,
        rates: [
          { metal: 'GOLD', priceMinor: 90000, isFrom: false },
          { metal: 'SILVER', priceMinor: 45000, isFrom: false },
        ],
      },
    ]);

    await makeService(prisma).applyAction(
      VERSION_ID,
      'COPY',
      { effectiveFrom: '2026-04-01' },
      ADMIN,
    );

    const rates = prisma._mock.priceListItemRate.createMany.mock.calls[0]?.[0];
    expect(rates.data).toHaveLength(2);
    expect(rates.data.map((rate: { metal: string }) => rate.metal).sort()).toEqual([
      'GOLD',
      'SILVER',
    ]);
  });

  it('копирование без состава создаёт пустую версию', async () => {
    // Нужно, когда прейскурант собирают заново: переносить старые цены вредно.
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.APPROVED }),
    );

    await makeService(prisma).applyAction(
      VERSION_ID,
      'COPY',
      { effectiveFrom: '2026-04-01', withItems: false },
      ADMIN,
    );

    expect(prisma._mock.priceListItem.create).not.toHaveBeenCalled();
  });

  it('копировать черновик нельзя', async () => {
    // Черновик и так правится — копия была бы лишней записью.
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.DRAFT }),
    );

    await expect(
      makeService(prisma).applyAction(VERSION_ID, 'COPY', { effectiveFrom: '2026-04-01' }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('Прейскурант: позиции', () => {
  it('ставки по металлам заменяются целиком', async () => {
    /*
     * `deleteMany` + вставка, а не доливка. Доливка оставляла бы старую ставку
     * при удалении колонки из прейскуранта, и цена по удалённому металлу
     * продолжала бы применяться — незаметно, ведь колонки в интерфейсе уже нет.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      code: 'R-1',
      priceList: { id: VERSION_ID, status: PriceListStatus.DRAFT },
    });

    await makeService(prisma).updateItem(
      ITEM_ID,
      { rates: [{ metal: 'GOLD', priceMinor: 100000 }] },
      ADMIN,
    );

    expect(prisma._mock.priceListItemRate.deleteMany).toHaveBeenCalledWith({
      where: { itemId: ITEM_ID },
    });
    expect(prisma._mock.priceListItemRate.createMany).toHaveBeenCalled();
  });

  it('пропуск rates не трогает существующие ставки', async () => {
    /*
     * Иначе смена одного названия работы удаляла бы все цены по металлам:
     * `rates` не пришёл — значит «не менялось», а не «стало пусто».
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      code: 'R-1',
      priceList: { id: VERSION_ID, status: PriceListStatus.DRAFT },
    });

    await makeService(prisma).updateItem(ITEM_ID, { name: 'Новое название' }, ADMIN);

    expect(prisma._mock.priceListItemRate.deleteMany).not.toHaveBeenCalled();
  });

  it('пустой массив rates удаляет все ставки', async () => {
    // Это осознанное «цена одна для всех металлов», а не «ничего не пришло».
    const prisma = createPrismaMock();
    prisma._mock.priceListItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      code: 'R-1',
      priceList: { id: VERSION_ID, status: PriceListStatus.DRAFT },
    });

    await makeService(prisma).updateItem(ITEM_ID, { rates: [] }, ADMIN);

    expect(prisma._mock.priceListItemRate.deleteMany).toHaveBeenCalled();
    expect(prisma._mock.priceListItemRate.createMany).not.toHaveBeenCalled();
  });

  it('несуществующая категория отвергается с указанием поля', async () => {
    // Иначе администратор получил бы ошибку внешнего ключа вместо объяснения.
    const prisma = createPrismaMock();
    prisma._mock.workCategory.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).createItem(
        VERSION_ID,
        { code: 'R-9', name: 'Работа', priceMinor: 100, categoryId: CATEGORY_ID },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { details: { categoryId: expect.any(Array) } } });
  });

  it('дубль артикула даёт понятную ошибку, а не ошибку базы', async () => {
    /*
     * Нарушение уникального ограничения — 500 или невнятный текст Prisma.
     * Администратору нужно понять, что артикул занят в ЭТОЙ версии.
     */
    const prisma = createPrismaMock();
    const { Prisma } = await import('@prisma/client');
    prisma._mock.priceListItem.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      makeService(prisma).createItem(
        VERSION_ID,
        { code: 'R-1', name: 'Работа', priceMinor: 100 },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'CODE_TAKEN' } });
  });

  it('несуществующая версия даёт 404', async () => {
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(null);

    await expect(makeService(prisma).findVersion('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('версия чужого магазина не видна', async () => {
    /*
     * Отвечаем 404, а не 403: по коду ответа перебором выяснялось бы, какие
     * магазины существуют и какие у них есть версии прейскуранта.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ storeId: OTHER_STORE }),
    );

    await expect(
      makeService(prisma).updateVersion(VERSION_ID, { comment: 'правка' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Согласованность правил сервиса и домена', () => {
  it('сервис принимает ровно те действия, что описаны в домене', async () => {
    /*
     * Проверка на расхождение: домен задаёт переходы, а сервис их исполняет.
     * Добавив действие в домен и забыв в сервисе, получили бы кнопку в
     * интерфейсе, которая ничего не делает.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.DRAFT }),
    );

    // Для черновика домен разрешает только `EDIT` и `SUBMIT`.
    await expect(
      makeService(prisma).applyAction(VERSION_ID, 'APPROVE', {}, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'PRICE_LIST_ACTION_NOT_ALLOWED' } });
    await expect(
      makeService(prisma).applyAction(VERSION_ID, 'ARCHIVE', {}, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'PRICE_LIST_ACTION_NOT_ALLOWED' } });
    await expect(
      makeService(prisma).applyAction(VERSION_ID, 'COPY', { effectiveFrom: '2026-04-01' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'PRICE_LIST_ACTION_NOT_ALLOWED' } });
  });

  it('правка через действие EDIT не меняет статус, а сообщает о маршруте', async () => {
    /*
     * `EDIT` — не переход статуса. Если бы вызов дошёл до смены статуса, версия
     * получила бы статус `DRAFT` независимо от текущего — то есть утверждённую
     * можно было бы «починить» обратно в черновик одним запросом.
     */
    const prisma = createPrismaMock();
    prisma._mock.priceListVersion.findUnique.mockResolvedValue(
      versionRow({ status: PriceListStatus.DRAFT }),
    );

    await expect(
      makeService(prisma).applyAction(VERSION_ID, 'EDIT', {}, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
