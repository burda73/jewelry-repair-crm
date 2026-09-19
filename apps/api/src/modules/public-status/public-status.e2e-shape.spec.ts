/**
 * Форма публичного ответа: что именно получает клиент (задача 5.11).
 *
 * ## Почему отдельный тест поверх контроллера
 *
 * Тесты сервиса проверяли результат СЕРВИСА и намеренно исключали поле `reason`
 * из сравнения — оно внутреннее. Из-за этого дефект не был пойман: контроллер
 * возвращал результат сервиса ЦЕЛИКОМ, и `reason` уходил клиенту
 * (`ORDER_NOT_FOUND`, `PHONE_MISMATCH`, `RATE_LIMITED`).
 *
 * Это возвращало тот самый оракул, против которого построена вся защита: по
 * ответу можно было перебором номеров выяснить, какие заказы существуют в
 * системе. Найдено на ЖИВОЙ проверке развёрнутого сервера, а не тестами.
 *
 * Здесь проверяется ГОТОВЫЙ HTTP-ответ контроллера — то, что реально увидит
 * клиент. Тест не знает внутренних подробностей сервиса: он подменяет сервис и
 * смотрит на литерал, который вернул контроллер.
 */

import { describe, expect, it, vi } from 'vitest';
import { PublicStatusController } from './public-status.controller';
import type { PublicStatusService } from './public-status.service';

/** Двойник сервиса: возвращает результат с внутренней причиной. */
function makeController(reason: string) {
  const service = {
    requestCode: vi.fn().mockResolvedValue({ sent: true, reason }),
    verifyCode: vi.fn().mockResolvedValue({ ok: false, view: null, reason }),
  };
  return { controller: new PublicStatusController(service as unknown as PublicStatusService) };
}

const VALID_BODY = { orderNo: 'MSK1-2609-000123', phone: '+79001234567' };

describe('Ответ на запрос кода: клиент видит только `sent`', () => {
  it('внутренняя причина НЕ попадает в HTTP-ответ', async () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА. Перебираем внутренние причины — каждая сообщает клиенту
     * что-то, чего он знать не должен: существует ли заказ, совпал ли телефон,
     * исчерпан ли лимит.
     */
    const reasons = [
      'SENT',
      'ORDER_NOT_FOUND',
      'PHONE_MISMATCH',
      'ORDER_NOT_VISIBLE',
      'RATE_LIMITED',
    ];

    for (const reason of reasons) {
      const { controller } = makeController(reason);
      const response = await controller.requestCode(VALID_BODY, '10.0.0.1');

      /*
       * Сравнение со СТРОГИМ литералом, а не проверка отдельных полей: так
       * тест поймает и любое НОВОЕ поле, добавленное в будущем. Именно этого
       * не хватило раньше — проверялось отсутствие конкретного поля.
       */
      expect(response, `причина ${reason} просочилась в ответ`).toEqual({ sent: true });
      expect(Object.keys(response)).toEqual(['sent']);
    }
  });

  it('ответ не содержит слова, различающего случаи', async () => {
    // Поиск по сериализованному ответу, а не по именам полей: ловит и вложенность.
    const { controller } = makeController('ORDER_NOT_FOUND');
    const serialized = JSON.stringify(await controller.requestCode(VALID_BODY, '10.0.0.1'));

    expect(serialized).not.toMatch(/ORDER_NOT_FOUND|NOT_FOUND|MISMATCH|RATE_LIMITED|reason/i);
  });

  it('ответ одинаков при всех причинах', async () => {
    /*
     * Неотличимость как свойство: отпечаток ответа обязан совпасть. Это
     * утверждение о поведении целиком, а не о конкретном поле.
     */
    const fingerprints = new Set<string>();
    const seen: string[] = [];

    for (const reason of ['SENT', 'ORDER_NOT_FOUND', 'PHONE_MISMATCH']) {
      const { controller } = makeController(reason);
      const response = await controller.requestCode(VALID_BODY, '10.0.0.1');
      fingerprints.add(JSON.stringify(response));
      seen.push(reason);
    }

    expect(fingerprints.size).toBe(1);
    expect(seen).toHaveLength(3);
  });

  it('валидация по-прежнему отклоняет мусор', async () => {
    // Проверка входа не должна исчезнуть вместе с правкой формы ответа.
    const { controller } = makeController('SENT');
    await expect(
      controller.requestCode({ orderNo: '', phone: '123' }, '10.0.0.1'),
    ).rejects.toThrow();
  });
});

describe('Ответ на проверку кода: причина остаётся внутренней', () => {
  it('отказ не различает «нет кода» и «неверный код» во внешнем виде', async () => {
    /*
     * Сервис возвращает разные причины (`NOT_FOUND`, `MISMATCH`, `EXPIRED`,
     * `LOCKED`) — они нужны журналу. Публичный ответ обязан быть одинаковым:
     * иначе `404` отличил бы «нет такого заказа» от «код не подошёл», и
     * перебором номеров можно было бы выяснить, какие заказы есть.
     */
    const reasons = ['NOT_FOUND', 'MISMATCH', 'EXPIRED', 'LOCKED', 'INVALID_INPUT'];

    for (const reason of reasons) {
      const { controller } = makeController(reason);
      const response = await controller.status({
        orderNo: 'MSK1-2609-000123',
        code: '1234',
      } as never);

      expect(response.ok).toBe(false);
      expect(response.view).toBeNull();
      // Проверяется, что наружу не ушла причина: остальное — контракт клиента.
      expect(JSON.stringify(response)).not.toContain(reason);
    }
  });
});
