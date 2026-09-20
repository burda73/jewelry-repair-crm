/**
 * Тесты клиентов (задача 1.3.2).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Клиент — общая сущность сети, и его дубль не косметический
 * дефект: два дела на одного человека ломают историю ремонтов, а звонок IP-АТС
 * цепляется к произвольной из двух карточек (ТЗ п. 2.4). Поэтому проверяются
 * именно правила, которые схема валидации проверить не может, потому что они
 * зависят от состояния базы:
 *
 *  * поиск по телефону идёт ТОЧНЫМ совпадением по `phoneNormalized`, а не
 *    `contains`: «+7 916 123-45-67», «89161234567» и «79161234567» обязаны
 *    находить одну запись, но «916» не должен находить чужие номера;
 *  * без нормализуемого телефона клиент не создаётся: запись без
 *    `phoneNormalized` невидима для поиска по телефону и превратилась бы в
 *    неустранимый дубль;
 *  * дубликат возвращает 409 с `customerId` существующего клиента — мастер не
 *    показывает ошибку, а подставляет найденную карточку;
 *  * смена телефона проходит те же проверки, что и создание;
 *  * согласия (юридически значимые поля, ТЗ п. 2.4) попадают в аудит с
 *    `before`/`after`: именно след аудита доказывает, что записи разговоров до
 *    отзыва согласия хранились на законном основании.
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса, а не
 * поведение Postgres.
 */

import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CustomersService } from './customers.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { DATA_SCOPE, ROLE } from '@app/shared';

const RECEIVER_ID = 'cmu4cpwbg000bdl0ubltmh740';
const CUSTOMER_ID = 'cmu5p70yu0001bm7pzqlcawsw';
const OTHER_ID = 'cmu5p70yu0002cm7pzqlcawsz';

const RECEIVER: AuthenticatedUser = {
  id: RECEIVER_ID,
  email: 'receiver1@remixgold.ru',
  fullName: 'Приёмщик Первый',
  roles: [ROLE.RECEIVER],
  primaryRole: ROLE.RECEIVER,
  permissions: ['order:create', 'order:read'],
  scope: DATA_SCOPE.OWN_STORE,
  scopes: [DATA_SCOPE.OWN_STORE],
  storeIds: ['cmu5p70yu0009km7pzqlcawt9'],
  mustChangePassword: false,
};

const customerRow = (overrides: Record<string, unknown> = {}) => ({
  id: CUSTOMER_ID,
  fullName: 'Иванов Иван Иванович',
  phone: '+7 (916) 123-45-67',
  phoneNormalized: '+79161234567',
  email: null,
  birthDate: null,
  consentCallRecording: true,
  consentMarketing: false,
  notes: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

function createPrismaMock() {
  const tx = {
    customer: { create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  };

  const prisma = {
    customer: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    runInTransaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    _tx: tx,
  };

  return prisma;
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  return new CustomersService(prisma as never);
}

describe('CustomersService: поиск', () => {
  it('ищет по нормализованному телефону ТОЧНЫМ совпадением', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findMany.mockResolvedValue([
      { ...customerRow(), orders: [], _count: { orders: 0 } },
    ]);

    await makeService(prisma).search('8 916 123-45-67');

    // Именно `phoneNormalized`, а не `contains`: поиск по подстроке нашёл бы и
    // чужие номера, содержащие те же цифры.
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phoneNormalized: '+79161234567' } }),
    );
  });

  it('разные формы записи номера дают один и тот же запрос', async () => {
    const forms = ['+7 (916) 123-45-67', '89161234567', '79161234567', '+79161234567'];
    const wheres: unknown[] = [];

    for (const form of forms) {
      const prisma = createPrismaMock();
      await makeService(prisma).search(form);
      wheres.push(prisma.customer.findMany.mock.calls[0][0].where);
    }

    // Одинаковый `where` у всех форм — это и есть дедупликация при поиске.
    expect(new Set(wheres.map((w) => JSON.stringify(w))).size).toBe(1);
  });

  it('неполный номер ищется по ФИО, а не по телефону', async () => {
    const prisma = createPrismaMock();
    await makeService(prisma).search('Иванов');

    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fullName: { contains: 'Иванов', mode: 'insensitive' } },
      }),
    );
  });

  it('запрос с цифрами, но не собирающийся в E.164, ищет по ФИО', async () => {
    const prisma = createPrismaMock();
    await makeService(prisma).search('Иванов 2');

    // Цифры есть, но это не телефон: ветка по ФИО, иначе поиск вернул бы пусто.
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fullName: { contains: 'Иванов 2', mode: 'insensitive' } },
      }),
    );
  });

  it('пустой запрос возвращает пустой список без обращения к базе', async () => {
    const prisma = createPrismaMock();
    const result = await makeService(prisma).search('   ');

    // Мастер шлёт запрос по мере ввода: 400 на очищенное поле был бы шумом.
    expect(result).toEqual([]);
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('подставляет число заказов и последний заказ', async () => {
    const prisma = createPrismaMock();
    const lastOrder = { id: 'o1', orderNo: 'MSK1-2609-000001' };
    prisma.customer.findMany.mockResolvedValue([
      { ...customerRow(), orders: [lastOrder], _count: { orders: 3 } },
    ]);

    const result = await makeService(prisma).search('+79161234567');

    expect(result[0].ordersCount).toBe(3);
    expect(result[0].lastOrder).toEqual(lastOrder);
  });

  it('клиент без заказов: lastOrder = null, не падение', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findMany.mockResolvedValue([
      { ...customerRow(), orders: [], _count: { orders: 0 } },
    ]);

    const result = await makeService(prisma).search('+79161234567');
    expect(result[0].lastOrder).toBeNull();
  });

  it('фильтр по магазинам НЕ применяется', async () => {
    const prisma = createPrismaMock();
    await makeService(prisma).search('+79161234567');

    // Клиент — общая сущность сети: приёмщик обязан видеть, что человек уже
    // сдавал изделие в другом магазине, иначе примет второе как «нового».
    const where = prisma.customer.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('orders');
    expect(where).not.toHaveProperty('storeId');
  });
});

describe('CustomersService: создание', () => {
  it('нормализует телефон и пишет оба поля', async () => {
    const prisma = createPrismaMock();
    prisma._tx.customer.create.mockResolvedValue(customerRow());

    await makeService(prisma).create(
      { fullName: 'Иванов Иван Иванович', phone: '8 916 123-45-67', consentCallRecording: true },
      RECEIVER,
    );

    const data = prisma._tx.customer.create.mock.calls[0][0].data;
    // `phone` печатается в квитанции, `phoneNormalized` нужен поиску и АТС.
    expect(data.phone).toBe('8 916 123-45-67');
    expect(data.phoneNormalized).toBe('+79161234567');
  });

  it('НЕ создаёт клиента с ненормализуемым телефоном', async () => {
    const prisma = createPrismaMock();
    // 12 цифр: схема такой номер пропускает (в ней только проверка «не короче
    // 10 цифр»), но в E.164 он не собирается. Это и есть реальный случай,
    // который ловит сервис: запись без `phoneNormalized` была бы невидима для
    // поиска по телефону и превратилась бы в неустранимый дубль.
    await expect(
      makeService(prisma).create(
        { fullName: 'Иванов', phone: '999999999999', consentCallRecording: true },
        RECEIVER,
      ),
    ).rejects.toThrow(BadRequestException);

    // Запись без `phoneNormalized` была бы невидима для поиска по телефону —
    // то есть превратилась бы в неустранимый дубль при следующем обращении.
    expect(prisma._tx.customer.create).not.toHaveBeenCalled();
  });

  it('отклоняет дубликат по телефону и возвращает customerId', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findFirst.mockResolvedValue({ id: OTHER_ID });

    let caught: unknown = null;
    try {
      await makeService(prisma).create(
        { fullName: 'Иванов', phone: '+79161234567', consentCallRecording: true },
        RECEIVER,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    // `customerId` — это не деталь: мастер по нему подставляет существующую
    // карточку вместо показа ошибки.
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'CUSTOMER_EXISTS',
      customerId: OTHER_ID,
    });
    expect(prisma._tx.customer.create).not.toHaveBeenCalled();
  });

  it('ищет дубликат по нормализованному номеру', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findFirst.mockResolvedValue(null);
    prisma._tx.customer.create.mockResolvedValue(customerRow());

    await makeService(prisma).create(
      { fullName: 'Иванов', phone: '8 (916) 123-45-67', consentCallRecording: true },
      RECEIVER,
    );

    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { phoneNormalized: '+79161234567' },
    });
  });

  it('пишет в журнал в той же транзакции, с ФИО и без «до»', async () => {
    const prisma = createPrismaMock();
    prisma._tx.customer.create.mockResolvedValue(customerRow());

    await makeService(prisma).create(
      { fullName: 'Иванов Иван Иванович', phone: '+79161234567', consentCallRecording: true },
      RECEIVER,
    );

    expect(prisma._tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      actorId: RECEIVER_ID,
      actorRole: ROLE.RECEIVER,
      action: 'CREATE',
      entity: 'Customer',
      entityId: CUSTOMER_ID,
    });
    // У создания нет «до»: поле отсутствует (см. комментарий в сервисе).
    expect(audit.before).toBeUndefined();
    // Согласие на запись разговора — юридически значимый факт: в аудите должно
    // быть видно, с какими данными клиент был создан.
    expect(audit.after).toMatchObject({ consentCallRecording: true });
  });

  it('пустой email приводится к null, а не к пустой строке', async () => {
    const prisma = createPrismaMock();
    prisma._tx.customer.create.mockResolvedValue(customerRow());

    await makeService(prisma).create(
      { fullName: 'Иванов', phone: '+79161234567', email: '', consentCallRecording: true },
      RECEIVER,
    );

    expect(prisma._tx.customer.create.mock.calls[0][0].data.email).toBeNull();
  });

  it('отклоняет запрос без ФИО', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).create({ phone: '+79161234567', consentCallRecording: true }, RECEIVER),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CustomersService: изменение', () => {
  it('404 на несуществующего клиента', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).update(CUSTOMER_ID, { fullName: 'Петров' }, RECEIVER),
    ).rejects.toThrow(NotFoundException);
  });

  it('смена телефона нормализуется и пишется в оба поля', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(customerRow());
    prisma.customer.findFirst.mockResolvedValue(null);
    prisma._tx.customer.update.mockResolvedValue(
      customerRow({ phone: '8 903 000-11-22', phoneNormalized: '+79030001122' }),
    );

    await makeService(prisma).update(CUSTOMER_ID, { phone: '8 903 000-11-22' }, RECEIVER);

    const data = prisma._tx.customer.update.mock.calls[0][0].data;
    // Оба поля вместе: иначе в квитанции печатался бы старый номер.
    expect(data.phone).toBe('8 903 000-11-22');
    expect(data.phoneNormalized).toBe('+79030001122');
  });

  it('отклоняет смену телефона на занятый другим клиентом', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(customerRow());
    prisma.customer.findFirst.mockResolvedValue({ id: OTHER_ID });

    await expect(
      makeService(prisma).update(CUSTOMER_ID, { phone: '+79030001122' }, RECEIVER),
    ).rejects.toThrow(ConflictException);
    expect(prisma._tx.customer.update).not.toHaveBeenCalled();
  });

  it('исключает самого клиента из проверки дубликата', async () => {
    const prisma = createPrismaMock();
    // У клиента другой номер, поэтому смена заведомо идёт в ветку проверки.
    prisma.customer.findUnique.mockResolvedValue(customerRow({ phoneNormalized: '+79001112233' }));
    prisma.customer.findFirst.mockResolvedValue(null);
    prisma._tx.customer.update.mockResolvedValue(customerRow());

    await makeService(prisma).update(CUSTOMER_ID, { phone: '+79161234567' }, RECEIVER);

    // `id: { not: customerId }` обязателен: без него клиент нашёл бы сам себя.
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { phoneNormalized: '+79161234567', id: { not: CUSTOMER_ID } },
    });
  });

  it('не ищет дубликат, если номер не менялся', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(customerRow());
    prisma._tx.customer.update.mockResolvedValue(customerRow());

    await makeService(prisma).update(CUSTOMER_ID, { phone: '+7 (916) 123-45-67' }, RECEIVER);

    // Лишний запрос в базу на каждое сохранение формы без нужды.
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it('фиксирует отзыв согласия в журнале с «до» и «после»', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(customerRow({ consentCallRecording: true }));
    prisma._tx.customer.update.mockResolvedValue(customerRow({ consentCallRecording: false }));

    await makeService(prisma).update(CUSTOMER_ID, { consentCallRecording: false }, RECEIVER);

    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('UPDATE');
    // Именно след аудита, а не текущее значение поля, доказывает, что записи
    // разговоров до отзыва хранились на законном основании.
    expect((audit.before as { consentCallRecording: boolean }).consentCallRecording).toBe(true);
    expect((audit.after as { consentCallRecording: boolean }).consentCallRecording).toBe(false);
  });

  it('пустой email очищает поле, undefined его не трогает', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(customerRow({ email: 'a@b.ru' }));
    prisma._tx.customer.update.mockResolvedValue(customerRow({ email: null }));

    await makeService(prisma).update(CUSTOMER_ID, { email: '' }, RECEIVER);
    expect(prisma._tx.customer.update.mock.calls[0][0].data.email).toBeNull();

    const prisma2 = createPrismaMock();
    prisma2.customer.findUnique.mockResolvedValue(customerRow({ email: 'a@b.ru' }));
    prisma2._tx.customer.update.mockResolvedValue(customerRow());
    await makeService(prisma2).update(CUSTOMER_ID, { fullName: 'Петров' }, RECEIVER);
    // `undefined` означает «не прислали», а не «очистить»: стирание почты
    // обязано быть явным действием.
    expect(prisma2._tx.customer.update.mock.calls[0][0].data.email).toBeUndefined();
  });

  it('отклоняет пустой запрос на изменение', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(customerRow());

    await expect(makeService(prisma).update(CUSTOMER_ID, {}, RECEIVER)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('CustomersService: карточка', () => {
  it('404 на несуществующего клиента', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(null);

    await expect(makeService(prisma).findOne(CUSTOMER_ID)).rejects.toThrow(NotFoundException);
  });

  it('отдаёт карточку с историей заказов', async () => {
    const prisma = createPrismaMock();
    prisma.customer.findUnique.mockResolvedValue(customerRow());

    const result = await makeService(prisma).findOne(CUSTOMER_ID);
    expect(result.id).toBe(CUSTOMER_ID);
  });
});
