/**
 * Тесты адаптеров каналов (задача 5.9, docs/05 §3 и §6.3).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Порт требует, чтобы `send` не бросал исключений, а
 * возвращал результат. Это не стилистическое требование: исключение из адаптера
 * останавливает цикл отправки, и одно письмо с неверным адресом лишает
 * уведомлений всех остальных. Поэтому каждый путь ошибки проверяется на возврат
 * `SendResult`, а не на исключение.
 *
 * ОТДЕЛЬНО ПРОВЕРЯЕТСЯ РАЗЛИЧЕНИЕ ВРЕМЕННОЙ И ПОСТОЯННОЙ ОШИБКИ. По нему воркер
 * решает, повторять ли отправку. Ошибка здесь даёт либо потерянное уведомление,
 * либо бесконечно растущую очередь.
 */

import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_CHANNEL } from '@app/shared';

import { InAppNotificationAdapter } from './in-app-notification.adapter';
import { EmailNotificationAdapter, readSmtpSettings } from './email-notification.adapter';
import { NotificationDispatcher } from './notification-dispatcher.service';

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const message = { recipient: 'a@b.ru', subject: 'Тема', body: 'Текст', templateCode: 'TEST' };

describe('Канал «в приложении» (задача 5.9)', () => {
  it('всегда сообщает об успехе', async () => {
    /*
     * Доставка «в приложении» — это сама запись в базу, которая уже произошла.
     * Если бы адаптер возвращал ошибку, уведомления копились бы в `FAILED` и
     * администратор видел бы сломанный канал там, где всё в порядке.
     */
    const adapter = new InAppNotificationAdapter();
    const result = await adapter.send(message);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it('объявляет свой канал', () => {
    // Диспетчер строит таблицу адаптеров по этому полю: без него выбор канала не
    // работал бы.
    expect(new InAppNotificationAdapter().channel).toBe(NOTIFICATION_CHANNEL.IN_APP);
  });
});

describe('Настройки SMTP (задача 5.9)', () => {
  it('без SMTP_HOST канал считается ненастроенным', () => {
    // Это признак «канал не настроен», а не ошибка: приложение обязано
    // запускаться без почты.
    expect(readSmtpSettings(config({}))).toBeNull();
    expect(readSmtpSettings(config({ SMTP_HOST: '   ' }))).toBeNull();
  });

  it('порт по умолчанию — 25', () => {
    // Внутренний почтовый сервер обычно слушает именно его. Угадывать 587
    // нельзя: неверный выбор даст таймаут вместо понятной ошибки.
    const settings = readSmtpSettings(config({ SMTP_HOST: 'mail.local' }));
    expect(settings?.port).toBe(25);
  });

  it('нечисловой порт заменяется на 25, а не на NaN', () => {
    /*
     * `NaN` в настройках дошёл бы до транспорта и дал бы непонятную ошибку
     * соединения. Здесь он превращается в рабочий порт.
     */
    const settings = readSmtpSettings(config({ SMTP_HOST: 'mail.local', SMTP_PORT: 'abc' }));
    expect(settings?.port).toBe(25);
  });

  it('шифрование не выводится из номера порта', () => {
    /*
     * Распространённая ошибка — считать 465 защищённым «по умолчанию». На самом
     * деле 587 требует открытого соединения с последующим STARTTLS, и
     * угадывание приводит к отказу рукопожатия. Признак задаётся явно.
     */
    expect(readSmtpSettings(config({ SMTP_HOST: 'm', SMTP_PORT: '465' }))?.secure).toBe(false);
    expect(
      readSmtpSettings(config({ SMTP_HOST: 'm', SMTP_PORT: '465', SMTP_SECURE: 'true' }))?.secure,
    ).toBe(true);
  });

  it('адрес отправителя подставляется по умолчанию', () => {
    // Письмо без отправителя почтовые серверы отвергают.
    expect(readSmtpSettings(config({ SMTP_HOST: 'm' }))?.from).toBe('noreply@remixgold.local');
  });

  it('пустые логин и пароль превращаются в null', () => {
    // Пустая строка как логин означала бы попытку аутентификации с пустыми
    // данными — сервер отверг бы письмо вместо анонимной отправки.
    const settings = readSmtpSettings(config({ SMTP_HOST: 'm', SMTP_USER: '', SMTP_PASSWORD: '' }));
    expect(settings?.user).toBeNull();
    expect(settings?.password).toBeNull();
  });
});

describe('Почтовый адаптер (задача 5.9)', () => {
  it('без настроек возвращает постоянную ошибку, а не бросает', async () => {
    /*
     * Исключение из адаптера остановило бы весь цикл отправки. Кроме того,
     * повтор при отсутствии настроек бессмыслен: SMTP не появится сам.
     */
    const adapter = new EmailNotificationAdapter(config({}));
    const result = await adapter.send(message);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('SMTP не настроен');
  });

  it('состояние канала видно снаружи', () => {
    // По нему администратор понимает, что почта не подключена, не читая логи.
    expect(new EmailNotificationAdapter(config({})).isConfigured()).toBe(false);
    expect(new EmailNotificationAdapter(config({ SMTP_HOST: 'm' })).isConfigured()).toBe(true);
  });

  it('объявляет почтовый канал', () => {
    expect(new EmailNotificationAdapter(config({})).channel).toBe(NOTIFICATION_CHANNEL.EMAIL);
  });
});

describe('Диспетчер каналов (задача 5.9)', () => {
  function makeDispatcher(values: Record<string, string> = {}) {
    const cfg = config(values);
    const inApp = new InAppNotificationAdapter();
    const email = new EmailNotificationAdapter(cfg);
    return new NotificationDispatcher(inApp, email, cfg);
  }

  it('неизвестный канал — постоянная ошибка, а не исключение', async () => {
    /*
     * SMS и MESSENGER появятся только в задаче 5.10. До тех пор уведомление с
     * таким каналом должно получить понятную причину отказа. Исключение уронило
     * бы цикл отправки из-за одной записи.
     */
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch('SMS', message);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('SMS');
  });

  it('список каналов содержит только подключённые', () => {
    /*
     * По этому списку воркер отбирает записи из базы. Если бы SMS попал в список
     * без адаптера, воркер брал бы их каждые полминуты и каждый раз получал
     * отказ, забивая очередь.
     */
    const channels = makeDispatcher().supportedChannels();
    expect(channels).toContain(NOTIFICATION_CHANNEL.IN_APP);
    expect(channels).toContain(NOTIFICATION_CHANNEL.EMAIL);
    expect(channels).not.toContain('SMS');
    expect(channels).not.toContain('MESSENGER');
  });

  it('исключение из адаптера не выходит наружу', async () => {
    /*
     * Порт обязывает адаптер не бросать (docs/05 §6.3), но нарушение контракта
     * не должно ронять цикл: одно письмо не стоит всех остальных.
     */
    const broken = {
      channel: 'SMS' as const,
      send: vi.fn(async () => {
        throw new Error('адаптер упал');
      }),
    };
    const dispatcher = new NotificationDispatcher(
      new InAppNotificationAdapter(),
      new EmailNotificationAdapter(config({})),
      config({}),
    );
    // Подменяем таблицу адаптеров, чтобы добраться до сломанного.
    (dispatcher as unknown as { adapters: Map<string, unknown> }).adapters.set('SMS', broken);

    const result = await dispatcher.dispatch('SMS', message);

    expect(result.ok).toBe(false);
    // Временная: неизвестную ошибку безопаснее повторить.
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('адаптер упал');
  });

  it('состояние каналов показывает настройку почты', () => {
    const state = makeDispatcher().channelsState();
    const email = state.find((item) => item.channel === NOTIFICATION_CHANNEL.EMAIL);
    // Настроенной почты здесь нет — так и должно быть.
    expect(email?.configured).toBe(false);
    expect(state.find((item) => item.channel === NOTIFICATION_CHANNEL.IN_APP)?.configured).toBe(
      true,
    );
  });
});
