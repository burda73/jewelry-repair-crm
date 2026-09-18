/**
 * Тесты сервиса партий (задача 2.1, ТЗ п. 2.6).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Партия — это физическая перевозка изделий клиентов с актом
 * приёма-передачи. Проверяются правила, которые схема валидации проверить не
 * может, потому что они зависят от состояния базы:
 *
 *  * состав проверяется ЦЕЛИКОМ до первой записи: иначе половина заказов
 *    добавилась бы, а запрос завершился ошибкой, и логист не понял бы, что
 *    именно попало в партию;
 *  * заказ, уже лежащий в активной партии, отклоняется: иначе он уехал бы в
 *    двух партиях, и его статус перевели бы дважды;
 *  * заказ, исключённый из партии, можно вернуть — строка не удаляется, а
 *    помечается причиной, и повторное включение снимает отметку;
 *  * отменённая и принятая партии НЕ блокируют заказ: иначе после отмены рейса
 *    заказ навсегда остался бы «в партии», которой уже нет;
 *  * лимит состава не задан по умолчанию: включённый «на глазок» он
 *    блокировал бы работу точки (решение по задаче 2.1).
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса, а не
 * поведение Postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { BatchesService } from './batches.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { DATA_SCOPE, ROLE } from '@app/shared';

const LOGIST_ID = 'cmu4cpwbg000bdl0ubltmh740';
const BATCH_ID = 'cmu5p70yu0001bm7pzqlcawsw';
const STORE_MSK1 = 'cmu5p70yu0002bm7pzqlcawsw';
const STORE_SPB1 = 'cmu5p70yu0003bm7pzqlcawsw';
const WORKSHOP_1 = 'cmu5p70yu0004bm7pzqlcawsw';
const WORKSHOP_2 = 'cmu5p70yu0005bm7pzqlcawsw';
const ORDER_1 = 'cmu5p70yu0006bm7pzqlcawsw';
const ORDER_2 = 'cmu5p70yu0007bm7pzqlcawsw';

const LOGIST: AuthenticatedUser = {
  id: LOGIST_ID,
  email: 'logist@remixgold.ru',
  fullName: 'Логист',
  roles: [ROLE.LOGISTICIAN],
  primaryRole: ROLE.LOGISTICIAN,
  permissions: ['logistics:read', 'logistics:manage'],
  scope: DATA_SCOPE.PRODUCTION,
  storeIds: [],
  mustChangePassword: false,
};

/** Приёмщик: видит только партии своего магазина. */
const RECEIVER: AuthenticatedUser = {
  ...LOGIST,
  id: 'cmu4cpwbg000bdl0ubltmh741',
  roles: [ROLE.RECEIVER],
  primaryRole: ROLE.RECEIVER,
  scope: DATA_SCOPE.STORES,
  storeIds: [STORE_MSK1],
};

const batchRow = (overrides: Record<string, unknown> = {}) => ({
  id: BATCH_ID,
  batchNo: 'П-250916-004',
  direction: 'TO_PRODUCTION',
  status: 'DRAFT',
  fromStoreId: STORE_MSK1,
  toStoreId: null,
  toWorkshopId: WORKSHOP_1,
  courierId: null,
  plannedAt: new Date('2025-09-16T07:00:00Z'),
  dispatchedAt: null,
  receivedAt: null,
  itemsCount: 0,
  comment: null,
  createdById: LOGIST_ID,
  createdAt: new Date('2025-09-16T07:00:00Z'),
  updatedAt: new Date('2025-09-16T07:00:00Z'),
  fromStore: { name: 'Магазин на Тверской' },
  toStore: null,
  toWorkshop: { name: 'Центральный цех' },
  // `findOne` читает состав вместе с партией: без `items` двойник не
  // воспроизводит форму ответа Prisma и тест падает не на правиле сервиса.
  items: [],
  ...overrides,
});

const orderRow = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_1,
  orderNo: 'MSK1-2609-000001',
  status: 'QUEUED_FOR_DISPATCH',
  createdStoreId: STORE_MSK1,
  pickupStoreId: STORE_MSK1,
  workshopId: null,
  ...overrides,
});

/** Строки этой партии и строки других активных партий — задаются тестом отдельно. */
const prismaMock: {
  existingRows?: Array<{ orderId: string; removedAt: Date | null }>;
  otherBatchRows?: Array<{ orderId: string }>;
} = {};

function createPrismaMock() {
  prismaMock.existingRows = [];
  prismaMock.otherBatchRows = [];
  const tx = {
    batch: {
      create: vi.fn(async () => batchRow()),
      findFirst: vi.fn(async () => batchRow()),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
    },
    batchItem: {
      findUnique: vi.fn(async () => null),
      /*
       * К `batchItem` идут ДВА разных запроса, и двойник обязан их различать:
       *  * «заказы в других активных партиях» — в `where` есть
       *    `batch.id.not`;
       *  * «строки этой партии по списку заказов» — в `where` есть
       *    `orderId.in`.
       * Иначе один и тот же ответ попадал бы в обе проверки, и тест переставал
       * бы различать две разные причины отказа.
       */
      findMany: vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
        const where = (args.where ?? {}) as {
          orderId?: { in?: string[] };
          batch?: { id?: { not?: string } };
        };
        if (where.orderId?.in !== undefined) {
          return (prismaMock.existingRows ?? []).filter((row: { orderId: string }) =>
            where.orderId?.in?.includes(row.orderId),
          );
        }
        return prismaMock.otherBatchRows ?? [];
      }),
      count: vi.fn(async () => 0),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    order: {
      findMany: vi.fn(async () => [orderRow()]),
      findUnique: vi.fn(async () => ({ version: 1, status: 'QUEUED_FOR_DISPATCH' })),
    },
    batchAct: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'act-1', actNo: 'АПП-25-000001' })),
      update: vi.fn(),
    },
    batchPhoto: {
      create: vi.fn(async () => ({
        id: 'photo-1',
        batchId: BATCH_ID,
        caption: null,
        createdAt: new Date(),
      })),
      delete: vi.fn(async () => ({ id: 'photo-1' })),
    },
    counter: { upsert: vi.fn(async () => ({ value: 4 })) },
    setting: { findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn() },
    user: { findMany: vi.fn(async () => []) },
    // Идентификатор намеренно ОТЛИЧАЕТСЯ от `fileObject.id`: `pdfFileId`
    // ссылается на `Document`, и если подставить туда идентификатор файла,
    // тест обязан упасть.
    document: { create: vi.fn(async () => ({ id: 'doc-1' })) },
    fileObject: {
      create: vi.fn(async () => ({ id: 'file-1' })),
      delete: vi.fn(async () => ({ id: 'file-1' })),
    },
  };

  const prisma = {
    batch: {
      findFirst: vi.fn(async () => batchRow()),
      findMany: vi.fn(async () => []),
    },
    batchAct: { findFirst: vi.fn(async () => null) },
    batchItem: { findMany: vi.fn(async () => []) },
    batchPhoto: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({
        id: 'photo-1',
        batchId: BATCH_ID,
        caption: null,
        createdAt: new Date(),
      })),
      delete: vi.fn(async () => ({ id: 'photo-1' })),
    },
    order: { findMany: vi.fn(async () => []) },
    setting: { findUnique: vi.fn(async () => null) },
    runInTransaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    _tx: tx,
  };

  return prisma;
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  return new BatchesService(
    prisma as never,
    storageMock as never,
    actPdfMock as never,
    workflowMock as never,
    notificationsMock as never,
  );
}

/**
 * Перевод статуса подменяется: проверяются правила партии, а не таблица
 * переходов — она покрыта отдельно (`order-transitions.spec.ts` и
 * `order-workflow.service.spec.ts`). Здесь важно, ЧТО сервис партии передаёт в
 * переход: идентификатор заказа, целевой статус, актора и внешнюю транзакцию.
 */
const workflowMock = {
  transition: vi.fn(async () => ({ id: 'order-1' })),
  loadCalendar: vi.fn(async () => ({ days: [] })),
};

/**
 * Сервис уведомлений подменяется (задача 2.6): проверяется, ЧТО партия просит
 * сообщить и кому, а не формат письма — он покрыт в
 * `notifications.service.spec.ts`.
 */
const notificationsMock = {
  notifyByTemplate: vi.fn(async () => null),
};

/** Хранилище подменяется: проверяются правила сервиса, а не запись на диск. */
const storageMock = {
  saveRaw: vi.fn(async () => ({
    objectKey: 'batches/b1/act/file.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1234,
    checksum: 'abc',
  })),
  savePhoto: vi.fn(async () => ({
    objectKey: 'batches/b1/photo.jpg',
    thumbnailKey: 'batches/b1/photo-thumb.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 4321,
    checksum: 'def',
    width: 1600,
    height: 1200,
  })),
  read: vi.fn(async () => Buffer.from('image-bytes')),
  remove: vi.fn(async () => undefined),
};

/** PDF-сервис подменяется: содержание документа проверяется отдельным тестом. */
const actPdfMock = { buildActPdf: vi.fn(async () => Buffer.from('%PDF-1.4 test')) };

describe('BatchesService: создание партии', () => {
  it('номер партии берёт ПЛАНОВУЮ дату отправки, а не дату создания', async () => {
    /*
     * Партия формируется по графику (ТЗ п. 2.6): рейс на 16 сентября логист
     * планирует заранее. Номер `П-250916-…` означает «партия рейса 16
     * сентября»; номер по дате создания говорил бы о другом дне и не совпадал
     * бы ни с актом, ни с графиком курьера.
     *
     * Текущая дата в тесте заведомо другая — иначе проверка не отличала бы
     * плановую дату от момента создания.
     */
    const prisma = createPrismaMock();
    prisma._tx.counter.upsert.mockResolvedValue({ value: 4 });

    await makeService(prisma).create(
      {
        direction: 'TO_PRODUCTION',
        fromStoreId: STORE_MSK1,
        toWorkshopId: WORKSHOP_1,
        plannedAt: new Date('2025-09-16T07:00:00Z'),
      },
      LOGIST,
    );

    const counterCall = prisma._tx.counter.upsert.mock.calls[0]?.[0] as {
      where: { scope: string };
    };
    // Счётчик — на календарный день, привязанный к дате в номере.
    expect(counterCall.where.scope).toBe('BATCH:20250916');

    const createCall = prisma._tx.batch.create.mock.calls[0]?.[0] as {
      data: { batchNo: string };
    };
    expect(createCall.data.batchNo).toBe('П-250916-004');
  });

  it('22:00 UTC — уже следующие московские сутки', async () => {
    // Дефект 28: номер по UTC отставал на день для документов, созданных
    // после полуночи по Москве.
    const prisma = createPrismaMock();
    prisma._tx.counter.upsert.mockResolvedValue({ value: 1 });

    await makeService(prisma).create(
      {
        direction: 'TO_PRODUCTION',
        toWorkshopId: WORKSHOP_1,
        plannedAt: new Date('2025-09-16T22:00:00Z'),
      },
      LOGIST,
    );

    const createCall = prisma._tx.batch.create.mock.calls[0]?.[0] as {
      data: { batchNo: string };
    };
    expect(createCall.data.batchNo).toBe('П-250917-001');
  });

  it('без плановой даты берётся текущий момент', async () => {
    // Партия отправляется «сейчас»: номер должен соответствовать сегодняшнему
    // дню, а не быть пустым.
    const prisma = createPrismaMock();

    await makeService(prisma).create(
      { direction: 'TO_PRODUCTION', toWorkshopId: WORKSHOP_1, plannedAt: new Date() },
      LOGIST,
    );

    const createCall = prisma._tx.batch.create.mock.calls[0]?.[0] as {
      data: { batchNo: string };
    };
    expect(createCall.data.batchNo).toMatch(/^П-\d{6}-\d{3}$/);
  });

  it('счётчик инкрементируется, а не перезаписывается', async () => {
    // Иначе номер повторился бы, и уникальный индекс `batchNo` отклонил бы
    // вторую партию вместо понятной ошибки.
    const prisma = createPrismaMock();

    await makeService(prisma).create(
      { direction: 'TO_PRODUCTION', toWorkshopId: WORKSHOP_1, plannedAt: new Date() },
      LOGIST,
    );

    const call = prisma._tx.counter.upsert.mock.calls[0]?.[0] as {
      update: { value: { increment: number } };
    };
    expect(call.update.value.increment).toBe(1);
  });

  it('пишет партию в журнал аудита', async () => {
    const prisma = createPrismaMock();

    await makeService(prisma).create(
      { direction: 'TO_PRODUCTION', toWorkshopId: WORKSHOP_1, plannedAt: new Date() },
      LOGIST,
    );

    expect(prisma._tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('отклоняет партию в цех без цеха', async () => {
    // Партию нельзя выполнить: машине некуда ехать.
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).create({ direction: 'TO_PRODUCTION', plannedAt: new Date() }, LOGIST),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('отклоняет партию в магазин без магазина назначения', async () => {
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).create({ direction: 'TO_STORE', plannedAt: new Date() }, LOGIST),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('отклоняет партию, где магазин отправления и назначения совпадают', async () => {
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).create(
        {
          direction: 'TO_STORE',
          fromStoreId: STORE_MSK1,
          toStoreId: STORE_MSK1,
          plannedAt: new Date(),
        },
        LOGIST,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('BatchesService: состав партии', () => {
  it('добавляет подходящий заказ', async () => {
    const prisma = createPrismaMock();

    await makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST);

    expect(prisma._tx.batchItem.upsert).toHaveBeenCalledTimes(1);
    expect(prisma._tx.batch.update).toHaveBeenCalled();
  });

  it('НЕ пишет ничего, если хотя бы один заказ не подходит', async () => {
    /*
     * Ключевая проверка. Проверка идёт по всем заказам ДО первой записи: иначе
     * половина состава добавилась бы, а запрос завершился ошибкой, и логист не
     * понял бы, что именно попало в партию.
     */
    const prisma = createPrismaMock();
    prisma._tx.order.findMany.mockResolvedValue([
      orderRow({ id: ORDER_1 }),
      orderRow({ id: ORDER_2, status: 'ACCEPTED' }),
    ]);

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1, ORDER_2] }, LOGIST),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma._tx.batchItem.upsert).not.toHaveBeenCalled();
    expect(prisma._tx.batch.update).not.toHaveBeenCalled();
  });

  it('сообщает номер заказа в причине отказа', async () => {
    // «Заказ не подходит» без номера бесполезно: в партии десятки заказов.
    const prisma = createPrismaMock();
    prisma._tx.order.findMany.mockResolvedValue([orderRow({ status: 'ACCEPTED' })]);

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST),
    ).rejects.toThrow(/MSK1-2609-000001/);
  });

  it('отклоняет заказ, уже лежащий в активной партии', async () => {
    const prisma = createPrismaMock();
    prismaMock.otherBatchRows = [{ orderId: ORDER_1 }];

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('исключает саму партию из проверки «уже в партии»', async () => {
    // Иначе заказы, уже лежащие в этой партии, считались бы занятыми другой.
    const prisma = createPrismaMock();

    await makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST);

    const call = prisma._tx.batchItem.findMany.mock.calls[0]?.[0] as {
      where: { batch: { id?: { not: string } } };
    };
    expect(call.where.batch.id?.not).toBe(BATCH_ID);
  });

  it('НЕ начисляет счётчик за заказ, уже активный в этой партии', async () => {
    /*
     * Дефект, найденный сквозной проверкой на живом сервере: повторное
     * добавление заказа, который уже лежит в партии, не создавало новую строку
     * (уникальный ключ `(batchId, orderId)`), но счётчик всё равно рос. В партии
     * `П-250916-001` поле показывало 1 при 0 активных строках, и логист видел в
     * партии заказ, которого там нет.
     *
     * Двойник возвращает активную строку этой же партии: заказ уже в ней.
     */
    const prisma = createPrismaMock();
    prismaMock.existingRows = [{ orderId: ORDER_1, removedAt: null }];

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST),
    ).rejects.toBeInstanceOf(ConflictException);

    // Главное: счётчик не тронут.
    expect(prisma._tx.batch.update).not.toHaveBeenCalled();
    expect(prisma._tx.batchItem.upsert).not.toHaveBeenCalled();
  });

  it('начисляет счётчик только за возвращённый заказ', async () => {
    // Строка осталась от прежнего состава: заказ исключали и возвращают.
    // Начисление на 1 корректно — активных строк станет ровно на одну больше.
    const prisma = createPrismaMock();
    prismaMock.existingRows = [{ orderId: ORDER_1, removedAt: new Date() }];

    await makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST);

    const call = prisma._tx.batch.update.mock.calls[0]?.[0] as {
      data: { itemsCount: { increment: number } };
    };
    expect(call.data.itemsCount.increment).toBe(1);
  });

  it('повторное включение заказа снимает отметку об исключении', async () => {
    // Строка не удаляется, а помечается `removedAt`: уникальный ключ
    // (batchId, orderId) не даст вставить её второй раз.
    const prisma = createPrismaMock();

    await makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST);

    const call = prisma._tx.batchItem.upsert.mock.calls[0]?.[0] as {
      update: { removedAt: null };
    };
    expect(call.update.removedAt).toBeNull();
  });

  it('отклоняет повторяющиеся заказы в одном запросе', async () => {
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1, ORDER_1] }, LOGIST),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('отклоняет неизвестный заказ', async () => {
    const prisma = createPrismaMock();
    prisma._tx.order.findMany.mockResolvedValue([]);

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('пустой список заказов отклоняется схемой', async () => {
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [] }, LOGIST),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('BatchesService: лимит состава', () => {
  it('без настройки лимита партия не ограничена', async () => {
    // Лимит не задан ни в ТЗ, ни в документации: включённый «на глазок» он
    // блокировал бы работу точки.
    const prisma = createPrismaMock();
    prisma._tx.batchItem.count.mockResolvedValue(500);

    await makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST);

    expect(prisma._tx.batchItem.upsert).toHaveBeenCalled();
  });

  it('настроенный лимит соблюдается', async () => {
    const prisma = createPrismaMock();
    prisma._tx.setting.findUnique.mockResolvedValue({ key: 'logistics.batchMaxItems', value: 2 });
    prisma._tx.batchItem.count.mockResolvedValue(2);

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('настроенный лимит пропускает состав в пределах значения', async () => {
    const prisma = createPrismaMock();
    prisma._tx.setting.findUnique.mockResolvedValue({ key: 'logistics.batchMaxItems', value: 10 });
    prisma._tx.batchItem.count.mockResolvedValue(0);

    await makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST);

    expect(prisma._tx.batchItem.upsert).toHaveBeenCalled();
  });

  it('бессмысленное значение настройки не превращается в «нельзя ничего»', async () => {
    // Настройка есть, но значение мусорное: лимит не применяется, а не
    // блокирует работу. Иначе опечатка администратора остановила бы логистику.
    const prisma = createPrismaMock();
    prisma._tx.setting.findUnique.mockResolvedValue({ key: 'logistics.batchMaxItems', value: -5 });

    await makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST);

    expect(prisma._tx.batchItem.upsert).toHaveBeenCalled();
  });
});

describe('BatchesService: исключение заказа', () => {
  it('помечает строку причиной, а не удаляет её', async () => {
    // Состав входит в акт приёма-передачи: «куда делся заказ» должно быть
    // объяснимо после подписания.
    const prisma = createPrismaMock();
    prisma._tx.batchItem.findUnique.mockResolvedValue({ orderId: ORDER_1, removedAt: null });

    await makeService(prisma).removeOrder(
      BATCH_ID,
      ORDER_1,
      { reason: 'Изделие не готово' },
      LOGIST,
    );

    const call = prisma._tx.batchItem.update.mock.calls[0]?.[0] as {
      data: { removeReason: string; removedAt: Date };
    };
    expect(call.data.removeReason).toBe('Изделие не готово');
    expect(call.data.removedAt).toBeInstanceOf(Date);
  });

  it('уменьшает счётчик состава', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batchItem.findUnique.mockResolvedValue({ orderId: ORDER_1, removedAt: null });

    await makeService(prisma).removeOrder(
      BATCH_ID,
      ORDER_1,
      { reason: 'Изделие не готово' },
      LOGIST,
    );

    const call = prisma._tx.batch.update.mock.calls[0]?.[0] as {
      data: { itemsCount: { decrement: number } };
    };
    expect(call.data.itemsCount.decrement).toBe(1);
  });

  it('пишет причину в журнал аудита', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batchItem.findUnique.mockResolvedValue({ orderId: ORDER_1, removedAt: null });

    await makeService(prisma).removeOrder(
      BATCH_ID,
      ORDER_1,
      { reason: 'Изделие не готово' },
      LOGIST,
    );

    const call = prisma._tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { after: { reason: string } };
    };
    expect(call.data.after.reason).toBe('Изделие не готово');
  });

  it('отклоняет слишком короткую причину', async () => {
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).removeOrder(BATCH_ID, ORDER_1, { reason: 'ок' }, LOGIST),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('отклоняет заказ, которого нет в партии', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batchItem.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).removeOrder(BATCH_ID, ORDER_1, { reason: 'Изделие не готово' }, LOGIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('отклоняет повторное исключение того же заказа', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batchItem.findUnique.mockResolvedValue({ orderId: ORDER_1, removedAt: new Date() });

    await expect(
      makeService(prisma).removeOrder(BATCH_ID, ORDER_1, { reason: 'Изделие не готово' }, LOGIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BatchesService: область видимости', () => {
  it('логист видит все партии', async () => {
    const prisma = createPrismaMock();

    await makeService(prisma).list({ limit: 50 }, LOGIST);

    const call = prisma.batch.findMany.mock.calls[0]?.[0] as {
      where: { AND: unknown[] };
    };
    expect(call.where.AND[1]).toEqual({});
  });

  it('приёмщик видит только партии своих магазинов', async () => {
    // Иначе приёмщик одной точки видел бы рейсы всех магазинов сети.
    const prisma = createPrismaMock();

    await makeService(prisma).list({ limit: 50 }, RECEIVER);

    const call = prisma.batch.findMany.mock.calls[0]?.[0] as {
      where: { AND: Array<{ OR?: Array<{ fromStoreId?: { in: string[] } }> }> };
    };
    const scope = call.where.AND[1] as { OR: Array<{ fromStoreId?: { in: string[] } }> };
    expect(scope.OR[0]?.fromStoreId?.in).toEqual([STORE_MSK1]);
  });

  it('аудитор видит все партии, хотя его область не ALL_STORES', async () => {
    /*
     * Дефект, найденный сквозной проверкой: аудитор имеет право
     * `logistics:read` (docs/02 §4, «Логистика: партия, акт» — «Р»), но его
     * область — `READ_ALL`, а не `ALL_STORES`. Пока исключался только
     * `ALL_STORES`, аудитор получал пустой список: право на чтение без единой
     * доступной записи.
     */
    const prisma = createPrismaMock();
    const auditor = { ...RECEIVER, scope: 'READ_ALL' as const, storeIds: [] };

    await makeService(prisma).list({ limit: 50 }, auditor);

    const call = prisma.batch.findMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } };
    expect(call.where.AND[1]).toEqual({});
  });

  it('руководитель производства видит все партии', async () => {
    // Партия не привязана к статусу заказа: без общего обзора логист не смог бы
    // спланировать перевозку между точками.
    const prisma = createPrismaMock();
    const pm = { ...LOGIST, scope: 'PRODUCTION' as const, storeIds: [] };

    await makeService(prisma).list({ limit: 50 }, pm);

    const call = prisma.batch.findMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } };
    expect(call.where.AND[1]).toEqual({});
  });

  it('приёмщик без магазинов не видит ничего', async () => {
    // Роль без магазинов не должна видеть чужие рейсы: возвращать всё было бы
    // утечкой.
    const prisma = createPrismaMock();
    const orphan = { ...RECEIVER, storeIds: [] };

    await makeService(prisma).list({ limit: 50 }, orphan);

    const call = prisma.batch.findMany.mock.calls[0]?.[0] as {
      where: { AND: Array<{ id?: string }> };
    };
    expect(call.where.AND[1]).toEqual({ id: '__none__' });
  });

  it('не отдаёт партию вне области видимости', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(null);

    await expect(makeService(prisma).findOne(BATCH_ID, RECEIVER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('BatchesService: список', () => {
  it('фильтр по плановой дате сравнивается по московским суткам', async () => {
    /*
     * `plannedAt` хранится моментом, а рабочий день точки — московский. При
     * сравнении с началом суток UTC партия, назначенная на 1 октября 01:00 МСК,
     * попала бы в выборку за 30 сентября.
     */
    const prisma = createPrismaMock();

    await makeService(prisma).list({ limit: 50, plannedOn: '2025-10-01' }, LOGIST);

    const call = prisma.batch.findMany.mock.calls[0]?.[0] as {
      where: { AND: Array<{ plannedAt?: { gte: Date; lt: Date } }> };
    };
    const range = call.where.AND[0]?.plannedAt;
    expect(range?.gte.toISOString()).toBe('2025-09-30T21:00:00.000Z');
    expect(range?.lt.toISOString()).toBe('2025-10-01T21:00:00.000Z');
  });

  it('курсор указывает на следующую страницу', async () => {
    // Сортировка по `createdAt` неустойчива при совпадении времени: часть
    // партий могла бы выпасть между страницами.
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([
      batchRow({ id: 'b1' }),
      batchRow({ id: 'b2' }),
      batchRow({ id: 'b3' }),
    ]);

    const result = await makeService(prisma).list({ limit: 2 }, LOGIST);

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('b2');
  });

  it('последняя страница не содержит курсора', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: 'b1' })]);

    const result = await makeService(prisma).list({ limit: 2 }, LOGIST);

    expect(result.nextCursor).toBeNull();
  });

  it('одиночный статус в адресе приводится к массиву', async () => {
    // `?status=DRAFT` Express отдаёт строкой, а схема ждёт массив: без
    // приведения обычный фильтр не проходил бы проверку.
    const prisma = createPrismaMock();

    await makeService(prisma).list({ limit: '50', status: 'DRAFT' }, LOGIST);

    const call = prisma.batch.findMany.mock.calls[0]?.[0] as {
      where: { AND: Array<{ status?: { in: string[] } }> };
    };
    expect(call.where.AND[0]?.status?.in).toEqual(['DRAFT']);
  });

  it('слишком большой limit отклоняется', async () => {
    const prisma = createPrismaMock();

    await expect(makeService(prisma).list({ limit: 5000 }, LOGIST)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('BatchesService: кандидаты в состав', () => {
  it('берёт кандидатов по статусу, соответствующему направлению', async () => {
    // Показывать логисту заведомо неподходящие заказы значит заставлять его
    // читать длинный список отказов.
    const prisma = createPrismaMock();

    await makeService(prisma).candidates(BATCH_ID, LOGIST);

    const call = prisma.order.findMany.mock.calls[0]?.[0] as {
      where: { status: string };
    };
    expect(call.where.status).toBe('QUEUED_FOR_DISPATCH');
  });

  it('возвращает и подходящие, и отклонённые с причиной', async () => {
    const prisma = createPrismaMock();
    prisma.order.findMany.mockResolvedValue([
      orderRow({ id: ORDER_1, orderNo: 'MSK1-1' }),
      orderRow({ id: ORDER_2, orderNo: 'MSK1-2', workshopId: WORKSHOP_2 }),
    ]);

    const result = await makeService(prisma).candidates(BATCH_ID, LOGIST);

    expect(result.eligible.map((o) => o.orderNo)).toEqual(['MSK1-1']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe('WRONG_WORKSHOP');
    expect(result.rejected[0]?.message).toBeTruthy();
  });
});

describe('BatchesService: акт приёма-передачи (задача 2.2)', () => {
  /** Партия с одним заказом в составе — минимальный случай для акта. */
  const batchWithItems = (overrides: Record<string, unknown> = {}) =>
    batchRow({
      status: 'DRAFT',
      items: [
        {
          orderId: ORDER_1,
          addedAt: new Date('2025-09-16T07:00:00Z'),
          addedById: LOGIST_ID,
          order: {
            orderNo: 'MSK1-2609-000001',
            status: 'QUEUED_FOR_DISPATCH',
            totalAmountMinor: 15000,
            customer: { fullName: 'Иванов Иван Иванович' },
          },
        },
      ],
      ...overrides,
    });

  it('формирует акт с годовым номером и снимком состава', async () => {
    /*
     * Номер акта годовой (`АПП-25-000118`), в отличие от дневного номера
     * партии: так задан формат в docs/03 §2.
     */
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchWithItems());
    prisma._tx.counter.upsert.mockResolvedValue({ value: 118 });
    prisma._tx.batchAct.create.mockResolvedValue({ id: 'act-1', actNo: 'АПП-25-000118' });
    prisma.batchAct.findFirst.mockResolvedValue({
      id: 'act-1',
      actNo: 'АПП-25-000118',
      batchId: BATCH_ID,
      itemsSnapshot: {
        batchNo: 'П-250916-004',
        direction: 'TO_PRODUCTION',
        fromLabel: 'Магазин на Тверской',
        toLabel: 'Центральный цех',
        itemsCount: 1,
        items: [],
        totalAmountMinor: 15000,
        formedAt: '2025-09-16T07:00:00.000Z',
      },
      signedByFromId: null,
      signedByToId: null,
      signedFromAt: null,
      signedToAt: null,
      pdfFileId: null,
    });

    const act = await makeService(prisma).formAct(BATCH_ID, LOGIST);

    const counterCall = prisma._tx.counter.upsert.mock.calls[0]?.[0] as {
      where: { scope: string };
    };
    expect(counterCall.where.scope).toBe(`ACT:${new Date().getFullYear()}`);
    expect(act.actNo).toBe('АПП-25-000118');
    expect(act.itemsCount).toBe(1);
    expect(act.totalAmountMinor).toBe(15000);
  });

  it('переводит партию в ACT_FORMED в той же транзакции', async () => {
    /*
     * Если бы акт создался, а статус не сменился, партия осталась бы `DRAFT` и
     * допускала правку состава под уже существующим актом.
     */
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchWithItems());
    prisma.batchAct.findFirst.mockResolvedValue({
      id: 'act-1',
      actNo: 'АПП-25-000001',
      batchId: BATCH_ID,
      itemsSnapshot: {
        itemsCount: 1,
        totalAmountMinor: 0,
        formedAt: '2025-09-16T07:00:00.000Z',
        items: [],
        batchNo: 'П-1',
        direction: 'TO_PRODUCTION',
        fromLabel: 'a',
        toLabel: 'b',
      },
      signedByFromId: null,
      signedByToId: null,
      signedFromAt: null,
      signedToAt: null,
      pdfFileId: null,
    });

    await makeService(prisma).formAct(BATCH_ID, LOGIST);

    const updateCall = prisma._tx.batch.update.mock.calls[0]?.[0] as {
      data: { status: string };
    };
    expect(updateCall.data.status).toBe('ACT_FORMED');
  });

  it('сохраняет снимок состава в itemsSnapshot', async () => {
    // Снимок фиксируется один раз: иначе переименованный заказ менял бы уже
    // подписанный документ.
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchWithItems());
    prisma.batchAct.findFirst.mockResolvedValue({
      id: 'act-1',
      actNo: 'АПП-25-000001',
      batchId: BATCH_ID,
      itemsSnapshot: {
        itemsCount: 1,
        totalAmountMinor: 15000,
        formedAt: '2025-09-16T07:00:00.000Z',
        items: [{ orderNo: 'MSK1-2609-000001' }],
        batchNo: 'П-250916-004',
        direction: 'TO_PRODUCTION',
        fromLabel: 'Магазин',
        toLabel: 'Цех',
      },
      signedByFromId: null,
      signedByToId: null,
      signedFromAt: null,
      signedToAt: null,
      pdfFileId: null,
    });

    await makeService(prisma).formAct(BATCH_ID, LOGIST);

    const createCall = prisma._tx.batchAct.create.mock.calls[0]?.[0] as {
      data: { itemsSnapshot: { itemsCount: number; items: Array<{ orderNo: string }> } };
    };
    expect(createCall.data.itemsSnapshot.itemsCount).toBe(1);
    expect(createCall.data.itemsSnapshot.items[0]?.orderNo).toBe('MSK1-2609-000001');
  });

  it('пишет акт в журнал аудита', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchWithItems());
    prisma.batchAct.findFirst.mockResolvedValue({
      id: 'act-1',
      actNo: 'АПП-25-000001',
      batchId: BATCH_ID,
      itemsSnapshot: {
        itemsCount: 1,
        totalAmountMinor: 0,
        formedAt: '2025-09-16T07:00:00.000Z',
        items: [],
        batchNo: 'П-1',
        direction: 'TO_PRODUCTION',
        fromLabel: 'a',
        toLabel: 'b',
      },
      signedByFromId: null,
      signedByToId: null,
      signedFromAt: null,
      signedToAt: null,
      pdfFileId: null,
    });

    await makeService(prisma).formAct(BATCH_ID, LOGIST);

    const auditCall = prisma._tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { entity: string };
    };
    expect(auditCall.data.entity).toBe('BatchAct');
  });

  it('отклоняет акт по пустой партии', async () => {
    // «Акт на ноль изделий» подписывать бессмысленно: передавать нечего.
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchWithItems({ items: [] }));

    await expect(makeService(prisma).formAct(BATCH_ID, LOGIST)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('отклоняет повторное формирование акта', async () => {
    // Второй акт на ту же партию означал бы два документа о передаче одних и
    // тех же изделий.
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchWithItems());
    prisma._tx.batchAct.findFirst.mockResolvedValue({ id: 'act-old', actNo: 'АПП-25-000007' });

    await expect(makeService(prisma).formAct(BATCH_ID, LOGIST)).rejects.toThrow(/АПП-25-000007/);
  });

  it('отклоняет акт по партии не в черновике', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchWithItems({ status: 'IN_TRANSIT' }));

    await expect(makeService(prisma).formAct(BATCH_ID, LOGIST)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('не создаёт акт, если партия вне области видимости', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(null);

    await expect(makeService(prisma).formAct(BATCH_ID, RECEIVER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('BatchesService: заморозка состава после акта', () => {
  it('запрещает добавлять заказы после формирования акта', async () => {
    /*
     * Акт — документ о передаче конкретных изделий. Добавление заказа после
     * подписания сделало бы его недостоверным.
     */
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchRow({ status: 'ACT_FORMED' }));

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST),
    ).rejects.toThrow(/Акт уже сформирован/);

    expect(prisma._tx.batchItem.upsert).not.toHaveBeenCalled();
  });

  it('запрещает исключать заказы после формирования акта', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchRow({ status: 'ACT_FORMED' }));

    await expect(
      makeService(prisma).removeOrder(BATCH_ID, ORDER_1, { reason: 'Изделие не готово' }, LOGIST),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma._tx.batchItem.update).not.toHaveBeenCalled();
  });

  it('запрещает менять состав партии в пути', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchRow({ status: 'IN_TRANSIT' }));

    await expect(
      makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST),
    ).rejects.toThrow(/в пути/);
  });

  it('разрешает менять состав черновика', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));

    await makeService(prisma).addOrders(BATCH_ID, { orderIds: [ORDER_1] }, LOGIST);

    expect(prisma._tx.batchItem.upsert).toHaveBeenCalled();
  });
});

describe('BatchesService: подпись акта (задача 2.3)', () => {
  const signedBatch = (status = 'ACT_FORMED') => batchRow({ status });
  const actRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'act-1',
    actNo: 'АПП-25-000118',
    batchId: BATCH_ID,
    itemsSnapshot: {
      batchNo: 'П-250916-004',
      direction: 'TO_PRODUCTION',
      fromLabel: 'Магазин',
      toLabel: 'Цех',
      itemsCount: 1,
      items: [],
      totalAmountMinor: 0,
      formedAt: '2025-09-16T07:00:00.000Z',
    },
    signedByFromId: null,
    signedByToId: null,
    signedFromAt: null,
    signedToAt: null,
    pdfFileId: null,
    ...overrides,
  });

  it('подписывает со стороны отправителя', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(signedBatch());
    prisma._tx.batchAct.findFirst.mockResolvedValue(actRow());
    prisma.batchAct.findFirst.mockResolvedValue(actRow({ signedFromAt: new Date() }));

    await makeService(prisma).signAct(BATCH_ID, { side: 'FROM' }, LOGIST);

    const call = prisma._tx.batchAct.update.mock.calls[0]?.[0] as {
      data: { signedByFromId: string; signedFromAt: Date };
    };
    expect(call.data.signedByFromId).toBe(LOGIST_ID);
    expect(call.data.signedFromAt).toBeInstanceOf(Date);
  });

  it('подписывает со стороны получателя', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(signedBatch());
    prisma._tx.batchAct.findFirst.mockResolvedValue(actRow());
    prisma.batchAct.findFirst.mockResolvedValue(actRow({ signedToAt: new Date() }));

    await makeService(prisma).signAct(BATCH_ID, { side: 'TO' }, LOGIST);

    const call = prisma._tx.batchAct.update.mock.calls[0]?.[0] as {
      data: { signedByToId: string };
    };
    expect(call.data.signedByToId).toBe(LOGIST_ID);
  });

  it('отклоняет повторную подпись той же стороны', async () => {
    /*
     * Иначе «подпись» перестала бы означать конкретный момент передачи — а
     * именно он важен при споре о том, кто и когда принял изделие.
     */
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(signedBatch());
    prisma._tx.batchAct.findFirst.mockResolvedValue(actRow({ signedFromAt: new Date() }));

    await expect(makeService(prisma).signAct(BATCH_ID, { side: 'FROM' }, LOGIST)).rejects.toThrow(
      /уже подписан отправителем/,
    );
    expect(prisma._tx.batchAct.update).not.toHaveBeenCalled();
  });

  it('разрешает вторую сторону после первой', async () => {
    // Стороны подписывают по очереди: отправитель при отправке, получатель при
    // приёмке.
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(signedBatch());
    prisma._tx.batchAct.findFirst.mockResolvedValue(actRow({ signedFromAt: new Date() }));
    prisma.batchAct.findFirst.mockResolvedValue(actRow({ signedFromAt: new Date() }));

    await makeService(prisma).signAct(BATCH_ID, { side: 'TO' }, LOGIST);

    expect(prisma._tx.batchAct.update).toHaveBeenCalled();
  });

  it('отклоняет подпись, если акт не сформирован', async () => {
    // Партия ещё черновик: акта нет, подписывать нечего.
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));
    prisma.batchAct.findFirst.mockResolvedValue(null);

    await expect(
      makeService(prisma).signAct(BATCH_ID, { side: 'FROM' }, LOGIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('отклоняет подпись партии без акта', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(signedBatch());
    prisma._tx.batchAct.findFirst.mockResolvedValue(null);

    await expect(
      makeService(prisma).signAct(BATCH_ID, { side: 'FROM' }, LOGIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('отклоняет неизвестную сторону', async () => {
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).signAct(BATCH_ID, { side: 'SIDEWAYS' }, LOGIST),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('отклоняет подпись партии в пути', async () => {
    // Подпись задним числом после отправки не подтверждает передачу, а создаёт
    // видимость её отсутствия в момент отъезда.
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchRow({ status: 'IN_TRANSIT' }));
    prisma._tx.batchAct.findFirst.mockResolvedValue({
      id: 'act-1',
      actNo: 'АПП-25-000118',
      signedFromAt: null,
      signedToAt: null,
    });

    await expect(
      makeService(prisma).signAct(BATCH_ID, { side: 'FROM' }, LOGIST),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('пишет подпись в журнал аудита', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(signedBatch());
    prisma._tx.batchAct.findFirst.mockResolvedValue(actRow());
    prisma.batchAct.findFirst.mockResolvedValue(actRow({ signedFromAt: new Date() }));

    await makeService(prisma).signAct(BATCH_ID, { side: 'FROM' }, LOGIST);

    const call = prisma._tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { after: { signedSide: string } };
    };
    expect(call.data.after.signedSide).toBe('FROM');
  });
});

describe('BatchesService: сохранение PDF акта (задача 2.3)', () => {
  it('сохраняет файл и привязывает его к акту', async () => {
    // Потоковый PDF нельзя предъявить, а сохранённый — можно.
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchRow({ status: 'ACT_FORMED' }));
    prisma._tx.batchAct.findFirst.mockResolvedValue({ id: 'act-1', actNo: 'АПП-25-000118' });
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'ACT_FORMED' }));
    prisma.batchAct.findFirst.mockResolvedValue({
      id: 'act-1',
      actNo: 'АПП-25-000118',
      batchId: BATCH_ID,
      itemsSnapshot: {
        itemsCount: 1,
        totalAmountMinor: 0,
        formedAt: '2025-09-16T07:00:00.000Z',
        items: [],
        batchNo: 'П-1',
        direction: 'TO_PRODUCTION',
        fromLabel: 'a',
        toLabel: 'b',
      },
      signedByFromId: null,
      signedByToId: null,
      signedFromAt: null,
      signedToAt: null,
      pdfFileId: 'file-1',
    });
    prisma.user = { findMany: vi.fn(async () => []) };

    await makeService(prisma).storeActPdf(BATCH_ID, LOGIST);

    expect(storageMock.saveRaw).toHaveBeenCalled();

    /*
     * Ключевая проверка. `BatchAct.pdfFileId` — внешний ключ на `Document`, а
     * НЕ на `FileObject`, несмотря на имя поля. Когда сюда подставлялся
     * `fileObject.id`, живой сервер отвечал 500 («Foreign key constraint
     * violated on batch_act_pdfFileId_fkey»), а этот тест проходил, потому что
     * двойник Prisma принимал любой идентификатор. Теперь идентификаторы
     * документа и файла разные, и подмена снова уронит тест.
     */
    const actUpdate = prisma._tx.batchAct.update.mock.calls[0]?.[0] as {
      data: { pdfFileId: string };
    };
    expect(actUpdate.data.pdfFileId).toBe('doc-1');
    expect(actUpdate.data.pdfFileId).not.toBe('file-1');
  });

  it('создаёт запись документа с номером акта', async () => {
    const prisma = createPrismaMock();
    prisma._tx.batch.findFirst.mockResolvedValue(batchRow({ status: 'ACT_FORMED' }));
    prisma._tx.batchAct.findFirst.mockResolvedValue({ id: 'act-1', actNo: 'АПП-25-000118' });
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'ACT_FORMED' }));
    prisma.batchAct.findFirst.mockResolvedValue({
      id: 'act-1',
      actNo: 'АПП-25-000118',
      batchId: BATCH_ID,
      itemsSnapshot: {
        itemsCount: 1,
        totalAmountMinor: 0,
        formedAt: '2025-09-16T07:00:00.000Z',
        items: [],
        batchNo: 'П-1',
        direction: 'TO_PRODUCTION',
        fromLabel: 'a',
        toLabel: 'b',
      },
      signedByFromId: null,
      signedByToId: null,
      signedFromAt: null,
      signedToAt: null,
      pdfFileId: null,
    });
    prisma.user = { findMany: vi.fn(async () => []) };

    await makeService(prisma).storeActPdf(BATCH_ID, LOGIST);

    const call = prisma._tx.document.create.mock.calls[0]?.[0] as {
      data: { type: string; number: string; batchId: string };
    };
    expect(call.data.type).toBe('BATCH_ACT');
    expect(call.data.number).toBe('АПП-25-000118');
    expect(call.data.batchId).toBe(BATCH_ID);
  });
});

describe('BatchesService: фотофиксация партии (задача 2.4)', () => {
  /*
   * Счётчики вызовов общих двойников сбрасываются перед каждым тестом: иначе
   * проверка «файл не сохранялся» срабатывает на вызове из предыдущего теста и
   * падает по ложной причине.
   */
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /*
   * Фото — доказательство состояния изделий и тары на момент передачи. Правила
   * доступа и статуса проверяются здесь, потому что ошибка в них означает либо
   * утечку чужих снимков, либо потерю доказательства.
   */

  const FILE = { buffer: Buffer.from('img'), originalname: 'photo.jpg' };

  it('загружает фото в черновик', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));
    prisma.batchPhoto.findMany.mockResolvedValue([]);

    const result = await makeService(prisma).uploadPhotos(
      BATCH_ID,
      { caption: null, files: [FILE] },
      LOGIST,
    );

    expect(storageMock.savePhoto).toHaveBeenCalled();
    expect(prisma._tx.batchPhoto.create).toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
  });

  it('отклоняет загрузку без файлов', async () => {
    // Пустой запрос — ошибка клиента, а не «ничего не произошло»: иначе логист
    // решит, что фотофиксация сделана.
    const prisma = createPrismaMock();

    await expect(
      makeService(prisma).uploadPhotos(BATCH_ID, { caption: null, files: [] }, LOGIST),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageMock.savePhoto).not.toHaveBeenCalled();
  });

  it('отклоняет загрузку в отменённую партию', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'CANCELLED' }));

    await expect(
      makeService(prisma).uploadPhotos(BATCH_ID, { caption: null, files: [FILE] }, LOGIST),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storageMock.savePhoto).not.toHaveBeenCalled();
  });

  it('разрешает загрузку при приёмке', async () => {
    // Получатель фиксирует, в каком виде партия доехала: запрет лишил бы его
    // возможности доказать расхождение.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'RECEIVED' }));
    prisma.batchPhoto.findMany.mockResolvedValue([]);

    await makeService(prisma).uploadPhotos(BATCH_ID, { caption: null, files: [FILE] }, LOGIST);

    expect(storageMock.savePhoto).toHaveBeenCalled();
  });

  it('отклоняет загрузку в невидимую партию', async () => {
    // Область видимости: приёмщик не должен прикреплять фото к чужому рейсу.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(null);

    await expect(
      makeService(prisma).uploadPhotos(BATCH_ID, { caption: null, files: [FILE] }, LOGIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('убирает файл с диска, если запись не создалась', async () => {
    /*
     * Иначе на диске остаётся «фото-призрак»: файл есть, ссылки на него нет.
     * Такие файлы никто не найдёт и не удалит.
     */
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));
    prisma._tx.batchPhoto.create.mockRejectedValue(new Error('БД недоступна'));

    await expect(
      makeService(prisma).uploadPhotos(BATCH_ID, { caption: null, files: [FILE] }, LOGIST),
    ).rejects.toThrow('БД недоступна');

    expect(storageMock.remove).toHaveBeenCalledWith('batches/b1/photo.jpg');
  });

  it('показывает фото без ключей хранилища', async () => {
    // Ключ хранилища наружу не отдаётся: по нему файл достаётся в обход прав.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));
    prisma.batchPhoto.findMany.mockResolvedValue([
      {
        id: 'photo-1',
        batchId: BATCH_ID,
        caption: 'тара',
        createdAt: new Date('2025-09-16T10:00:00Z'),
        file: { objectKey: 'batches/b1/secret.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
      },
    ]);

    const photos = await makeService(prisma).listPhotos(BATCH_ID, LOGIST);

    expect(photos[0]?.url).toBe('/api/v1/batches/photos/photo-1');
    expect(JSON.stringify(photos)).not.toContain('secret.jpg');
  });

  it('отдаёт уменьшенную копию по ?variant=thumb', async () => {
    const prisma = createPrismaMock();
    prisma.batchPhoto.findFirst.mockResolvedValue({
      id: 'photo-1',
      batchId: BATCH_ID,
      file: { objectKey: 'batches/b1/photo.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
    });
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));

    await makeService(prisma).getPhotoFile('photo-1', 'thumb', LOGIST);

    expect(storageMock.read).toHaveBeenCalledWith('batches/b1/photo-thumb.jpg');
  });

  it('отдаёт оригинал, если уменьшенной копии нет', async () => {
    // Сбой при сохранении превью не должен делать фото недоступным.
    const prisma = createPrismaMock();
    prisma.batchPhoto.findFirst.mockResolvedValue({
      id: 'photo-1',
      batchId: BATCH_ID,
      file: { objectKey: 'batches/b1/photo.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
    });
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));
    storageMock.read.mockRejectedValueOnce(new Error('нет файла'));

    const file = await makeService(prisma).getPhotoFile('photo-1', 'thumb', LOGIST);

    expect(file.buffer.length).toBeGreaterThan(0);
  });

  it('отклоняет скачивание фото невидимой партии', async () => {
    const prisma = createPrismaMock();
    prisma.batchPhoto.findFirst.mockResolvedValue({
      id: 'photo-1',
      batchId: BATCH_ID,
      file: { objectKey: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
    });
    prisma.batch.findFirst.mockResolvedValue(null);

    await expect(
      makeService(prisma).getPhotoFile('photo-1', 'full', LOGIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('удаляет фото в черновике', async () => {
    const prisma = createPrismaMock();
    prisma.batchPhoto.findFirst.mockResolvedValue({
      id: 'photo-1',
      batchId: BATCH_ID,
      fileId: 'file-1',
      file: { objectKey: 'batches/b1/photo.jpg' },
      batch: { id: BATCH_ID, status: 'DRAFT' },
    });
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'DRAFT' }));

    await makeService(prisma).removePhoto('photo-1', LOGIST);

    expect(prisma._tx.batchPhoto.delete).toHaveBeenCalled();
    expect(storageMock.remove).toHaveBeenCalledWith('batches/b1/photo.jpg');
  });

  it('отклоняет удаление фото партии в пути', async () => {
    /*
     * После отъезда фото — часть записи о передаче. Пропавшее задним числом
     * доказательство хуже, чем его отсутствие.
     */
    const prisma = createPrismaMock();
    prisma.batchPhoto.findFirst.mockResolvedValue({
      id: 'photo-1',
      batchId: BATCH_ID,
      fileId: 'file-1',
      file: { objectKey: 'batches/b1/photo.jpg' },
      batch: { id: BATCH_ID, status: 'IN_TRANSIT' },
    });
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'IN_TRANSIT' }));

    await expect(makeService(prisma).removePhoto('photo-1', LOGIST)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma._tx.batchPhoto.delete).not.toHaveBeenCalled();
  });

  it('отклоняет удаление фото принятой партии', async () => {
    const prisma = createPrismaMock();
    prisma.batchPhoto.findFirst.mockResolvedValue({
      id: 'photo-1',
      batchId: BATCH_ID,
      fileId: 'file-1',
      file: { objectKey: 'batches/b1/photo.jpg' },
      batch: { id: BATCH_ID, status: 'RECEIVED' },
    });
    prisma.batch.findFirst.mockResolvedValue(batchRow({ status: 'RECEIVED' }));

    await expect(makeService(prisma).removePhoto('photo-1', LOGIST)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('BatchesService: отправка и приём партии (задача 2.5)', () => {
  /*
   * Отправка переводит СРАЗУ все заказы партии в «в пути», приём — в
   * «в производстве» или «готов к выдаче». Главное, что здесь проверяется:
   * перевод идёт в ОДНОЙ транзакции и через общую таблицу переходов, а не
   * собственным `UPDATE status`.
   */

  /*
   * Строка состава в форме ответа Prisma: `findOne` (вызывается в конце
   * `dispatch`/`receive`) читает заказ ЧЕРЕЗ строку состава, поэтому одного
   * `orderId` мало — без `order` тест падал бы не на правиле сервиса, а на
   * неполном двойнике.
   */
  const withItems = (status: string, direction = 'TO_PRODUCTION', items = 2) =>
    batchRow({
      status,
      direction,
      items: Array.from({ length: items }, (_, index) => ({
        orderId: `order-${index}`,
        addedAt: new Date('2025-09-16T07:00:00Z'),
        addedById: LOGIST_ID,
        order: {
          orderNo: `MSK1-2609-00000${index + 1}`,
          status: 'QUEUED_FOR_DISPATCH',
          totalAmountMinor: 100000,
          customer: { fullName: `Клиент ${index + 1}` },
        },
      })),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    // `findOne` в конце вызывает `batch.findFirst` ещё раз.
    workflowMock.transition.mockResolvedValue({ id: 'order-1' });
  });

  it('отправляет партию и переводит заказы в «в пути»', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED'));

    await makeService(prisma).dispatch(BATCH_ID, LOGIST);

    const targets = workflowMock.transition.mock.calls.map(
      (call) => (call[0] as { to: string }).to,
    );
    expect(targets).toEqual(['IN_TRANSIT_TO_PRODUCTION', 'IN_TRANSIT_TO_PRODUCTION']);
  });

  it('переводит заказы в ОДНОЙ транзакции', async () => {
    /*
     * Ключевое свойство задачи 2.5. Если каждый заказ откроет собственную
     * транзакцию, половина партии уедет, а половина останется — и акт,
     * подписанный на все изделия, не совпадёт с фактическим составом.
     */
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED'));

    await makeService(prisma).dispatch(BATCH_ID, LOGIST);

    // Транзакция открыта ровно один раз на всю партию.
    expect(prisma.runInTransaction).toHaveBeenCalledTimes(1);
    // И каждый переход получил ЭТУ ЖЕ транзакцию, а не открыл свою.
    const passedTx = workflowMock.transition.mock.calls.map(
      (call) => (call[0] as { tx?: unknown }).tx,
    );
    expect(passedTx[0]).toBeDefined();
    expect(passedTx[1]).toBe(passedTx[0]);
    expect(passedTx[0]).toBe(prisma._tx);
  });

  it('рейс в магазин переводит заказы в IN_TRANSIT_TO_STORE', async () => {
    // Ветки направлений разные: перепутать значит отправить заказ в цех,
    // который ждёт его из цеха.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED', 'TO_STORE'));

    await makeService(prisma).dispatch(BATCH_ID, LOGIST);

    const target = (workflowMock.transition.mock.calls[0]?.[0] as { to: string }).to;
    expect(target).toBe('IN_TRANSIT_TO_STORE');
  });

  it('приём переводит заказы в IN_PRODUCTION', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('IN_TRANSIT'));

    await makeService(prisma).receive(BATCH_ID, LOGIST);

    const target = (workflowMock.transition.mock.calls[0]?.[0] as { to: string }).to;
    expect(target).toBe('IN_PRODUCTION');
  });

  it('приём рейса из цеха переводит заказы в READY_FOR_PICKUP', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('IN_TRANSIT', 'TO_STORE'));

    await makeService(prisma).receive(BATCH_ID, LOGIST);

    const target = (workflowMock.transition.mock.calls[0]?.[0] as { to: string }).to;
    expect(target).toBe('READY_FOR_PICKUP');
  });

  it('передаёт актора и его роль в переход', async () => {
    // Без актора история статусов не скажет, кто отправил рейс, а проверка роли
    // в таблице переходов пропустила бы запрещённое действие.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED'));

    await makeService(prisma).dispatch(BATCH_ID, LOGIST);

    const ctx = workflowMock.transition.mock.calls[0]?.[0] as {
      actorId: string;
      actorRole: string;
      scope: string;
    };
    expect(ctx.actorId).toBe(LOGIST_ID);
    expect(ctx.actorRole).toBe(LOGIST.primaryRole);
    expect(ctx.scope).toBe(LOGIST.scope);
  });

  it('отклоняет отправку черновика', async () => {
    // Перевозка изделий клиентов без документа: при утрате нечем подтвердить,
    // что именно и в каком виде приняли.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('DRAFT'));

    await expect(makeService(prisma).dispatch(BATCH_ID, LOGIST)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(workflowMock.transition).not.toHaveBeenCalled();
  });

  it('отклоняет повторную отправку', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('IN_TRANSIT'));

    await expect(makeService(prisma).dispatch(BATCH_ID, LOGIST)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('отклоняет приём партии, которая не уезжала', async () => {
    // Иначе заказы оказались бы «в производстве» без доставки.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED'));

    await expect(makeService(prisma).receive(BATCH_ID, LOGIST)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(workflowMock.transition).not.toHaveBeenCalled();
  });

  it('отклоняет отправку пустой партии', async () => {
    // Акт подписан на нулевой состав, и «в пути» оказалось бы ничего.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED', 'TO_PRODUCTION', 0));

    await expect(makeService(prisma).dispatch(BATCH_ID, LOGIST)).rejects.toThrow(
      /нет ни одного заказа/,
    );
    expect(workflowMock.transition).not.toHaveBeenCalled();
  });

  it('отклоняет отправку невидимой партии', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(null);

    await expect(makeService(prisma).dispatch(BATCH_ID, LOGIST)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('меняет статус партии и записывает время отправки', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED'));

    await makeService(prisma).dispatch(BATCH_ID, LOGIST);

    const update = prisma._tx.batch.update.mock.calls[0]?.[0] as {
      data: { status: string; dispatchedAt: Date };
    };
    expect(update.data.status).toBe('IN_TRANSIT');
    expect(update.data.dispatchedAt).toBeInstanceOf(Date);
  });

  it('записывает время приёма', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('IN_TRANSIT'));

    await makeService(prisma).receive(BATCH_ID, LOGIST);

    const update = prisma._tx.batch.update.mock.calls[0]?.[0] as {
      data: { status: string; receivedAt: Date };
    };
    expect(update.data.status).toBe('RECEIVED');
    expect(update.data.receivedAt).toBeInstanceOf(Date);
  });

  it('пропускает заказ, уже находящийся в целевом статусе', async () => {
    /*
     * Повторный вызов после частичного сбоя обязан доводить партию до конца, а
     * не падать на «переход недопустим»: массовая операция должна быть
     * повторяемой.
     */
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED'));
    prisma._tx.order.findUnique.mockResolvedValue({
      version: 1,
      status: 'IN_TRANSIT_TO_PRODUCTION',
    });

    await makeService(prisma).dispatch(BATCH_ID, LOGIST);

    expect(workflowMock.transition).not.toHaveBeenCalled();
    // Статус партии всё равно доводится до конца.
    expect(prisma._tx.batch.update).toHaveBeenCalled();
  });

  it('пишет изменение партии в журнал аудита', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(withItems('ACT_FORMED'));

    await makeService(prisma).dispatch(BATCH_ID, LOGIST);

    const audit = prisma._tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { entity: string; before: { status: string }; after: { status: string } };
    };
    expect(audit.data.entity).toBe('Batch');
    expect(audit.data.before.status).toBe('ACT_FORMED');
    expect(audit.data.after.status).toBe('IN_TRANSIT');
  });
});

describe('BatchesService: отслеживание «в пути» (задача 2.6)', () => {
  /*
   * ЗАЧЕМ ЭТО ПРОВЕРЯЕТСЯ. Партия уехала, и до приёмки о ней ничего не
   * известно. Состояние считается на чтение: «в пути 6 часов» — это разница
   * между текущим моментом и отправкой, и записанное в базу значение устарело
   * бы сразу после записи.
   */

  beforeEach(() => vi.clearAllMocks());

  const listRow = (dispatchedAt: Date | null, status = 'IN_TRANSIT') =>
    batchRow({ status, dispatchedAt, receivedAt: null });

  it('в списке партий есть состояние «в пути»', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([listRow(new Date(Date.now() - 3 * 3_600_000))]);

    const result = await makeService(prisma).list({ limit: 10 }, LOGIST);

    expect(result.items[0]?.transit.level).toBe('ON_TIME');
    expect(result.items[0]?.transit.elapsedHours).toBeGreaterThan(2.9);
  });

  it('задержка отражается в состоянии партии', async () => {
    // Без этого логист не видит, какая машина не доехала.
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([listRow(new Date(Date.now() - 20 * 3_600_000))]);

    const result = await makeService(prisma).list({ limit: 10 }, LOGIST);

    expect(result.items[0]?.transit.isOverdue).toBe(true);
    expect(result.items[0]?.transit.level).toBe('OVERDUE');
  });

  it('неотправленная партия не помечается просроченной', async () => {
    // Иначе каждая созданная партия сразу попала бы в тревоги.
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([listRow(null, 'DRAFT')]);

    const result = await makeService(prisma).list({ limit: 10 }, LOGIST);

    expect(result.items[0]?.transit.isOverdue).toBe(false);
    expect(result.items[0]?.transit.elapsedHours).toBeNull();
  });

  it('норматив берётся из настройки', async () => {
    /*
     * Городской и междугородний рейс имеют разную норму, и «в пути 6 часов» без
     * норматива ничего не значит. Настройку меняет логистик, а не разработчик.
     */
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([listRow(new Date(Date.now() - 6 * 3_600_000))]);
    prisma.setting.findUnique.mockResolvedValue({ key: 'logistics.transitNormHours', value: 48 });

    const result = await makeService(prisma).list({ limit: 10 }, LOGIST);

    expect(result.items[0]?.transit.normHours).toBe(48);
    expect(result.items[0]?.transit.isOverdue).toBe(false);
  });

  it('бессмысленный норматив заменяется значением по умолчанию', async () => {
    /*
     * Ноль дал бы деление на ноль, и партия осталась бы «в норме» навсегда —
     * тревога не сработала бы никогда. Значение приходит из настройки, которую
     * заполняет человек, и ошибиться в ней легко.
     */
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([listRow(new Date(Date.now() - 100 * 3_600_000))]);
    prisma.setting.findUnique.mockResolvedValue({ key: 'logistics.transitNormHours', value: 0 });

    const result = await makeService(prisma).list({ limit: 10 }, LOGIST);

    expect(result.items[0]?.transit.normHours).toBe(8);
    expect(result.items[0]?.transit.isOverdue).toBe(true);
  });

  it('в списке «в пути» задержанные идут первыми', async () => {
    /*
     * В обычном списке партии идут по дате создания, и машина, пропавшая сутки
     * назад, оказалась бы НИЖЕ вчерашней городской — то есть ровно то, что
     * требует вмешательства, логист увидел бы последним.
     */
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([
      batchRow({
        id: 'b-fresh',
        batchNo: 'П-1',
        status: 'IN_TRANSIT',
        dispatchedAt: new Date(Date.now() - 3_600_000),
      }),
      batchRow({
        id: 'b-late',
        batchNo: 'П-2',
        status: 'IN_TRANSIT',
        dispatchedAt: new Date(Date.now() - 40 * 3_600_000),
      }),
    ]);

    const result = await makeService(prisma).listInTransit(LOGIST);

    expect(result.map((batch) => batch.batchNo)).toEqual(['П-2', 'П-1']);
  });

  it('в список «в пути» попадают только партии в пути', async () => {
    // Принятая партия уже не в пути: её место в истории, а не в отслеживании.
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([]);

    await makeService(prisma).listInTransit(LOGIST);

    const where = prisma.batch.findMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } };
    expect(where.where.AND[0]).toEqual({ status: 'IN_TRANSIT' });
  });

  it('норматив читается один раз на страницу, а не на каждую строку', async () => {
    // Запрос на строку превратил бы список в N+1.
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([
      listRow(new Date(Date.now() - 3_600_000)),
      listRow(new Date(Date.now() - 3_600_000)),
      listRow(new Date(Date.now() - 3_600_000)),
    ]);

    await makeService(prisma).list({ limit: 10 }, LOGIST);

    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('BatchesService: уведомление о приёмке (задача 2.6)', () => {
  /*
   * ЗАЧЕМ ЭТО ПРОВЕРЯЕТСЯ. Отправитель рейса иначе узнаёт о доставке, только
   * позвонив получателю. Проверяется, ЧТО сервис просит сообщить и кому.
   */

  beforeEach(() => vi.clearAllMocks());

  const receivable = (senderId: string | null, status = 'IN_TRANSIT') =>
    batchRow({
      status,
      direction: 'TO_PRODUCTION',
      createdById: senderId,
      items: [
        {
          orderId: 'order-1',
          addedAt: new Date('2025-09-16T07:00:00Z'),
          addedById: LOGIST_ID,
          order: {
            orderNo: 'MSK1-2609-000001',
            status: 'IN_TRANSIT_TO_PRODUCTION',
            totalAmountMinor: 100000,
            customer: { fullName: 'Клиент 1' },
          },
        },
      ],
    });

  it('отправителю рейса сообщается о приёмке', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(receivable(LOGIST_ID));

    await makeService(prisma).receive(BATCH_ID, LOGIST);

    expect(notificationsMock.notifyByTemplate).toHaveBeenCalledTimes(1);
    const call = notificationsMock.notifyByTemplate.mock.calls[0]?.[0] as {
      code: string;
      userId: string;
    };
    expect(call.code).toBe('BATCH_RECEIVED');
    expect(call.userId).toBe(LOGIST_ID);
  });

  it('при отправке уведомление о приёмке не создаётся', async () => {
    // Событие ещё не наступило: сообщать «принято» в момент отправки — ложь.
    const prisma = createPrismaMock();
    // Отправляется партия с АКТОМ: из DRAFT отправить нельзя.
    prisma.batch.findFirst.mockResolvedValue(receivable(LOGIST_ID, 'ACT_FORMED'));

    await makeService(prisma).dispatch(BATCH_ID, LOGIST);

    expect(notificationsMock.notifyByTemplate).not.toHaveBeenCalled();
  });

  it('без известного отправителя уведомление не создаётся', async () => {
    // Сообщение «в никуда» только засорило бы таблицу.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(receivable(null));

    await makeService(prisma).receive(BATCH_ID, LOGIST);

    expect(notificationsMock.notifyByTemplate).not.toHaveBeenCalled();
  });

  it('сбой уведомления НЕ отменяет приёмку', async () => {
    /*
     * Партия уже принята, изделия физически у получателя. Сообщить
     * пользователю об ошибке бессмысленно — исправить он ничего не может, а
     * откатывать приёмку из-за недоступной почты нельзя.
     */
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(receivable(LOGIST_ID));
    notificationsMock.notifyByTemplate.mockRejectedValueOnce(new Error('SMTP timeout'));

    await expect(makeService(prisma).receive(BATCH_ID, LOGIST)).resolves.toBeDefined();
  });
});

describe('BatchesService: доставки курьера (задача 2.7)', () => {
  /*
   * ЗАЧЕМ ЭТО ПРОВЕРЯЕТСЯ. Курьер работает с телефона, и ему нужен свой узкий
   * список: только назначенные на него незавершённые рейсы. Показ всех рейсов
   * сети означал бы не только неудобство, но и утечку: в строке видны адреса,
   * состав и суммы чужих заказов.
   */

  beforeEach(() => vi.clearAllMocks());

  it('курьеру показываются только его рейсы', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([batchRow({ courierId: LOGIST_ID })]);

    await makeService(prisma).listMyDeliveries(LOGIST);

    const where = prisma.batch.findMany.mock.calls[0][0].where;
    // Фильтр по назначению обязателен: без него курьер увидел бы чужие рейсы.
    expect(where.AND[0]).toEqual({ courierId: LOGIST_ID });
  });

  it('руководителю производства видны и нераспределённые рейсы', async () => {
    /*
     * Он эти рейсы распределяет. Если показать только назначенные, раздать
     * будет нечего: рейс без курьера просто не появится в списке.
     */
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([batchRow({ courierId: null })]);
    const manager: AuthenticatedUser = {
      ...LOGIST,
      roles: [ROLE.PRODUCTION_MANAGER],
      primaryRole: ROLE.PRODUCTION_MANAGER,
    };

    await makeService(prisma).listMyDeliveries(manager);

    expect(prisma.batch.findMany.mock.calls[0][0].where.AND[0]).toEqual({});
  });

  it('завершённые рейсы в список не попадают', async () => {
    // Курьеру важно то, что он ещё должен отвезти; история есть в карточке.
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([]);

    await makeService(prisma).listMyDeliveries(LOGIST);

    const notIn = prisma.batch.findMany.mock.calls[0][0].where.AND[1].status.notIn as string[];
    expect(notIn).toContain('RECEIVED');
    expect(notIn).toContain('CANCELLED');
  });

  it('рейсы в пути идут первыми, самые задержанные — выше', async () => {
    /*
     * Порядок — это рабочая инструкция: сначала то, что уже едет и опаздывает.
     * Сортировка по дате создания поставила бы давно отправленный рейс ниже
     * только что назначенного.
     */
    const prisma = createPrismaMock();
    const now = Date.now();
    prisma.batch.findMany.mockResolvedValue([
      batchRow({ id: 'b-plan', batchNo: 'П-план', status: 'ACT_FORMED', courierId: LOGIST_ID }),
      batchRow({
        id: 'b-fresh',
        batchNo: 'П-свежий',
        status: 'IN_TRANSIT',
        courierId: LOGIST_ID,
        dispatchedAt: new Date(now - 2 * 3_600_000),
      }),
      batchRow({
        id: 'b-late',
        batchNo: 'П-опаздывает',
        status: 'IN_TRANSIT',
        courierId: LOGIST_ID,
        dispatchedAt: new Date(now - 20 * 3_600_000),
      }),
    ]);

    const result = await makeService(prisma).listMyDeliveries(LOGIST);

    expect(result.map((batch) => batch.batchNo)).toEqual(['П-опаздывает', 'П-свежий', 'П-план']);
  });

  it('курьер не видит рейсы чужих магазинов', async () => {
    // Область видимости применяется и здесь: назначение не отменяет границы.
    const prisma = createPrismaMock();
    prisma.batch.findMany.mockResolvedValue([]);
    const otherStoreCourier: AuthenticatedUser = { ...RECEIVER, id: LOGIST_ID };

    await makeService(prisma).listMyDeliveries(otherStoreCourier);

    const scope = prisma.batch.findMany.mock.calls[0][0].where.AND[2];
    expect(scope).toEqual({
      OR: [{ fromStoreId: { in: [STORE_MSK1] } }, { toStoreId: { in: [STORE_MSK1] } }],
    });
  });
});

describe('BatchesService: поиск партии по скану (задача 2.7)', () => {
  /*
   * ЗАЧЕМ ЭТО ПРОВЕРЯЕТСЯ. Сканер «печатает» содержимое QR в поле, и туда
   * попадает и полный URI, и номер с переводом строки. Мобильный экран
   * отправляет то, что получил; приводит в порядок та сторона, где правила уже
   * описаны. Если этого не делать, отсканированный код даёт НОЛЬ результатов —
   * дефект, уже случавшийся на экране приёма оплаты.
   */

  beforeEach(() => vi.clearAllMocks());

  it('находит партию по точному номеру', async () => {
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(batchRow({ batchNo: 'П-250916-004' }));

    const result = await makeService(prisma).findByScan('П-250916-004', LOGIST);

    expect(result.batchNo).toBe('П-250916-004');
    const where = prisma.batch.findFirst.mock.calls[0][0].where;
    expect(where.AND[0].batchNo).toEqual({ equals: 'П-250916-004', mode: 'insensitive' });
  });

  it('регистр и пробелы сканера не мешают', async () => {
    // Сканер добавляет перевод строки, а наклейку могли набрать и строчными.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(batchRow());

    await makeService(prisma).findByScan('  п-250916-004\n', LOGIST);

    expect(prisma.batch.findFirst.mock.calls[0][0].where.AND[0].batchNo).toEqual({
      equals: 'п-250916-004',
      mode: 'insensitive',
    });
  });

  it('находит рейс по номеру заказа из состава', async () => {
    /*
     * Курьер может сканировать квитанцию изделия, чтобы понять, в каком рейсе
     * оно едет. Без этого поиска он получил бы «партия не найдена» на
     * совершенно правильном коде.
     */
    const prisma = createPrismaMock();
    prisma.batch.findFirst
      .mockResolvedValueOnce(null) // по номеру партии не найдено
      .mockResolvedValueOnce({ id: BATCH_ID }); // найдено по составу

    const result = await makeService(prisma).findByScan('repair://order/MSK1-2609-000001', LOGIST);

    expect(result.batchNo).toBe('П-250916-004');
    const second = prisma.batch.findFirst.mock.calls[1][0].where.AND[0];
    expect(second.items.some.order.orderNo).toEqual({
      equals: 'MSK1-2609-000001',
      mode: 'insensitive',
    });
  });

  it('неизвестный код даёт 404, а не пустой ответ', async () => {
    // Пустой ответ выглядел бы как «рейс есть, но пустой», и курьер не понял бы,
    // что сканирование не удалось.
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(null);

    await expect(makeService(prisma).findByScan('П-000000-000', LOGIST)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('слишком короткий ввод отклоняется', async () => {
    const prisma = createPrismaMock();

    await expect(makeService(prisma).findByScan('П-', LOGIST)).rejects.toThrow(BadRequestException);
  });

  it('чужой рейс не находится', async () => {
    /*
     * Область видимости применяется в обоих запросах: иначе курьер, зная номер
     * чужого рейса, прочитал бы его состав и адреса.
     */
    const prisma = createPrismaMock();
    prisma.batch.findFirst.mockResolvedValue(null);
    const otherStore: AuthenticatedUser = { ...RECEIVER, id: LOGIST_ID };

    await expect(makeService(prisma).findByScan('П-250916-004', otherStore)).rejects.toThrow(
      NotFoundException,
    );

    const where = prisma.batch.findFirst.mock.calls[0][0].where;
    expect(where.AND[1]).toEqual({
      OR: [{ fromStoreId: { in: [STORE_MSK1] } }, { toStoreId: { in: [STORE_MSK1] } }],
    });
  });
});
