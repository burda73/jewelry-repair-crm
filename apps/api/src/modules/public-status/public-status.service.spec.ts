/**
 * Публичная проверка статуса заказа (задача 5.11).
 *
 * Это единственный эндпоинт системы без входа, и он отдаёт данные чужого заказа
 * по УГАДЫВАЕМОМУ номеру. Поэтому тесты проверяют прежде всего ОТКАЗ и
 * неотличимость ответов: по ответу нельзя понять, существует ли заказ.
 *
 * Prisma подменяется двойником: правила находятся в сервисе, и проверять их
 * через настоящую базу значило бы проверять поведение Postgres.
 */

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicStatusService } from './public-status.service';
import { PUBLIC_CODE_MAX_ATTEMPTS, PUBLIC_CODE_TTL_MS } from '@app/shared';

const ORDER_ID = 'cmu5p70yu0000am7pzqlcawsv';
const ORDER_NO = 'MSK1-2609-000123';
const PHONE = '+79001234567';

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNo: ORDER_NO,
    status: 'READY_FOR_PICKUP',
    dueAt: new Date('2026-10-01T00:00:00Z'),
    totalAmountMinor: 500_000,
    paidAmountMinor: 200_000,
    currency: 'RUB',
    customer: { phoneNormalized: PHONE },
    ...overrides,
  };
}

function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'code-1',
    orderId: ORDER_ID,
    codeHash: hashCode('1234'),
    phoneNormalized: PHONE,
    attempts: 0,
    expiresAt: new Date(Date.now() + PUBLIC_CODE_TTL_MS),
    usedAt: null,
    ip: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function createMock() {
  const mock = {
    order: { findUnique: vi.fn().mockResolvedValue(orderRow()) },
    publicOrderCode: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(codeRow()),
      update: vi.fn().mockResolvedValue(codeRow()),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const notifications = {
    notifyCustomer: vi.fn().mockResolvedValue([{ id: 'n-1' }]),
  };
  return { mock, notifications };
}

function makeService(m: ReturnType<typeof createMock>) {
  return new PublicStatusService(m.mock as never, m.notifications as never);
}

describe('Запрос кода: неотличимость ответов', () => {
  it('несуществующий заказ отвечает так же, как существующий', async () => {
    /*
     * ГЛАВНОЕ ТРЕБОВАНИЕ. Номера заказов угадываемы: формат «МСК1-2609-000001»
     * содержит код магазина, месяц и последовательный номер. Если бы
     * несуществующий заказ давал другой ответ, перебор номеров выявил бы все
     * заказы системы — утечка сама по себе, без показа статуса.
     */
    const existing = createMock();
    const missing = createMock();
    missing.mock.order.findUnique.mockResolvedValue(null);

    const a = await makeService(existing).requestCode({
      orderNo: ORDER_NO,
      phone: PHONE,
      ip: '10.0.0.1',
    });
    const b = await makeService(missing).requestCode({
      orderNo: 'MSK1-2609-999999',
      phone: PHONE,
      ip: '10.0.0.1',
    });

    /*
     * Сравниваем ответы ЦЕЛИКОМ, кроме внутренней причины. Именно так был
     * найден дефект: в ответе было поле `phoneMask`, заполнявшееся только при
     * существующем заказе и совпавшем телефоне, — то есть сам ответ выдавал
     * существование заказа.
     */
    expect(a.sent).toBe(true);
    expect(b.sent).toBe(true);
    expect(Object.keys(a).filter((k) => k !== 'reason')).toEqual(
      Object.keys(b).filter((k) => k !== 'reason'),
    );
    expect(a).not.toHaveProperty('phoneMask');
  });

  it('ни одно поле ответа не зависит от существования заказа', async () => {
    /*
     * Проверка «на будущее»: любое поле, кроме `sent`, обязано быть одинаковым
     * во ВСЕХ случаях отказа — иначе оно вернёт оракул. Перебираем случаи и
     * сверяем отпечаток ответа; расхождение означает новое поле-подсказку.
     *
     * Это надёжнее проверки конкретного поля `phoneMask`: она ловила бы только
     * известный дефект, а здесь ловится сам принцип.
     */
    const cases: { name: string; setup: (m: ReturnType<typeof createMock>) => void }[] = [
      { name: 'заказа нет', setup: (m) => m.mock.order.findUnique.mockResolvedValue(null) },
      {
        name: 'черновик',
        setup: (m) => m.mock.order.findUnique.mockResolvedValue(orderRow({ status: 'DRAFT' })),
      },
      { name: 'телефон не тот', setup: () => undefined },
      { name: 'лимит', setup: (m) => m.mock.publicOrderCode.count.mockResolvedValue(3) },
    ];

    const fingerprints = new Set<string>();
    const seen: string[] = [];

    for (const testCase of cases) {
      const m = createMock();
      testCase.setup(m);
      const phone = testCase.name === 'телефон не тот' ? '+79009999999' : PHONE;

      const result = await makeService(m).requestCode({ orderNo: ORDER_NO, phone, ip: null });
      // Причина — внутренняя и в отпечаток не входит.
      const { reason: _reason, ...visible } = result;
      seen.push(testCase.name);
      fingerprints.add(JSON.stringify(visible));
      expect(visible, `случай «${testCase.name}» раскрывает лишнее`).toEqual({ sent: true });
    }

    // Все случаи обязаны дать ОДИН отпечаток: `{ sent: true }`.
    expect(fingerprints.size).toBe(1);
    // Свидетель: пройдены ВСЕ случаи, а не первый (ранняя ошибка  в цикле).
    expect(seen).toHaveLength(cases.length);
  });

  it('чужой телефон отвечает так же, как свой', async () => {
    /*
     * Второй фактор — телефон клиента. Ответ не должен выдавать, совпал ли он:
     * иначе перебором телефонов можно было бы подобрать номер чужого клиента.
     */
    const m = createMock();
    m.mock.order.findUnique.mockResolvedValue(orderRow());

    const result = await makeService(m).requestCode({
      orderNo: ORDER_NO,
      phone: '+79009999999',
      ip: null,
    });

    expect(result.sent).toBe(true);
    // Код не создаётся и SMS не уходит.
    expect(m.mock.publicOrderCode.create).not.toHaveBeenCalled();
    expect(m.notifications.notifyCustomer).not.toHaveBeenCalled();
  });

  it('исчерпанный лимит не различает существующий и несуществующий заказ', async () => {
    /*
     * Лимит проверяется ДО поиска заказа — поэтому при исчерпанном лимите
     * ответ одинаков всегда, и маршрут нельзя использовать как оракул.
     */
    for (const found of [orderRow(), null]) {
      const m = createMock();
      m.mock.publicOrderCode.count.mockResolvedValue(3);
      m.mock.order.findUnique.mockResolvedValue(found);

      const result = await makeService(m).requestCode({
        orderNo: ORDER_NO,
        phone: PHONE,
        ip: null,
      });

      expect(result.sent).toBe(true);
      expect(m.mock.order.findUnique).not.toHaveBeenCalled();
    }
  });

  it('черновик не получает код', async () => {
    // Черновик публично не виден — и код по нему не выдаётся.
    const m = createMock();
    m.mock.order.findUnique.mockResolvedValue(orderRow({ status: 'DRAFT' }));

    const result = await makeService(m).requestCode({ orderNo: ORDER_NO, phone: PHONE, ip: null });

    expect(result.reason).toBe('ORDER_NOT_VISIBLE');
    expect(m.mock.publicOrderCode.create).not.toHaveBeenCalled();
  });
});

describe('Запрос кода: выдача', () => {
  it('код отправляется и сохраняется ХЕШЕМ, а не открытым текстом', async () => {
    /*
     * Открытый текст означал бы, что сотрудник с доступом к базе или утечка
     * дампа дают вход в чужой заказ, не зная даже телефона клиента.
     */
    const m = createMock();

    const result = await makeService(m).requestCode({ orderNo: ORDER_NO, phone: PHONE, ip: null });

    expect(result.reason).toBe('SENT');
    const created = m.mock.publicOrderCode.create.mock.calls[0]?.[0];
    expect(created.data.codeHash).toMatch(/^[a-f0-9]{64}$/);
    // Сам код в базе не появляется — иначе хеш бессмыслен.
    const values = m.notifications.notifyCustomer.mock.calls[0]?.[0];
    expect(created.data.codeHash).not.toBe(values.values.code);
    expect(values.values.code).toMatch(/^\d{4}$/);
  });

  it('код уходит клиенту через порт уведомлений', async () => {
    // Второй способ отправки SMS означал бы две настройки канала и два ответа на
    // вопрос «почему клиент не получил сообщение».
    const m = createMock();
    await makeService(m).requestCode({ orderNo: ORDER_NO, phone: PHONE, ip: null });

    expect(m.notifications.notifyCustomer).toHaveBeenCalledTimes(1);
    const sent = m.notifications.notifyCustomer.mock.calls[0]?.[0];
    expect(sent.code).toBe('PUBLIC_STATUS_CODE');
    expect(sent.phone).toBe(PHONE);
  });

  it('срок жизни кода отсчитывается от выдачи', async () => {
    const m = createMock();
    const now = new Date('2026-09-19T10:00:00Z');

    await makeService(m).requestCode({ orderNo: ORDER_NO, phone: PHONE, ip: null, now });

    const created = m.mock.publicOrderCode.create.mock.calls[0]?.[0];
    expect(created.data.expiresAt.toISOString()).toBe('2026-09-19T10:10:00.000Z');
  });

  it('повторный запрос при живом коде не отправляет второе SMS', async () => {
    /*
     * Каждое SMS платное. Клиент часто нажимает кнопку дважды, не дождавшись
     * сообщения, — за второе платить незачем, прежний код ещё действует.
     */
    const m = createMock();
    m.mock.publicOrderCode.findFirst.mockResolvedValue(codeRow());

    const result = await makeService(m).requestCode({ orderNo: ORDER_NO, phone: PHONE, ip: null });

    expect(result.reason).toBe('ALREADY_SENT');
    expect(m.mock.publicOrderCode.create).not.toHaveBeenCalled();
    expect(m.notifications.notifyCustomer).not.toHaveBeenCalled();
  });

  it('если канал не включён, отказ попадает в журнал как ошибка', async () => {
    /*
     * В отличие от прочих клиентских уведомлений, здесь код — КЛЮЧ ДОСТУПА:
     * без доставки функция не работает, а клиент будет ждать сообщение. Молчаливое
     * «создали и забыли» оставило бы администратора искать причину в переписке.
     */
    const m = createMock();
    m.notifications.notifyCustomer.mockResolvedValue([]);
    const service = makeService(m);
    const errors: string[] = [];
    const logger = (service as unknown as { logger: { error: (msg: string) => void } }).logger;
    logger.error = (msg: string) => {
      errors.push(msg);
    };

    await service.requestCode({ orderNo: ORDER_NO, phone: PHONE, ip: null });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/НЕ ОТПРАВЛЕН/);
  });

  it('лимит запросов считается по нормализованному телефону', async () => {
    /*
     * Ограничение защищает ДЕНЬГИ, а не систему: SMS платные, и «выкачивают» их
     * с множества адресов на один номер, поэтому счётчик по IP не помог бы.
     * Нормализация обязательна: «8 900…» и «+7 900…» — один и тот же телефон.
     */
    const m = createMock();

    await makeService(m).requestCode({ orderNo: ORDER_NO, phone: '8 (900) 123-45-67', ip: null });

    const counted = m.mock.publicOrderCode.count.mock.calls[0]?.[0];
    expect(counted.where.phoneNormalized).toBe(PHONE);
  });

  it('некорректный телефон не вызывает запрос к базе', async () => {
    // Мусор в поле не должен создавать нагрузку и записи.
    const m = createMock();
    const result = await makeService(m).requestCode({ orderNo: ORDER_NO, phone: '123', ip: null });

    expect(result.sent).toBe(true);
    expect(m.mock.order.findUnique).not.toHaveBeenCalled();
  });
});

describe('Проверка кода: отказы', () => {
  it('неверный формат отвергается без запроса к базе', async () => {
    const m = createMock();
    const result = await makeService(m).verifyCode({ orderNo: ORDER_NO, code: 'abcd' });

    expect(result.reason).toBe('INVALID_INPUT');
    expect(m.mock.order.findUnique).not.toHaveBeenCalled();
  });

  it('истёкший код не действует даже при верных цифрах', async () => {
    const m = createMock();
    m.mock.publicOrderCode.findFirst.mockResolvedValue(
      codeRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const result = await makeService(m).verifyCode({ orderNo: ORDER_NO, code: '1234' });

    expect(result.reason).toBe('EXPIRED');
    expect(result.ok).toBe(false);
    // Код засчитывается как использованный только при успехе.
    expect(m.mock.publicOrderCode.update).not.toHaveBeenCalled();
  });

  it('ИСЧЕРПАННЫЕ ПОПЫТКИ закрывают доступ даже при верном коде', async () => {
    /*
     * ГЛАВНАЯ ЗАЩИТА от перебора. Четыре цифры — 10 000 комбинаций, и без
     * счётчика их подбирают за минуты. Порядок проверок важен: блокировка
     * проверяется ДО сравнения, иначе последняя разрешённая попытка всё ещё
     * работала бы, и смысл ограничения терялся бы.
     */
    const m = createMock();
    m.mock.publicOrderCode.findFirst.mockResolvedValue(
      codeRow({ attempts: PUBLIC_CODE_MAX_ATTEMPTS }),
    );

    const result = await makeService(m).verifyCode({ orderNo: ORDER_NO, code: '1234' });

    expect(result.reason).toBe('LOCKED');
    expect(result.ok).toBe(false);
    expect(m.mock.publicOrderCode.update).not.toHaveBeenCalled();
  });

  it('неверный код увеличивает счётчик попыток', async () => {
    // Счётчик — единственное, что делает четырёхзначный код защитой.
    const m = createMock();
    m.mock.publicOrderCode.findFirst.mockResolvedValue(codeRow());

    const result = await makeService(m).verifyCode({ orderNo: ORDER_NO, code: '9999' });

    expect(result.reason).toBe('MISMATCH');
    const updated = m.mock.publicOrderCode.update.mock.calls[0]?.[0];
    expect(updated.data.attempts).toEqual({ increment: 1 });
  });

  it('несуществующий заказ и отсутствие кода неотличимы', async () => {
    /*
     * Оба случая — `NOT_FOUND`. Различие выдало бы существование заказа:
     * перебором номеров можно было бы узнать, какие заказы есть в системе.
     */
    const missingOrder = createMock();
    missingOrder.mock.order.findUnique.mockResolvedValue(null);
    const noCode = createMock();
    noCode.mock.publicOrderCode.findFirst.mockResolvedValue(null);

    const a = await makeService(missingOrder).verifyCode({ orderNo: 'X', code: '1234' });
    const b = await makeService(noCode).verifyCode({ orderNo: ORDER_NO, code: '1234' });

    expect(a.reason).toBe(b.reason);
    expect(a.reason).toBe('NOT_FOUND');
  });

  it('код считается по последней записи заказа, а не по любому коду', async () => {
    // Иначе ранее выданный код продолжал бы открывать доступ после отзыва.
    const m = createMock();
    await makeService(m).verifyCode({ orderNo: ORDER_NO, code: '1234' });

    const query = m.mock.publicOrderCode.findFirst.mock.calls[0]?.[0];
    expect(query.where.orderId).toBe(ORDER_ID);
    expect(query.where.usedAt).toBeNull();
    expect(query.orderBy.createdAt).toBe('desc');
  });
});

describe('Проверка кода: успех', () => {
  it('верный код открывает заказ и помечается использованным', async () => {
    /*
     * Код ОДНОРАЗОВЫЙ: иначе перехваченное сообщение давало бы доступ до конца
     * срока, а клиент не заметил бы постороннего.
     */
    const m = createMock();
    m.mock.publicOrderCode.findFirst.mockResolvedValue(codeRow());

    const result = await makeService(m).verifyCode({ orderNo: ORDER_NO, code: '1234' });

    expect(result.ok).toBe(true);
    expect(result.view?.orderNo).toBe(ORDER_NO);
    const updated = m.mock.publicOrderCode.update.mock.calls[0]?.[0];
    expect(updated.data.usedAt).toBeInstanceOf(Date);
    // Счётчик попыток при успехе не увеличивается.
    expect(updated.data.attempts).toBeUndefined();
  });

  it('код принимается с пробелами и дефисами', async () => {
    // Код диктуют голосом и записывают как «12 34» — отказывать в этом нельзя.
    const m = createMock();
    m.mock.publicOrderCode.findFirst.mockResolvedValue(codeRow());

    const result = await makeService(m).verifyCode({ orderNo: ORDER_NO, code: '12 34' });

    expect(result.ok).toBe(true);
  });

  it('в ответе нет персональных данных клиента', async () => {
    /*
     * Проверка по существу: публичный ответ обязан содержать минимум
     * (docs/05 §5). Сериализуем и ищем то, чего быть не должно.
     */
    const m = createMock();
    m.mock.publicOrderCode.findFirst.mockResolvedValue(codeRow());

    const result = await makeService(m).verifyCode({ orderNo: ORDER_NO, code: '1234' });
    const serialized = JSON.stringify(result.view);

    expect(serialized).not.toContain('9001234567');
    expect(serialized).not.toMatch(/fullName|customerName|description|diagnosis|address/);
    // Телефон — только маской.
    expect(result.view?.phoneMask).toBe('****4567');
  });

  it('статус, ставший непубличным, закрывает доступ', async () => {
    /*
     * Заказ мог вернуться в черновик между выдачей кода и проверкой. Показать
     * его нельзя, а ответ «заказ не найден» совпадает с обычным отсутствием —
     * то есть не раскрывает незавершённую операцию.
     */
    const m = createMock();
    m.mock.publicOrderCode.findFirst.mockResolvedValue(codeRow());
    m.mock.order.findUnique.mockResolvedValue(orderRow({ status: 'DRAFT' }));

    const result = await makeService(m).verifyCode({ orderNo: ORDER_NO, code: '1234' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NOT_FOUND');
    // Даже при верном коде он НЕ помечается использованным: доступ не состоялся.
    expect(m.mock.publicOrderCode.update).not.toHaveBeenCalled();
  });
});

describe('Очистка истёкших кодов', () => {
  it('удаляются только истёкшие', async () => {
    /*
     * Истёкшие коды — персональные данные (телефон в связке с заказом), хранить
     * их дольше нужного незачем. Использованные удаляются вместе с ними: срок —
     * единственный критерий.
     */
    const m = createMock();
    m.mock.publicOrderCode.deleteMany.mockResolvedValue({ count: 7 });
    const now = new Date('2026-09-19T10:00:00Z');

    const removed = await makeService(m).purgeExpired(now);

    expect(removed).toBe(7);
    const args = m.mock.publicOrderCode.deleteMany.mock.calls[0]?.[0];
    expect(args.where.expiresAt).toEqual({ lt: now });
  });
});
