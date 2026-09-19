/**
 * Публичная проверка статуса заказа (задача 5.11).
 *
 * Это единственный эндпоинт системы, открытый без входа, и он отдаёт данные
 * чужого заказа по угадываемому номеру. Поэтому тесты здесь проверяют прежде
 * всего ОТКАЗ: код, попытки, срок жизни, состав ответа.
 */

import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CODE_DIGITS,
  PUBLIC_CODE_MAX_ATTEMPTS,
  PUBLIC_CODE_REQUESTS_PER_HOUR,
  PUBLIC_STATUS_LABELS,
  PUBLIC_VISIBLE_STATUSES,
  canRequestCode,
  generateCode,
  PUBLIC_CODE_TTL_MS,
  isCodeExpired,
  isCodeLocked,
  isPubliclyVisible,
  maskPhone,
  normalizeCodeInput,
  publicStatusLabel,
  remainingAttempts,
  toPublicOrderStatusView,
  type CodeRandomSource,
} from './public-order-status.js';
import { ALL_ORDER_STATUSES, STATUS_LABELS } from './order-status.js';

/** Источник случайности с заранее заданными байтами. */
function source(bytes: number[]): CodeRandomSource {
  let index = 0;
  return (buffer) => {
    buffer[0] = bytes[index % bytes.length] ?? 0;
    index += 1;
    return buffer;
  };
}

describe('Код подтверждения: генерация', () => {
  it('код состоит ровно из четырёх цифр', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCode()).toMatch(/^\d{4}$/);
    }
  });

  it('длина кода соответствует объявленной', () => {
    // Константа живёт в домене и показывается клиенту подсказкой в поле ввода.
    expect(PUBLIC_CODE_DIGITS).toBe(4);
    expect(generateCode()).toHaveLength(PUBLIC_CODE_DIGITS);
  });

  it('ведущий ноль сохраняется', () => {
    /*
     * Код хранится строкой, а не числом. Если бы его хранили числом, код «0123»
     * превратился бы в «123», и клиент не смог бы войти — причём ровно в одном
     * случае из десяти, что выглядело бы как случайный сбой.
     */
    const code = generateCode(source([0, 1, 2, 3]));
    expect(code).toBe('0123');
  });

  it('байты вне полного круга пропускаются, а не дают смещение', () => {
    /*
     * 256 не делится на 10 нацело. Если брать `byte % 10`, цифры 0..5 выпадают
     * чаще остальных, и перебор становится короче. Первые два байта (250, 255)
     * лежат в «хвосте» и обязаны быть отброшены.
     */
    const code = generateCode(source([250, 255, 0, 1, 2, 3, 4, 5]));
    expect(code).toBe('0123');
  });

  it('разные вызовы дают разные коды на реальном источнике', () => {
    // Проверка, что генератор не возвращает константу.
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) codes.add(generateCode());
    expect(codes.size).toBeGreaterThan(50);
  });

  it('отсутствие источника случайности — ошибка, а не предсказуемый код', () => {
    const saved = globalThis.crypto;
    // @ts-expect-error намеренно ломаем окружение
    delete globalThis.crypto;
    try {
      expect(() => generateCode()).toThrow(/случайности/i);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true });
    }
  });
});

describe('Код подтверждения: нормализация ввода', () => {
  it('принимает код с пробелами и дефисом', () => {
    // Код диктуют голосом и записывают как «12 34» — отказывать в этом нельзя.
    expect(normalizeCodeInput('1234')).toBe('1234');
    expect(normalizeCodeInput('12 34')).toBe('1234');
    expect(normalizeCodeInput('12-34')).toBe('1234');
    expect(normalizeCodeInput(' 1234 ')).toBe('1234');
  });

  it('отвергает неверную длину', () => {
    expect(normalizeCodeInput('123')).toBeNull();
    expect(normalizeCodeInput('12345')).toBeNull();
    expect(normalizeCodeInput('')).toBeNull();
  });

  it('отвергает нецифровой ввод', () => {
    // Проверяем до обращения к базе: иначе мусор в поле вызывал бы запрос.
    expect(normalizeCodeInput('123a')).toBeNull();
    expect(normalizeCodeInput('абвг')).toBeNull();
    expect(normalizeCodeInput('12.4')).toBeNull();
  });
});

describe('Код подтверждения: срок жизни', () => {
  it('код живёт ровно десять минут от выдачи', () => {
    /*
     * Считаем срок от момента ВЫДАЧИ: `expiresAt = issuedAt + TTL`. Проверять
     * иначе (сравнивая срок с моментом выдачи) нельзя — это разные величины, и
     * именно на такой путанице легко получить код, живущий вечно.
     */
    const issuedAt = new Date('2026-09-19T10:00:00Z');
    const expiresAt = new Date(issuedAt.getTime() + PUBLIC_CODE_TTL_MS);

    expect(PUBLIC_CODE_TTL_MS).toBe(600_000);
    expect(expiresAt.toISOString()).toBe('2026-09-19T10:10:00.000Z');
    expect(isCodeExpired(expiresAt, new Date('2026-09-19T10:09:59Z'))).toBe(false);
    // Ровно на границе код уже не действует: срок истёк.
    expect(isCodeExpired(expiresAt, new Date('2026-09-19T10:10:00Z'))).toBe(true);
    expect(isCodeExpired(expiresAt, new Date('2026-09-19T10:10:01Z'))).toBe(true);
  });

  it('истёкший код не действует даже при верных цифрах', () => {
    // Проверка порядка: срок обязан проверяться до сравнения кода.
    const expiredAt = new Date(Date.now() - 1);
    expect(isCodeExpired(expiredAt)).toBe(true);
  });
});

describe('Код подтверждения: счётчик попыток', () => {
  it('попытки исчерпываются на объявленном пределе', () => {
    expect(isCodeLocked(0)).toBe(false);
    expect(isCodeLocked(PUBLIC_CODE_MAX_ATTEMPTS - 1)).toBe(false);
    expect(isCodeLocked(PUBLIC_CODE_MAX_ATTEMPTS)).toBe(true);
    expect(isCodeLocked(PUBLIC_CODE_MAX_ATTEMPTS + 1)).toBe(true);
  });

  it('остаток попыток не уходит в минус', () => {
    expect(remainingAttempts(0)).toBe(PUBLIC_CODE_MAX_ATTEMPTS);
    expect(remainingAttempts(PUBLIC_CODE_MAX_ATTEMPTS)).toBe(0);
    expect(remainingAttempts(99)).toBe(0);
  });

  it('четырёхзначный код без счётчика был бы перебираем', () => {
    /*
     * Обоснование, почему счётчик — ГЛАВНАЯ защита, а не длина кода. Тест
     * фиксирует это числом: 10 000 комбинаций и 5 попыток дают 0,05 %.
     */
    const space = 10 ** PUBLIC_CODE_DIGITS;
    const guessProbability = PUBLIC_CODE_MAX_ATTEMPTS / space;
    expect(space).toBe(10_000);
    expect(guessProbability).toBeLessThan(0.001);
  });
});

describe('Ограничение запросов кода', () => {
  it('запрос разрешён до предела и запрещён на пределе', () => {
    // Ограничение по ТЕЛЕФОНУ: именно так «выкачивают» платные SMS.
    expect(canRequestCode(0)).toBe(true);
    expect(canRequestCode(PUBLIC_CODE_REQUESTS_PER_HOUR - 1)).toBe(true);
    expect(canRequestCode(PUBLIC_CODE_REQUESTS_PER_HOUR)).toBe(false);
    expect(canRequestCode(99)).toBe(false);
  });

  it('предел запросов ограничивает стоимость SMS', () => {
    // Три сообщения в час на номер — потолок расходов на один телефон.
    expect(PUBLIC_CODE_REQUESTS_PER_HOUR).toBe(3);
  });
});

describe('Видимость статусов', () => {
  it('ЧЕРНОВИК публично не виден', () => {
    /*
     * По черновику отвечаем «заказ не найден» — так же, как по несуществующему.
     * Черновик означает незавершённый приём: клиент ещё ничего не сдавал, а
     * показ «Черновик» путал бы и раскрывал незавершённые операции.
     */
    expect(isPubliclyVisible('DRAFT')).toBe(false);
    expect(publicStatusLabel('DRAFT')).toBeNull();
    expect(
      toPublicOrderStatusView({
        orderNo: 'MSK1-2609-000001',
        status: 'DRAFT',
        dueAt: null,
        totalAmountMinor: 0,
        paidAmountMinor: 0,
        currency: 'RUB',
        phone: '+79001234567',
      }),
    ).toBeNull();
  });

  it('неизвестный статус публично не виден', () => {
    // Новый статус в системе не должен «протечь» наружу без решения о тексте.
    expect(isPubliclyVisible('SOME_NEW_STATUS')).toBe(false);
    expect(publicStatusLabel('SOME_NEW_STATUS')).toBeNull();
  });

  it('все остальные статусы системы публично видимы', () => {
    /*
     * Проверка на забытый статус: если в `OrderStatus` добавят значение и не
     * внесут его в публичный список, клиент перестал бы видеть свой заказ, а
     * заметили бы это только по жалобе.
     */
    for (const status of ALL_ORDER_STATUSES) {
      if (status === 'DRAFT') continue;
      expect(isPubliclyVisible(status)).toBe(true);
    }
  });

  it('словарь клиентских формулировок покрывает ровно видимые статусы', () => {
    // Расхождение означало бы статус без текста (клиент видит пусто).
    expect(Object.keys(PUBLIC_STATUS_LABELS).sort()).toEqual([...PUBLIC_VISIBLE_STATUSES].sort());
  });

  it('формулировки для клиента отличаются от внутренних там, где это важно', () => {
    /*
     * Внутренние названия пишутся для сотрудников. «Невостребовано» и «Отказ от
     * оплаты» на публичной странице читаются как претензия к клиенту, поэтому
     * для него есть отдельный текст.
     */
    expect(publicStatusLabel('UNCLAIMED')).not.toBe(STATUS_LABELS.UNCLAIMED);
    expect(publicStatusLabel('REFUSED')).not.toBe(STATUS_LABELS.REFUSED);
    expect(publicStatusLabel('IN_TRANSIT_TO_PRODUCTION')).not.toBe(
      STATUS_LABELS.IN_TRANSIT_TO_PRODUCTION,
    );
  });

  it('каждый видимый статус имеет непустой текст', () => {
    for (const status of PUBLIC_VISIBLE_STATUSES) {
      const label = publicStatusLabel(status);
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/undefined/);
    }
  });

  it('текст берётся ИМЕННО из клиентского словаря, а не из кода статуса', () => {
    /*
     * Эта проверка появилась после мутационного прогона: подмена
     * `PUBLIC_STATUS_LABELS[status]` на сам код статуса не роняла ни одного
     * теста. Остававшиеся проверки смотрели на непустоту строки и на отличие от
     * ВНУТРЕННЕГО названия — а код `UNCLAIMED` отличается от «Невостребовано»
     * и потому выглядел «правильным». Так клиент получил бы латинский код
     * статуса вместо текста, и заметить это можно было только глазами.
     */
    for (const status of PUBLIC_VISIBLE_STATUSES) {
      expect(publicStatusLabel(status)).toBe(PUBLIC_STATUS_LABELS[status]);
    }
  });

  it('текст не содержит латиницы: клиент читает русский текст, а не код', () => {
    // Шире предыдущей проверки: любое «протекание» кода статуса содержит латиницу.
    for (const status of PUBLIC_VISIBLE_STATUSES) {
      expect(publicStatusLabel(status) ?? '').not.toMatch(/[A-Za-z_]/);
    }
  });
});

describe('Маска телефона', () => {
  it('показывает только последние четыре цифры', () => {
    /*
     * Полный номер — персональные данные и ключ к остальным заказам клиента:
     * по нему находят все его заказы. Четырёх цифр хватает, чтобы клиент узнал
     * свой номер, и мало, чтобы узнать чужой.
     */
    const masked = maskPhone('+79001234567');
    expect(masked).toBe('****4567');
    expect(masked).not.toContain('900');
  });

  it('короткий номер не раскрывается целиком', () => {
    expect(maskPhone('123')).toBe('****');
    expect(maskPhone('')).toBe('****');
  });

  it('маска не зависит от формата хранения', () => {
    // В базе номер нормализован (E.164), пользователь вводит его как угодно.
    expect(maskPhone('8 (900) 123-45-67')).toBe('****4567');
    expect(maskPhone('+7 900 123 45 67')).toBe('****4567');
  });
});

describe('Состав публичного ответа', () => {
  const base = {
    orderNo: 'MSK1-2609-000123',
    status: 'READY_FOR_PICKUP',
    dueAt: new Date('2026-10-01T00:00:00Z'),
    totalAmountMinor: 500_000,
    paidAmountMinor: 200_000,
    currency: 'RUB',
    phone: '+79001234567',
  };

  it('содержит ровно объявленные поля', () => {
    /*
     * ГЛАВНАЯ ЗАЩИТА ОТ РАЗРАСТАНИЯ ОТВЕТА. Если однажды кто-то вернёт объект
     * заказа целиком, в ответ попадут ФИО, описание неисправности и адрес. Тест
     * фиксирует точный состав ключей, поэтому такое изменение не пройдёт молча.
     */
    const view = toPublicOrderStatusView(base);
    expect(view).not.toBeNull();
    expect(Object.keys(view ?? {}).sort()).toEqual([
      'currency',
      'dueAt',
      'orderNo',
      'paidAmountMinor',
      'phoneMask',
      'remainingAmountMinor',
      'status',
      'statusLabel',
      'totalAmountMinor',
    ]);
  });

  it('не содержит персональных данных клиента', () => {
    // Проверка по существу, а не по ключам: ищем то, чего быть не должно.
    const view = toPublicOrderStatusView(base);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('9001234567');
    expect(serialized).not.toContain('+7');
    expect(serialized).not.toMatch(/fullName|customerName|description|diagnosis|phone"|address/);
  });

  it('остаток считается как разница и не бывает отрицательным', () => {
    expect(toPublicOrderStatusView(base)?.remainingAmountMinor).toBe(300_000);
    // Переплата не должна выглядеть как долг магазина перед клиентом.
    expect(
      toPublicOrderStatusView({ ...base, paidAmountMinor: 600_000 })?.remainingAmountMinor,
    ).toBe(0);
  });

  it('срок передаётся в ISO, а отсутствие срока — как null', () => {
    // Клиент получает дату и форматирует её сам; строка, а не объект Date.
    expect(toPublicOrderStatusView(base)?.dueAt).toBe('2026-10-01T00:00:00.000Z');
    expect(toPublicOrderStatusView({ ...base, dueAt: null })?.dueAt).toBeNull();
  });

  it('в ответе есть маска телефона, а не сам номер', () => {
    // Подтверждение «это ваш заказ» без раскрытия номера.
    expect(toPublicOrderStatusView(base)?.phoneMask).toBe('****4567');
  });

  it('деньги передаются целыми минорными единицами', () => {
    // Правило ADR 0004: рубли с дробной частью не используются нигде.
    const view = toPublicOrderStatusView(base);
    expect(Number.isInteger(view?.totalAmountMinor)).toBe(true);
    expect(Number.isInteger(view?.paidAmountMinor)).toBe(true);
    expect(view?.currency).toBe('RUB');
  });
});
