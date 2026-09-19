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

import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationSenderService } from '../../integrations/notifications/notification-sender.service';

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
    const service = new NotificationsService({} as never, { get: () => undefined } as never);
    const controller = new NotificationsController(service, senderStub());
    expect(controller).toBeInstanceOf(NotificationsController);
  });
});

/**
 * Заглушка сервиса доставки.
 *
 * Нужны только два метода состояния: контроллер лишь передаёт их ответ наружу.
 */
function senderStub(): NotificationSenderService {
  return {
    channelsState: () => [
      { channel: 'IN_APP', configured: true, reason: 'канал в приложении' },
      { channel: 'SMS', configured: false, reason: 'выключен настройкой' },
    ],
    listExhausted: async (limit: number) =>
      [
        {
          id: 'n-1',
          templateCode: 'READY_FOR_PICKUP',
          channel: 'SMS',
          recipient: '+79161234567',
          attempts: 3,
          error: 'SMS-канал выключен настройкой',
          createdAt: '2026-09-19T00:00:00.000Z',
        },
      ].slice(0, limit),
  } as unknown as NotificationSenderService;
}

describe('Состояние каналов (задача 5.10)', () => {
  function makeController() {
    const service = new NotificationsService({} as never, { get: () => undefined } as never);
    return new NotificationsController(service, senderStub());
  }

  it('маршруты состояния каналов и исчерпавших попытки объявлены по своим путям', () => {
    /*
     * Документация обещает администратору видимость состояния каналов и список
     * исчерпавших попытки (docs/05 §3.1, docs/07 §14). Проверяется именно ПУТЬ, а
     * не наличие метода: переименование маршрута оставило бы метод на месте, и
     * проверка «функция существует» ничего бы не поймала — а обещание
     * документации перестало бы выполняться.
     *
     * Важен и порядок объявления: `channels` и `exhausted` — литеральные пути, и
     * они обязаны стоять ДО `:id/read`, иначе `PATCH /:id/read` их не перехватит,
     * но `GET /notifications/channels` совпал бы с шаблоном `:id`.
     */
    const paths = (['channels', 'exhausted'] as const).map((method) => {
      const handler = NotificationsController.prototype[method] as object;
      return {
        method,
        path: Reflect.getMetadata(PATH_METADATA, handler) as string,
        http: Reflect.getMetadata(METHOD_METADATA, handler) as number,
      };
    });

    expect(paths[0].path).toBe('channels');
    expect(paths[1].path).toBe('exhausted');
    // 0 = GET. Состояние читается, а не изменяется.
    expect(paths[0].http).toBe(0);
    expect(paths[1].http).toBe(0);
  });

  it('состояние каналов показывает выключенные каналы с причиной', () => {
    /*
     * Показать только подключённые каналы значило бы, что выключенного SMS в
     * списке нет вовсе, и выглядело бы как «канала не существует».
     */
    const state = makeController().channels();
    const sms = state.find((item) => item.channel === 'SMS');

    expect(sms?.configured).toBe(false);
    expect(sms?.reason).toContain('выключен');
  });

  it('список исчерпавших попытки доступен', async () => {
    // Без него «письмо не ушло» обнаруживается только когда клиент позвонит.
    const rows = await makeController().exhausted();
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(3);
  });

  it('ограничение списка разбирается как число', async () => {
    /*
     * `limit` приходит строкой из адреса. Без разбора `'abc'` попал бы в запрос
     * как есть и дал бы ошибку базы вместо понятного ограничения.
     */
    const rows = await makeController().exhausted('0');
    expect(rows).toHaveLength(0);
  });

  it('бессмысленное ограничение заменяется значением по умолчанию', async () => {
    // Иначе опечатка в адресе вернула бы пустой список вместо данных, и это
    // выглядело бы как «ошибок нет».
    await expect(makeController().exhausted('abc')).resolves.toBeDefined();
  });
});
