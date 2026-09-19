/**
 * Тесты разбора окружения (задача 5.9).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Значения по умолчанию в схеме окружения задают поведение
 * продакшна, и ошибка в них не видна ни в тестах, ни в интерфейсе: приложение
 * просто работает «как будто настроено».
 *
 * РЕАЛЬНЫЙ ДЕФЕКТ, который здесь закреплён. У `SMTP_HOST` стояло значение по
 * умолчанию `localhost`, у порта — `1025` (адрес локального отладочного
 * почтового сервера). Из-за этого состояние «почта не настроена» стало
 * НЕДОСТИЖИМЫМ: проверка `SMTP_HOST` на пустоту не срабатывала никогда, и
 * продакшн без единой SMTP-переменной молча пытался доставить письма на
 * `localhost:1025`. В журнале это выглядело как `ECONNREFUSED ::1:1025` — то
 * есть как сломанная почта, а не как выключенный канал, и разбирались бы с этим
 * не там.
 */

import { describe, expect, it } from 'vitest';
import { envSchema } from './env.validation';

/** Минимальный набор обязательных переменных. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    CSRF_SECRET: 'c'.repeat(32),
    /*
     * `REDIS_URL` обязателен в схеме, хотя Redis в контуре не установлен
     * (docs/15-known-issues.md). Здесь он указан как значение-заглушка: тест
     * проверяет разбор ОКРУЖЕНИЯ, а не доступность Redis, и поднимать его ради
     * этого не требуется.
     */
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  };
}

describe('Разбор окружения: SMTP (задача 5.9)', () => {
  it('без SMTP_HOST канал остаётся ненастроенным', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА ДЕФЕКТА. Если здесь появится значение по умолчанию,
     * проверка «канал не настроен» в адаптере станет мёртвым кодом, и продакшн
     * начнёт стучаться в localhost при каждом письме.
     */
    const parsed = envSchema.parse(base());
    expect(parsed.SMTP_HOST).toBeUndefined();
  });

  it('без SMTP_PORT порт не подставляется', () => {
    // Порт имеет смысл только вместе с хостом. Значение по умолчанию здесь —
    // тот же дефект: непустой порт выглядел бы как настроенный канал.
    const parsed = envSchema.parse(base());
    expect(parsed.SMTP_PORT).toBeUndefined();
  });

  it('заданный SMTP_HOST сохраняется', () => {
    // Обратная проверка: необязательность не должна означать «игнорируется».
    const parsed = envSchema.parse(base({ SMTP_HOST: 'mail.remixgold.local' }));
    expect(parsed.SMTP_HOST).toBe('mail.remixgold.local');
  });

  it('пустой SMTP_HOST означает выключенный канал, а не ошибку', () => {
    /*
     * В `.env` «не задано» и «задано пустым» пишутся одинаково: `SMTP_HOST=""`.
     * Если отвергать пустую строку, документированный способ выключить канал
     * ронял бы приложение при старте. Пустое значение означает ровно то же, что и
     * отсутствующее.
     */
    expect(envSchema.parse(base({ SMTP_HOST: '' })).SMTP_HOST).toBeUndefined();
  });

  it('хост из пробелов считается пустым', () => {
    // Иначе значение прошло бы проверку и дало попытку соединения с
    // бессмысленным хостом вместо понятного «канал не настроен».
    expect(envSchema.parse(base({ SMTP_HOST: '   ' })).SMTP_HOST).toBeUndefined();
  });

  it('хост обрезается от пробелов', () => {
    // Адрес с пробелом по краям не разрешился бы в DNS.
    expect(envSchema.parse(base({ SMTP_HOST: ' mail.local ' })).SMTP_HOST).toBe('mail.local');
  });

  it('пустой SMTP_PORT означает порт по умолчанию адаптера', () => {
    // `Number('')` даёт ноль: без обработки приложение падало бы на проверке
    // положительности при пустом значении в `.env`.
    expect(envSchema.parse(base({ SMTP_HOST: 'm', SMTP_PORT: '' })).SMTP_PORT).toBeUndefined();
  });

  it('нечисловой SMTP_PORT не роняет приложение', () => {
    /*
     * Порт берётся из `.env`, где легко остаётся комментарий или лишний символ.
     * Отказ при старте из-за этого остановил бы ВСЮ систему — вместе с приёмом
     * заказов — тогда как без почты она работает.
     */
    expect(envSchema.parse(base({ SMTP_HOST: 'm', SMTP_PORT: 'abc' })).SMTP_PORT).toBeUndefined();
    expect(envSchema.parse(base({ SMTP_HOST: 'm', SMTP_PORT: '0' })).SMTP_PORT).toBeUndefined();
  });

  it('адрес отправителя имеет значение по умолчанию', () => {
    // Письмо без отправителя почтовые серверы отвергают — здесь умолчание
    // уместно: оно не создаёт видимость настроенного канала.
    expect(envSchema.parse(base()).SMTP_FROM).toBe('noreply@remixgold.ru');
  });

  it('порт принимается числом и строкой', () => {
    // Переменные окружения — строки; значение с пробелами тоже приводится.
    expect(envSchema.parse(base({ SMTP_HOST: 'm', SMTP_PORT: '2525' })).SMTP_PORT).toBe(2525);
    expect(envSchema.parse(base({ SMTP_HOST: 'm', SMTP_PORT: ' 587 ' })).SMTP_PORT).toBe(587);
  });
});

describe('Разбор окружения: SMS и мессенджер (задача 5.10)', () => {
  it('каналы выключены по умолчанию', () => {
    /*
     * ГЛАВНАЯ ЗАЩИТА ОТ РАСХОДОВ. SMS — платная внешняя отправка, и включённый
     * по умолчанию канал отправил бы первое же событие реальному клиенту и
     * тарифицировался бы. Проверка фиксирует именно умолчание.
     */
    const parsed = envSchema.safeParse(base());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.NOTIFICATIONS_SMS_ENABLED).toBe(false);
      expect(parsed.data.NOTIFICATIONS_MESSENGER_ENABLED).toBe(false);
    }
  });

  it('документированный пример окружения разбирается', () => {
    /*
     * `.env.example` — это инструкция, по которой настраивают продакшн. Если
     * указанные в нём значения не проходят схему, приложение не запустится у
     * того, кто следовал документации.
     *
     * Пустой адрес шлюза здесь ОБЯЗАТЕЛЕН к проверке: `.env` записывает
     * «не задано» как пустую строку, и требование непустого значения сломало бы
     * документированный способ выключить канал.
     */
    const parsed = envSchema.safeParse(
      base({
        NOTIFICATIONS_SMS_ENABLED: 'false',
        NOTIFICATIONS_MESSENGER_ENABLED: 'false',
        SMS_GATEWAY_URL: '',
        MESSENGER_GATEWAY_URL: '',
        SMS_HTTP_METHOD: 'POST',
        SMS_HTTP_BODY: 'JSON',
        SMS_PHONE_PARAM: 'phone',
        SMS_TEXT_PARAM: 'text',
        SMS_API_KEY_HEADER: 'Authorization',
        SMS_TIMEOUT_MS: '10000',
      }),
    );

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('пустой адрес шлюза не ломает запуск', () => {
    // Именно так .env записывает «не задано». Требование непустой строки
    // остановило бы всё приложение из-за необязательной настройки.
    const parsed = envSchema.safeParse(base({ SMS_GATEWAY_URL: '', MESSENGER_GATEWAY_URL: '  ' }));
    expect(parsed.success).toBe(true);
  });

  it('недопустимый HTTP-метод отклоняется', () => {
    /*
     * Опечатка в методе (`PUT`, `FETCH`) превратилась бы в непредсказуемый
     * запрос к шлюзу. Лучше отказать при разборе окружения, чем выяснять это по
     * журналу отправки.
     */
    const parsed = envSchema.safeParse(base({ SMS_HTTP_METHOD: 'PUT' }));
    expect(parsed.success).toBe(false);
  });

  it('бессмысленный таймаут отклоняется', () => {
    // Нулевой таймаут обрывал бы запрос мгновенно, и ни одно SMS не ушло бы.
    const parsed = envSchema.safeParse(base({ SMS_TIMEOUT_MS: '0' }));
    expect(parsed.success).toBe(false);
  });

  it('таймаут задаётся числом, а не строкой', () => {
    // Схема приводит значение; строка в настройках привела бы к сравнению
    // «'10000' > 0» и к неожиданному поведению таймаута.
    const parsed = envSchema.safeParse(base({ SMS_TIMEOUT_MS: '15000' }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.SMS_TIMEOUT_MS).toBe(15_000);
  });
});
