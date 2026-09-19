/**
 * Тесты правил повтора доставки (задача 5.9, docs/05 §6.3).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Правило «повторять или нет» определяет, что произойдёт с
 * уведомлением, которое не удалось отправить. Ошибка здесь не видна сразу:
 * сообщение либо теряется молча, либо очередь растёт бесконечно, и разбираться
 * придётся по журналу отправки, когда получатель уже не получил важное.
 *
 *  * ПОСТОЯННУЮ ОШИБКУ ПОВТОРЯТЬ БЕССМЫСЛЕННО. Неверный адрес не исправится
 *    сам, а очередь будет расти с каждой попыткой.
 *  * НЕИЗВЕСТНУЮ ОШИБКУ БЕЗОПАСНЕЕ ПОВТОРИТЬ. Потерянное уведомление хуже
 *    лишней попытки: «заказ готов» человек не увидит, если попытку пропустить.
 *  * ПОПЫТКИ ОГРАНИЧЕНЫ. Иначе недоступная почта забивает очередь, и новые
 *    ошибки в ней не видны.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SEND_ATTEMPTS,
  canRetry,
  isRetryDue,
  isRetryableByCode,
  isRetryableHttpStatus,
  retryDelayMs,
} from './notification.port.js';

describe('Временная или постоянная ошибка (задача 5.9)', () => {
  it('5xx считается постоянной ошибкой', () => {
    /*
     * Сервер отказал по своей воле: адрес отвергнут, доступ запрещён. Повтор
     * закончится тем же ответом, а очередь будет расти.
     */
    expect(isRetryableByCode(500)).toBe(false);
    expect(isRetryableByCode(550)).toBe(false);
    expect(isRetryableByCode(599)).toBe(false);
  });

  it('4xx считается временной ошибкой', () => {
    // SMTP: 421 — сервис недоступен, 451 — локальная ошибка. Оба могут пройти.
    expect(isRetryableByCode(421)).toBe(true);
    expect(isRetryableByCode(450)).toBe(true);
    expect(isRetryableByCode(499)).toBe(true);
  });

  it('код строкой разбирается так же, как числом', () => {
    // Почтовые серверы и HTTP-шлюзы отвечают кодом в тексте, и адаптеры
    // передают его как есть.
    expect(isRetryableByCode('550')).toBe(false);
    expect(isRetryableByCode('451')).toBe(true);
  });

  it('отсутствие кода считается временной ошибкой', () => {
    /*
     * Ошибка сети не имеет кода: сервер мог быть недоступен минуту. Считать её
     * постоянной означало бы терять уведомления при коротком сбое.
     */
    expect(isRetryableByCode(null)).toBe(true);
    expect(isRetryableByCode(undefined)).toBe(true);
    expect(isRetryableByCode('')).toBe(true);
  });

  it('нераспознанный код считается временной ошибкой', () => {
    /*
     * Неизвестную ошибку безопаснее повторить: потерянное уведомление хуже
     * лишней попытки. «Заказ готов» человек не увидит, если попытку пропустить.
     */
    expect(isRetryableByCode('ECONNREFUSED')).toBe(true);
    expect(isRetryableByCode(0)).toBe(true);
    expect(isRetryableByCode(200)).toBe(true);
  });

  it('граница 500 и 600 точная', () => {
    // Ошибка на единицу: 499 повторили бы как постоянную, а 600 — как временную.
    expect(isRetryableByCode(499)).toBe(true);
    expect(isRetryableByCode(500)).toBe(false);
    expect(isRetryableByCode(600)).toBe(true);
  });
});

describe('Число попыток (задача 5.9)', () => {
  it('первая попытка разрешена', () => {
    expect(canRetry(0)).toBe(true);
  });

  it('попытки ограничены', () => {
    /*
     * Иначе недоступная почта забивает очередь, и новые ошибки в ней не видны.
     * Три попытки: первая сразу, две с задержкой.
     */
    expect(canRetry(MAX_SEND_ATTEMPTS - 1)).toBe(true);
    expect(canRetry(MAX_SEND_ATTEMPTS)).toBe(false);
    expect(canRetry(MAX_SEND_ATTEMPTS + 5)).toBe(false);
  });

  it('задержка растёт с каждой попыткой', () => {
    // Короткий сбой должен пройти МЕЖДУ попытками, а не упереться в них.
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
    expect(retryDelayMs(3)).toBeGreaterThan(retryDelayMs(2));
  });

  it('задержка положительна для любой попытки', () => {
    // Нулевая задержка означала бы мгновенный повтор: сервер не успел бы
    // восстановиться, а три попытки заняли бы миллисекунды.
    for (const attempt of [0, 1, 2, 3]) {
      expect(retryDelayMs(attempt), `попытка ${attempt}`).toBeGreaterThan(0);
    }
  });
});

describe('Готовность к повторной попытке (задача 5.9)', () => {
  const now = new Date('2025-09-15T12:00:00.000Z');

  it('первая попытка выполняется сразу', () => {
    // Уведомление о готовности заказа не должно ждать минуту.
    expect(isRetryDue(0, now, now)).toBe(true);
  });

  it('повтор ждёт положенную задержку', () => {
    /*
     * Без ожидания три попытки займут миллисекунды, и все три придутся на тот же
     * момент недоступности почты. Смысл повтора в том, чтобы дождаться
     * восстановления.
     */
    const justFailed = new Date(now.getTime() - 1_000);
    expect(isRetryDue(1, justFailed, now)).toBe(false);

    const waited = new Date(now.getTime() - retryDelayMs(1));
    expect(isRetryDue(1, waited, now)).toBe(true);
  });

  it('граница задержки включительная', () => {
    // Ровно истёкшая задержка — пора повторять.
    const exactly = new Date(now.getTime() - retryDelayMs(1));
    expect(isRetryDue(1, exactly, now)).toBe(true);
  });

  it('исчерпанные попытки не повторяются ни при каких условиях', () => {
    /*
     * Даже если с момента последней попытки прошли сутки: уведомление остаётся
     * в журнале с ошибкой, но воркер его не берёт. Иначе очередь никогда не
     * опустеет.
     */
    const longAgo = new Date(now.getTime() - 86_400_000);
    expect(isRetryDue(MAX_SEND_ATTEMPTS, longAgo, now)).toBe(false);
  });

  it('вторая задержка длиннее первой', () => {
    // Проверка через `isRetryDue`, а не через саму функцию: важно, что воркер
    // действительно ждёт дольше, а не что числа разные.
    const afterFirstDelay = new Date(now.getTime() - retryDelayMs(1));
    expect(isRetryDue(2, afterFirstDelay, now)).toBe(false);

    const afterSecondDelay = new Date(now.getTime() - retryDelayMs(2));
    expect(isRetryDue(2, afterSecondDelay, now)).toBe(true);
  });
});

describe('Временность ошибки по HTTP-статусу (задача 5.10)', () => {
  it('4xx — постоянная ошибка', () => {
    /*
     * Обратная трактовка по сравнению с SMTP. Неверный номер или отклонённый
     * ключ доступа не исправятся повтором, а очередь будет расти с каждой
     * попыткой и мешать видеть новые ошибки.
     */
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it('5xx — временная ошибка', () => {
    // Сбой на стороне шлюза обычно проходит между попытками.
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
  });

  it('408 и 429 временные, несмотря на 4xx', () => {
    /*
     * Сервер просит повторить позже. Отнести их к постоянным значило бы терять
     * уведомления именно тогда, когда шлюз перегружен.
     */
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
  });

  it('трактовка диапазонов противоположна SMTP', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА ВСЕЙ ФУНКЦИИ. Именно совпадение трактовок было бы ошибкой:
     * общая функция на два протокола дала бы одному из каналов обратную политику
     * повторов.
     */
    expect(isRetryableByCode(500)).toBe(false);
    expect(isRetryableHttpStatus(500)).toBe(true);

    expect(isRetryableByCode(450)).toBe(true);
    expect(isRetryableHttpStatus(450)).toBe(false);
  });

  it('отсутствие статуса считается временным', () => {
    // Ошибка сети: сервер мог быть недоступен минуту.
    expect(isRetryableHttpStatus(null)).toBe(true);
    expect(isRetryableHttpStatus(undefined)).toBe(true);
  });

  it('статус вне известных диапазонов считается временным', () => {
    // Неизвестную ошибку безопаснее повторить, чем потерять уведомление.
    expect(isRetryableHttpStatus(200)).toBe(true);
    expect(isRetryableHttpStatus(600)).toBe(true);
  });
});
