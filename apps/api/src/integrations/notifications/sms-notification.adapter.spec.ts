/**
 * Тесты внешних каналов: SMS и мессенджер (задача 5.10).
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ. Канал платный и внешний. Ошибка в нём стоит денег, а не
 * «неудобства», поэтому проверяются все пути отказа по отдельности: выключенный
 * канал, отсутствие адреса шлюза, неверный номер, ответ шлюза.
 *
 * ОТДЕЛЬНО ПРОВЕРЯЕТСЯ НОРМАЛИЗАЦИЯ НОМЕРА. Шлюзы принимают номер в своём
 * формате, и «8 916 …» вместо «+7916…» — самая частая причина отказа, которую
 * потом ищут в настройках шлюза, а не в данных клиента.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_CHANNEL } from '@app/shared';

import { GatewayNotificationAdapter, readSmsSettings } from './sms-notification.adapter';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { InAppNotificationAdapter } from './in-app-notification.adapter';
import { EmailNotificationAdapter } from './email-notification.adapter';

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const ENABLED = {
  NOTIFICATIONS_SMS_ENABLED: 'true',
  SMS_GATEWAY_URL: 'http://sms.local/send',
};

const message = {
  recipient: '+79161234567',
  subject: null,
  body: 'Заказ готов',
  templateCode: 'READY_FOR_PICKUP',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Настройки внешнего канала (задача 5.10)', () => {
  it('без флага включения канал выключен', () => {
    // SMS платные: включённый по умолчанию канал отправил бы первое же событие
    // реальному клиенту.
    expect(readSmsSettings(config({ SMS_GATEWAY_URL: 'http://sms.local/send' }))).toBeNull();
  });

  it('без адреса шлюза канал выключен', () => {
    /*
     * Флаг без адреса означал бы попытку отправки «в никуда»: запись уходила бы
     * в ошибку, и выглядело бы это как сломанный провайдер, а не как незаданная
     * настройка.
     */
    expect(readSmsSettings(config({ NOTIFICATIONS_SMS_ENABLED: 'true' }))).toBeNull();
  });

  it('при обоих условиях канал настроен', () => {
    expect(readSmsSettings(config(ENABLED))).not.toBeNull();
  });

  it('SMS и мессенджер включаются независимо', () => {
    /*
     * Разные провайдеры и разные деньги. Общий флаг включил бы оба, и расходы
     * оказались бы вдвое больше запланированных.
     */
    const onlySms = config({ ...ENABLED });
    expect(readSmsSettings(onlySms, 'SMS')).not.toBeNull();
    expect(readSmsSettings(onlySms, 'MESSENGER')).toBeNull();

    const onlyMessenger = config({
      NOTIFICATIONS_MESSENGER_ENABLED: 'true',
      MESSENGER_GATEWAY_URL: 'http://msg.local/send',
    });
    expect(readSmsSettings(onlyMessenger, 'SMS')).toBeNull();
    expect(readSmsSettings(onlyMessenger, 'MESSENGER')).not.toBeNull();
  });

  it('пустой ключ доступа превращается в null', () => {
    // Пустой заголовок авторизации шлюз может отвергнуть, тогда как его
    // отсутствие означает анонимную отправку.
    expect(readSmsSettings(config({ ...ENABLED, SMS_API_KEY: '  ' }))?.apiKey).toBeNull();
  });

  it('бессмысленный таймаут заменяется значением по умолчанию', () => {
    // Нулевой таймаут обрывал бы запрос мгновенно, и ни одно SMS не ушло бы.
    expect(readSmsSettings(config({ ...ENABLED, SMS_TIMEOUT_MS: '0' }))?.timeoutMs).toBe(10_000);
    expect(readSmsSettings(config({ ...ENABLED, SMS_TIMEOUT_MS: 'abc' }))?.timeoutMs).toBe(10_000);
  });

  it('имена параметров шлюза настраиваются', () => {
    // У разных шлюзов разные имена: `phone`/`text`, `to`/`message`, `msisdn`/`msg`.
    const settings = readSmsSettings(
      config({ ...ENABLED, SMS_PHONE_PARAM: 'msisdn', SMS_TEXT_PARAM: 'msg' }),
    );
    expect(settings?.phoneParam).toBe('msisdn');
    expect(settings?.textParam).toBe('msg');
  });
});

describe('Отправка SMS (задача 5.10)', () => {
  it('выключенный канал сообщает о постоянной ошибке', async () => {
    /*
     * Постоянная, а не временная: включение канала — действие администратора, а
     * не то, что исправится повтором. Временный признак заставил бы воркер
     * повторять попытки каждые полминуты без пользы.
     */
    const adapter = new GatewayNotificationAdapter(config({}), 'SMS');
    const result = await adapter.send(message);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('SMS');
  });

  it('состояние канала видно снаружи', () => {
    // По нему администратор понимает, что SMS не подключён, не читая логи.
    expect(new GatewayNotificationAdapter(config({}), 'SMS').isConfigured()).toBe(false);
    expect(new GatewayNotificationAdapter(config(ENABLED), 'SMS').isConfigured()).toBe(true);
  });

  it('канал мессенджера отличается от SMS', () => {
    // Подмена канала означала бы, что сообщение уходит не тем провайдером.
    expect(new GatewayNotificationAdapter(config({}), 'SMS').channel).toBe(
      NOTIFICATION_CHANNEL.SMS,
    );
    expect(new GatewayNotificationAdapter(config({}), 'MESSENGER').channel).toBe(
      NOTIFICATION_CHANNEL.MESSENGER,
    );
  });

  it('номер нормализуется перед отправкой', async () => {
    /*
     * Шлюзы принимают номер в своём формате, и «8 916 123-45-67» вместо
     * «+79161234567» — самая частая причина отказа. Искать её потом будут в
     * настройках шлюза, а не в данных клиента.
     */
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new GatewayNotificationAdapter(config(ENABLED), 'SMS');
    await adapter.send({ ...message, recipient: '8 916 123-45-67' });

    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('+79161234567');
    expect(body).not.toContain('8 916');
  });

  it('неверный номер — постоянная ошибка без обращения к шлюзу', async () => {
    /*
     * Отправлять нечего, и повтор не поможет. Обращение к шлюзу было бы лишним
     * запросом, который закончился бы тем же отказом.
     */
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new GatewayNotificationAdapter(config(ENABLED), 'SMS');
    const result = await adapter.send({ ...message, recipient: 'не телефон' });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('Некорректный номер');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('успешный ответ шлюза считается доставкой', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('accepted', { status: 200 })),
    );

    const adapter = new GatewayNotificationAdapter(config(ENABLED), 'SMS');
    const result = await adapter.send(message);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it('5xx шлюза — временная ошибка', async () => {
    // Шлюз мог быть недоступен минуту: повтор уместен.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('fail', { status: 503 })),
    );

    const adapter = new GatewayNotificationAdapter(config(ENABLED), 'SMS');
    const result = await adapter.send(message);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('4xx шлюза — постоянная ошибка', async () => {
    /*
     * Неверный ключ доступа или отклонённый номер не исправятся повтором, а
     * очередь будет расти с каждой попыткой.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad number', { status: 400 })),
    );

    const adapter = new GatewayNotificationAdapter(config(ENABLED), 'SMS');
    const result = await adapter.send(message);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('тело ответа шлюза попадает в ошибку', async () => {
    // Без него в журнале останется «HTTP 400» без причины: шлюзы объясняют отказ
    // в теле, а не в статусе.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('номер в стоп-листе', { status: 400 })),
    );

    const adapter = new GatewayNotificationAdapter(config(ENABLED), 'SMS');
    const result = await adapter.send(message);

    expect(result.error).toContain('стоп-листе');
  });

  it('ошибка сети не выходит наружу', async () => {
    /*
     * Порт обязывает не бросать исключения (docs/05 §6.3): исключение
     * остановило бы цикл отправки, и одно сообщение лишило бы уведомлений
     * остальных получателей.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const adapter = new GatewayNotificationAdapter(config(ENABLED), 'SMS');
    const result = await adapter.send(message);

    expect(result.ok).toBe(false);
    // Ошибка сети временная: шлюз мог быть недоступен минуту.
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('текст передаётся шлюзу', async () => {
    // Подмена текста на пустую строку означала бы SMS без содержания.
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new GatewayNotificationAdapter(config(ENABLED), 'SMS');
    await adapter.send({ ...message, body: 'Заказ MSK1-2509-000001 готов' });

    expect(String(fetchMock.mock.calls[0][1].body)).toContain('MSK1-2509-000001');
  });
});

describe('Диспетчер с внешними каналами (задача 5.10)', () => {
  function makeDispatcher(values: Record<string, string>) {
    const cfg = config(values);
    return new NotificationDispatcher(
      new InAppNotificationAdapter(),
      new EmailNotificationAdapter(cfg),
      cfg,
    );
  }

  it('выключенный SMS не попадает в список каналов воркера', () => {
    /*
     * По этому списку воркер отбирает записи из базы. Попади туда выключенный
     * канал — воркер каждые полминуты брал бы уведомления, которые отправить
     * нечем, и очередь росла бы без пользы.
     */
    const dispatcher = makeDispatcher({});
    expect(dispatcher.supportedChannels()).not.toContain('SMS');
    expect(dispatcher.supportedChannels()).not.toContain('MESSENGER');
  });

  it('настроенный SMS попадает в список каналов', () => {
    // Обратная проверка: включение канала обязано работать, иначе задача
    // «включение по настройке» не выполнена.
    const dispatcher = makeDispatcher(ENABLED);
    expect(dispatcher.supportedChannels()).toContain('SMS');
  });

  it('включение SMS не включает мессенджер', () => {
    // Разные провайдеры и разные деньги.
    const dispatcher = makeDispatcher(ENABLED);
    expect(dispatcher.supportedChannels()).not.toContain('MESSENGER');
  });

  it('состояние каналов показывает причину, а не только факт', () => {
    /*
     * Вопрос «почему клиент не получил SMS» имеет ответ «выключен настройкой», и
     * он должен быть виден администратору. Показать только `configured: false`
     * значило бы заставить его искать причину в коде.
     */
    const state = makeDispatcher({}).channelsState();
    const sms = state.find((item) => item.channel === NOTIFICATION_CHANNEL.SMS);
    expect(sms?.configured).toBe(false);
    expect(sms?.reason).toContain('выключен');

    const email = state.find((item) => item.channel === NOTIFICATION_CHANNEL.EMAIL);
    expect(email?.reason).toContain('SMTP_HOST');
  });

  it('все каналы видны в состоянии, включая выключенные', () => {
    // Отсутствие канала в списке выглядело бы как «канала не существует», а не
    // как «канал выключен».
    const channels = makeDispatcher({})
      .channelsState()
      .map((item) => item.channel);
    expect(channels).toContain(NOTIFICATION_CHANNEL.IN_APP);
    expect(channels).toContain(NOTIFICATION_CHANNEL.EMAIL);
    expect(channels).toContain(NOTIFICATION_CHANNEL.SMS);
    expect(channels).toContain(NOTIFICATION_CHANNEL.MESSENGER);
  });
});
