/**
 * Публичные маршруты проверки статуса (задача 5.11).
 *
 * Проверяются метаданные маршрутов: пометка `@Public()` и ограничение частоты.
 * Их потеря не проявится ни в компиляции, ни в тестах сервиса — только в том,
 * что маршрут закроется для клиента (401) или станет доступен для перебора.
 */

import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { PublicStatusController } from './public-status.controller';
import {
  PUBLIC_CODE_DIGITS,
  PUBLIC_CODE_MAX_ATTEMPTS,
  PUBLIC_CODE_REQUESTS_PER_HOUR,
  PUBLIC_CODE_TTL_MS,
} from '@app/shared';

const proto = PublicStatusController.prototype;

/**
 * Прочитать ограничение частоты с метода.
 *
 * `@Throttle` пишет метаданные ключом вида `THROTTLER:LIMITshort`, то есть имя
 * лимита входит в сам ключ. Поэтому собираем ключ из имени, а не ищем по
 * префиксу: так тест сломается заметно, если библиотека сменит формат.
 */
function throttleOf(method: 'requestCode' | 'status'): { limit: number; ttl: number } | null {
  const target = proto[method];
  const limit = Reflect.getMetadata(`${THROTTLER_LIMIT}short`, target) as number | undefined;
  const ttl = Reflect.getMetadata(`${THROTTLER_TTL}short`, target) as number | undefined;
  if (limit === undefined || ttl === undefined) return null;
  return { limit, ttl };
}

describe('Публичные маршруты: пометка @Public', () => {
  it('запрос кода открыт без входа', () => {
    /*
     * Без этой пометки `JwtAuthGuard` закрыл бы маршрут, и публичная страница
     * перестала бы работать целиком: клиент не смог бы получить код.
     */
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.requestCode)).toBe(true);
  });

  it('проверка статуса открыта без входа', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.status)).toBe(true);
  });

  it('подсказка о параметрах открыта без входа', () => {
    // Интерфейс читает её до ввода кода, то есть ещё без всякой сессии.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.limits)).toBe(true);
  });
});

describe('Публичные маршруты: ограничение частоты', () => {
  it('окно ограничения совпадает с окном лимита по телефону', () => {
    /*
     * Два ограничения должны смотреть на один горизонт, иначе они противоречат
     * друг другу: адресное с более коротким окном пропускало бы больше, чем
     * разрешено телефону, и ограничение по телефону стало бы единственным.
     */
    const throttle = throttleOf('requestCode');
    expect(throttle?.ttl).toBe(60 * 60 * 1000);
  });

  it('лимит по адресу НЕ МЕШАЕТ исчерпать попытки по коду', () => {
    /*
     * ЖИВОЙ ДЕФЕКТ. С лимитом 10/мин клиент получал `429` на четвёртой попытке
     * ввода кода — раньше, чем срабатывал счётчик попыток (5). То есть честный
     * клиент, ошибшийся в цифрах, видел «слишком много запросов» вместо «код не
     * подошёл» и не мог воспользоваться оставшимися попытками.
     *
     * Поэтому лимит по адресу обязан быть СТРОГО больше числа попыток: иначе
     * ограничение по адресу подменяет собой ограничение по коду и меняет
     * поведение для обычного пользователя.
     */
    const throttle = throttleOf('status');
    expect(throttle).not.toBeNull();
    expect(throttle?.limit).toBeGreaterThan(PUBLIC_CODE_MAX_ATTEMPTS);
  });

  it('перебор по адресу всё равно ограничен', () => {
    /*
     * Обратная сторона: лимит не должен быть «без ограничения». Перебор
     * ограничивает счётчик попыток по коду, но грубый поток запросов с одного
     * адреса обязан упираться в предел — иначе это бесплатный способ нагрузить
     * систему, доступный любому.
     */
    const throttle = throttleOf('status');
    expect(throttle?.limit).toBeLessThanOrEqual(60);
    expect(throttle?.ttl).toBe(60_000);
  });
});

describe('Публичные маршруты: подсказка о параметрах', () => {
  it('значения берутся из доменных констант', () => {
    /*
     * Если подсказка разойдётся с реальным сроком жизни кода, клиент будет
     * ждать код, который уже не действует. Проверяем совпадение с константами.
     */
    const controller = new PublicStatusController({} as never);
    const limits = controller.limits();

    expect(limits.codeDigits).toBe(PUBLIC_CODE_DIGITS);
    expect(limits.ttlMinutes).toBe(Math.round(PUBLIC_CODE_TTL_MS / 60_000));
    expect(limits.requestsPerHour).toBe(PUBLIC_CODE_REQUESTS_PER_HOUR);
  });

  it('подсказка не раскрывает внутренних лимитов', () => {
    /*
     * `limits` отдаётся наружу, поэтому в ответе не должно быть числа попыток и
     * длины окна запросов: это подсказки для перебора. Клиенту достаточно знать
     * срок жизни кода и сколько раз можно запросить новый.
     */
    const controller = new PublicStatusController({} as never);
    const keys = Object.keys(controller.limits()).sort();
    expect(keys).toEqual(['codeDigits', 'requestsPerHour', 'ttlMinutes']);
  });
});
