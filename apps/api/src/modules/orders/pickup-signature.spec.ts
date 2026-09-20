/**
 * Тесты подписи клиента о получении изделия (ТЗ п. 2.8, дефект 66).
 *
 * РЕАЛЬНЫЙ ДЕФЕКТ 66. Переходы 18 и 21 (`READY_FOR_PICKUP`/`UNCLAIMED` →
 * `COMPLETED`) охраняются условием `PICKUP_SIGNATURE`, которое проверяет
 * `Order.pickupSignatureFileId != null`. Поле было в схеме с самого начала, но
 * **записать в него было нечем**: поиск по `pickupSignatureFileId` во всём
 * репозитории находил только объявление поля, чтение в guard и фикстуры тестов.
 *
 * Следствие: заказ нельзя выдать. Любой полный цикл доходил до
 * `READY_FOR_PICKUP`, принимал полную оплату — и на последнем шаге получал
 * `409 PICKUP_SIGNATURE_REQUIRED`. То есть основной сценарий приложения был
 * невыполним, а гарантия (`warrantyUntil`) недостижима.
 *
 * Дефект не находился, потому что тесты подставляли `pickupSignatureFileId: 'f-1'`
 * фикстурой — проверялся guard, а не путь к нему. Поэтому здесь проверяется
 * именно ЗАПИСЬ поля из файла, а не наличие guard.
 */

import { describe, expect, it, vi } from 'vitest';
import { extensionFor, PickupSignatureService } from './pickup-signature.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

const ORDER_ID = 'cmu47z1cu00ilampvb884ywwm';
const USER_ID = 'cmu47z14e000nampvq41sgkiw';
const FILE_ID = 'cmu9sig00001ampl000000001';

const RECEIVER: AuthenticatedUser = {
  id: USER_ID,
  fullName: 'Иванова Мария Сергеевна',
  primaryRole: 'RECEIVER',
  roles: ['RECEIVER'],
  scope: 'STORE_PLUS_GLOBAL_SEARCH',
  scopes: ['STORE_PLUS_GLOBAL_SEARCH'],
  storeIds: ['cmu47z0xq0000ampvqypjgtrd'],
  mustChangePassword: false,
} as unknown as AuthenticatedUser;

const FILE = { buffer: Buffer.from('росчерк'), mimetype: 'image/png', originalname: 'sign.png' };

/**
 * Двойник Prisma и хранилища.
 *
 * `update` записывает фактические данные — именно на них проверяется дефект:
 * если поле не заполняется, переход 18 останется невозможным, сколько бы
 * остальных проверок ни проходило.
 */
function createMocks(orderOverrides: Record<string, unknown> = {}) {
  const order = {
    id: ORDER_ID,
    status: 'READY_FOR_PICKUP',
    pickupSignatureFileId: null,
    ...orderOverrides,
  };

  const updated: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const saved: Array<Record<string, unknown>> = [];

  const tx = {
    fileObject: {
      create: vi.fn(async () => ({ id: FILE_ID })),
    },
    order: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updated.push(args.data);
        return { id: ORDER_ID };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return { id: 'audit-1' };
      }),
    },
  };

  const prisma = {
    order: { findFirst: vi.fn(async () => order) },
    runInTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    buildOrderScopeFilter: vi.fn(() => ({})),
  };

  const storage = {
    saveRaw: vi.fn(async (args: Record<string, unknown>) => {
      saved.push(args);
      return {
        objectKey: `orders/${ORDER_ID}/pickup-signature/abc.png`,
        mimeType: 'image/png',
        sizeBytes: 7,
        checksum: 'deadbeef',
      };
    }),
  };

  const service = new PickupSignatureService(prisma as never, storage as never);

  return { service, prisma, storage, tx, updated, audits, saved };
}

describe('Подпись клиента: сохранение (дефект 66)', () => {
  it('записывает идентификатор файла в заказ — без этого выдача невозможна', async () => {
    /*
     * Главная проверка. Переход 18 смотрит ровно на это поле: если оно остаётся
     * пустым, заказ нельзя выдать, и сотрудник видит 409 на последнем шаге.
     */
    const { service, updated } = createMocks();

    await service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.pickupSignatureFileId).toBe(FILE_ID);
  });

  it('сохраняет сам файл в хранилище, а не только ссылку', async () => {
    // Ссылка на несуществующий файл прошла бы guard и «выдала» заказ без
    // документа: подписи не было бы ни у кого.
    const { service, saved } = createMocks();

    await service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.folder).toBe(`orders/${ORDER_ID}/pickup-signature`);
    // Именно `saveRaw`, а не обработка изображения: подпись — документ,
    // пережатие исказило бы штрихи росчерка.
    expect(saved[0]?.mimeType).toBe('image/png');
  });

  it('создаёт FileObject с автором и записью в журнал аудита', async () => {
    const { service, tx, audits } = createMocks();

    await service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER });

    expect(tx.fileObject.create).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('PICKUP_SIGNATURE_SAVED');
    expect(audits[0]?.entityId).toBe(ORDER_ID);
  });

  it('отклоняет запрос без файла', async () => {
    // Без файла запись была бы пустой, и guard остался бы невыполненным —
    // сотрудник получил бы отказ на следующем шаге без объяснения.
    const { service, updated } = createMocks();

    await expect(
      service.save({ orderId: ORDER_ID, file: undefined, user: RECEIVER }),
    ).rejects.toMatchObject({ response: { code: 'SIGNATURE_FILE_REQUIRED' } });
    expect(updated).toHaveLength(0);
  });

  it('не находит чужой заказ и не пишет файл', async () => {
    // Защита от IDOR: приложить подпись к заказу вне области видимости нельзя.
    const { service, saved } = createMocks();
    const prisma = (service as unknown as { prisma: { order: { findFirst: unknown } } }).prisma;
    (prisma.order.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER }),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    expect(saved).toHaveLength(0);
  });

  it('отклоняет подпись вне шага выдачи', async () => {
    /*
     * Подпись имеет смысл только при выдаче. Принять её в статусе «Выдано в
     * работу» значило бы открыть переход 18 в обход порядка: заказ ушёл бы в
     * «Выдан» до завершения работ и без оплаты.
     */
    const { service, updated } = createMocks({ status: 'IN_WORK' });

    await expect(
      service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER }),
    ).rejects.toMatchObject({ response: { code: 'SIGNATURE_NOT_APPLICABLE' } });
    expect(updated).toHaveLength(0);
  });

  it('принимает подпись для невостребованного заказа', async () => {
    // Переход 21 ведёт в «Выдан» из «Невостребовано» и охраняется тем же
    // условием: запрет только на `READY_FOR_PICKUP` сделал бы этот путь
    // невыполнимым.
    const { service, updated } = createMocks({ status: 'UNCLAIMED' });

    await service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER });

    expect(updated[0]?.pickupSignatureFileId).toBe(FILE_ID);
  });

  it('позволяет переписать подпись и фиксирует прежнюю в аудите', async () => {
    /*
     * Клиент может расписаться заново: первый росчерк не вышел. Запрет на
     * перезапись заставлял бы администратора править базу вручную, а потеря
     * прежнего значения скрыла бы подмену документа.
     */
    const { service, updated, audits } = createMocks({ pickupSignatureFileId: 'old-file' });

    await service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER });

    expect(updated[0]?.pickupSignatureFileId).toBe(FILE_ID);
    expect(audits[0]?.before).toEqual({ pickupSignatureFileId: 'old-file' });
  });

  it('первая подпись не пишет пустое `before` в аудит', async () => {
    // `before: undefined` означает «значения не было»; пустой объект выглядел бы
    // как замена значения неизвестно на что.
    const { service, audits } = createMocks();

    await service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER });

    expect(audits[0]?.before).toBeUndefined();
  });

  it('область видимости применяется при загрузке заказа', async () => {
    // Фильтр обязан строиться по НАБОРУ областей: у приёмщика со второй ролью
    // логиста (дефект 65) одна область отсекла бы его же заказ.
    const { service, prisma } = createMocks();

    await service.save({ orderId: ORDER_ID, file: FILE, user: RECEIVER });

    expect(prisma.buildOrderScopeFilter).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: RECEIVER.scopes }),
    );
  });
});

describe('Расширение файла для хранилища', () => {
  it('берёт расширение из имени файла', () => {
    expect(extensionFor('sign.png', 'image/png')).toBe('png');
    expect(extensionFor('podpis.JPG', 'image/jpeg')).toBe('jpg');
  });

  it('не пропускает опасное имя в путь', () => {
    /*
     * Имя приходит от клиента. Если расширение не распознано, оно подменяется
     * типом из MIME, а не берётся из строки: значение попадает в КЛЮЧ
     * хранилища, и подстановка имени целиком позволила бы выйти за пределы
     * каталога (`../../etc`).
     */
    expect(extensionFor('../../etc/passwd', 'image/png')).toBe('png');
    expect(extensionFor('sign.', 'image/jpeg')).toBe('jpeg');
  });

  it('при неизвестном типе даёт безопасное значение', () => {
    /*
     * Берутся только «простые» типы: `octet-stream` содержит дефис и в ключ не
     * попадает — подстановка произвольного текста в путь и есть та уязвимость,
     * от которой эта функция защищает. Файл при этом остаётся доступен: точный
     * MIME хранится в `FileObject`.
     */
    expect(extensionFor('sign', 'application/octet-stream')).toBe('bin');
    expect(extensionFor('sign', 'image/svg+xml')).toBe('bin');
    expect(extensionFor('sign', 'нечто')).toBe('bin');
  });
});
