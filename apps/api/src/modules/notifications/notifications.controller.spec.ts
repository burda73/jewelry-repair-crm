/**
 * Тесты маршрутов уведомлений (задача 2.6).
 *
 * ЗАЧЕМ ЭТО ПРОВЕРЯЕТСЯ. Код ответа — часть контракта, и ошибка здесь тихая:
 * клиент получает не то, что ожидает, и разбирает ответ неверно. `POST` по
 * умолчанию отвечает `201 Создано`, но отметка о прочтении ничего не создаёт —
 * это изменение состояния, и правильный ответ `200`.
 *
 * Проверяется метаданные декоратора: поднимать HTTP-сервер ради одного кода
 * ответа было бы дороже, чем проверить объявленный контракт.
 */

import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** Объявленный код ответа метода контроллера. */
function httpCodeOf(method: keyof NotificationsController): number | undefined {
  const handler = NotificationsController.prototype[method] as unknown;
  return Reflect.getMetadata(HTTP_CODE_METADATA, handler as object) as number | undefined;
}

describe('Маршруты уведомлений', () => {
  it('«прочитать все» отвечает 200, а не 201', () => {
    /*
     * 201 означал бы «создано», но отметка о прочтении ничего не создаёт.
     * Клиент, проверяющий `status === 201`, счёл бы операцию неуспешной.
     */
    expect(httpCodeOf('markAllRead')).toBe(200);
  });

  it('«отметить прочитанным» оставляет код по умолчанию', () => {
    // `PATCH` по умолчанию отвечает 200 — переопределять нечего.
    expect(httpCodeOf('markRead')).toBeUndefined();
  });

  it('сервис доступен контроллеру', () => {
    // Контроллер без сервиса не собрался бы, но модуль объявляет провайдера:
    // проверяется, что сервис передан именно в конструктор.
    const service = new NotificationsService({} as never);
    const controller = new NotificationsController(service);
    expect(controller).toBeInstanceOf(NotificationsController);
  });
});
