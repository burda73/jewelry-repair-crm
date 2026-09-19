/**
 * Внешний канал через HTTP-шлюз: SMS и мессенджер (задача 5.10, docs/05 §3 и §6.3).
 *
 * ПОЧЕМУ ОДИН АДАПТЕР НА ДВА КАНАЛА. Механизм одинаков: отправить номер и текст
 * по HTTP на адрес шлюза и разобрать статус ответа. Отличия — только в названиях
 * переменных окружения и в подписи канала. Вторая копия тех же двухсот строк
 * разошлась бы с первой при первой же правке (таймаут, разбор ошибки,
 * нормализация номера), и расхождение обнаружилось бы по-разному работающим SMS и
 * мессенджеру.
 *
 * ПОЧЕМУ HTTP, А НЕ SDK ПРОВАЙДЕРА. Провайдер ещё не выбран, и выбирать его
 * кодом нельзя: у продакшн-контура нет выхода в интернет (docs/05 §0), поэтому
 * шлюз, скорее всего, будет во внутренней сети заказчика. Обобщённый HTTP-вызов
 * с настраиваемым адресом работает с любым шлюзом, у которого есть простой
 * «отправить сообщение» — а таких большинство.
 *
 * ЧТО ИМЕННО ПОДДЕРЖИВАЕТСЯ. Два способа передать получателя и текст, покрывающие
 * почти все шлюзы: параметры в строке запроса (`GET`/`POST` с `?phone=…&text=…`)
 * и тело в формате JSON. Способ выбирается настройкой `SMS_HTTP_METHOD` и
 * `SMS_HTTP_BODY`. Если у заказчика окажется экзотический протокол, адаптер
 * заменяется — доменный код от него не зависит.
 *
 * ПОЧЕМУ КАНАЛ ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ. SMS — платная внешняя отправка. Пока
 * провайдер не подключён и не проверен, включённый по умолчанию канал означал бы,
 * что первое же событие уходит реальному клиенту и тарифицируется. Поэтому нужны
 * ОБА условия: `NOTIFICATIONS_SMS_ENABLED=true` И заданный адрес шлюза.
 *
 * АДАПТЕР НЕ БРОСАЕТ ИСКЛЮЧЕНИЙ (docs/05 §6.3): любая ошибка возвращается в
 * `SendResult`. Исключение остановило бы цикл отправки, и одно сообщение с
 * неверным номером лишило бы уведомлений остальных получателей.
 */

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  NOTIFICATION_CHANNEL,
  isRetryableHttpStatus,
  normalizePhone,
  type NotificationChannel,
  type NotificationPort,
  type OutboundMessage,
  type SendResult,
} from '@app/shared';

/** Настройки шлюза внешнего канала. */
export interface GatewaySettings {
  /** Адрес шлюза отправки. */
  url: string;
  /** HTTP-метод: `GET` или `POST`. */
  method: 'GET' | 'POST';
  /** Как передаётся текст: в строке запроса или в теле JSON. */
  body: 'QUERY' | 'JSON';
  /** Ключ доступа, если шлюз его требует. */
  apiKey: string | null;
  /** Имя отправителя, если шлюз его принимает. */
  sender: string | null;
  /** Имя параметра получателя в запросе шлюза. */
  phoneParam: string;
  /** Имя параметра текста в запросе шлюза. */
  textParam: string;
  /** Имя заголовка для ключа доступа. */
  apiKeyHeader: string;
  /** Таймаут запроса в миллисекундах. */
  timeoutMs: number;
}

/**
 * Прочитать настройки SMS из окружения.
 *
 * Возвращается `null`, если канал выключен ИЛИ не задан адрес шлюза. Оба условия
 * обязательны: включённый флаг без адреса означал бы попытку отправки «в никуда»,
 * а заданный адрес без флага — отправку, которую никто не планировал.
 */
export function readSmsSettings(
  config: ConfigService,
  prefix: 'SMS' | 'MESSENGER' = 'SMS',
): GatewaySettings | null {
  /*
   * У каждого канала СВОЙ флаг включения и СВОЙ адрес шлюза. Общий флаг включил бы
   * оба сразу, и расходы оказались бы вдвое больше запланированных: это разные
   * провайдеры и разные деньги.
   */
  const enabled = config.get<string>(`NOTIFICATIONS_${prefix}_ENABLED`);
  // Сравнение со строкой: значения окружения всегда строки, а `ConfigService`
  // может вернуть и приведённое значение — проверяются оба варианта.
  if (enabled !== 'true' && String(enabled) !== 'true') return null;

  const url = config.get<string>(`${prefix}_GATEWAY_URL`);
  if (url === undefined || url.trim() === '') return null;

  const method = config.get<string>(`${prefix}_HTTP_METHOD`) === 'GET' ? 'GET' : 'POST';
  const body = config.get<string>(`${prefix}_HTTP_BODY`) === 'QUERY' ? 'QUERY' : 'JSON';

  const timeoutRaw = config.get<string>(`${prefix}_TIMEOUT_MS`);
  const timeout = timeoutRaw === undefined ? 10_000 : Number.parseInt(timeoutRaw, 10);

  const apiKey = config.get<string>(`${prefix}_API_KEY`);
  const sender = config.get<string>(`${prefix}_SENDER`);

  return {
    url: url.trim(),
    method,
    body,
    /*
     * Пустые значения приводятся к `null`, а не к пустой строке: пустой заголовок
     * авторизации шлюз может отвергнуть, тогда как его отсутствие означает
     * анонимную отправку.
     */
    apiKey: apiKey === undefined || apiKey.trim() === '' ? null : apiKey.trim(),
    sender: sender === undefined || sender.trim() === '' ? null : sender.trim(),
    phoneParam: config.get<string>(`${prefix}_PHONE_PARAM`)?.trim() || 'phone',
    textParam: config.get<string>(`${prefix}_TEXT_PARAM`)?.trim() || 'text',
    apiKeyHeader: config.get<string>(`${prefix}_API_KEY_HEADER`)?.trim() || 'Authorization',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
  };
}

/**
 * Адаптер внешнего канала через HTTP-шлюз.
 *
 * Создаётся по одному на канал: `new GatewayNotificationAdapter(config, 'SMS')` и
 * `new GatewayNotificationAdapter(config, 'MESSENGER')`.
 */
export class GatewayNotificationAdapter implements NotificationPort {
  private readonly logger = new Logger(GatewayNotificationAdapter.name);
  private readonly settings: GatewaySettings | null;

  constructor(
    config: ConfigService,
    private readonly prefix: 'SMS' | 'MESSENGER' = 'SMS',
  ) {
    this.settings = readSmsSettings(config, prefix);
    this.channel = prefix === 'SMS' ? NOTIFICATION_CHANNEL.SMS : NOTIFICATION_CHANNEL.MESSENGER;
    if (this.settings === null) {
      this.logger.log(
        `${prefix}-канал выключен: сообщения не отправляются (это штатное состояние)`,
      );
    }
  }

  /*
   * Канал вычисляется в конструкторе, а не инициализатором поля: инициализаторы
   * выполняются ДО присваивания параметров конструктора, и обращение к `prefix`
   * здесь читало бы ещё не установленное значение.
   */
  readonly channel: NotificationChannel;

  /** Включён ли и настроен ли канал. */
  isConfigured(): boolean {
    return this.settings !== null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.settings === null) {
      /*
       * Канал выключен — это НЕ ошибка, а штатное состояние: уведомление просто
       * не отправляется, и запись в базе остаётся следом события. Постоянный
       * признак нужен, чтобы воркер не повторял попытки: включение канала —
       * действие администратора, а не то, что исправится само.
       */
      return {
        ok: false,
        error: `${this.prefix}-канал выключен настройкой`,
        retryable: false,
      };
    }

    /*
     * Номер нормализуется ПЕРЕД отправкой. Шлюзы принимают номер в своём формате,
     * и «8 916 …» вместо «+7916…» — самая частая причина отказа, которую потом
     * ищут в настройках шлюза, а не в данных.
     */
    const phone = normalizePhone(message.recipient);
    if (phone === null) {
      /*
       * Постоянная ошибка: неверный номер не исправится повтором. Текст ошибки
       * содержит исходное значение — по нему видно, что именно пришло из карточки
       * клиента.
       */
      return {
        ok: false,
        error: `Некорректный номер получателя: ${message.recipient}`.slice(0, 500),
        retryable: false,
      };
    }

    try {
      const response = await this.request(phone, message);
      return await this.interpret(response);
    } catch (error: unknown) {
      /*
       * Ошибка сети и таймаут — временные: шлюз мог быть недоступен минуту.
       * Повтор уместен, и это единственный случай, когда он помогает.
       */
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${this.prefix} не отправлено (${phone}): ${detail}`);
      return { ok: false, error: detail.slice(0, 500), retryable: true };
    }
  }

  /** Выполнить запрос к шлюзу. */
  private async request(phone: string, message: OutboundMessage): Promise<Response> {
    const settings = this.settings;
    if (settings === null) throw new Error(`${this.prefix}-канал выключен`);

    const params = new URLSearchParams();
    params.set(settings.phoneParam, phone);
    params.set(settings.textParam, message.body);
    // Имя отправителя передаётся, только если шлюз его принимает: лишний параметр
    // некоторые шлюзы считают ошибкой запроса.
    if (settings.sender !== null) params.set('sender', settings.sender);

    const headers: Record<string, string> = {};
    if (settings.apiKey !== null) headers[settings.apiKeyHeader] = settings.apiKey;

    const url =
      settings.method === 'GET' || settings.body === 'QUERY'
        ? `${settings.url}${settings.url.includes('?') ? '&' : '?'}${params.toString()}`
        : settings.url;

    const init: RequestInit = {
      method: settings.method,
      headers,
      /*
       * Таймаут обязателен. Без него недоступный шлюз держит запрос до системного
       * таймаута TCP, и воркер простаивает, не отправляя остальные сообщения.
       */
      signal: AbortSignal.timeout(settings.timeoutMs),
    };

    if (settings.method === 'POST') {
      if (settings.body === 'JSON') {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({
          [settings.phoneParam]: phone,
          [settings.textParam]: message.body,
          ...(settings.sender === null ? {} : { sender: settings.sender }),
        });
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = params.toString();
      }
    }

    return await fetch(url, init);
  }

  /**
   * Разобрать ответ шлюза.
   *
   * Признак временной ошибки берётся из HTTP-статуса: `4xx` — постоянная
   * (неверный номер, отказ авторизации), `5xx`, `408`, `429` и ошибки сети —
   * временная. Правило вынесено в домен отдельной функцией
   * `isRetryableHttpStatus`: у HTTP и SMTP ПРОТИВОПОЛОЖНАЯ трактовка диапазонов,
   * и общая функция дала бы одному из каналов обратную политику повторов.
   */
  private async interpret(response: Response): Promise<SendResult> {
    if (response.ok) return { ok: true, error: null, retryable: false };

    /*
     * Тело ответа читается для журнала: шлюзы объясняют отказ в теле, а не в
     * статусе, и без него в журнале останется «HTTP 400» без причины.
     */
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // Тело недоступно — не повод считать ошибку иначе: статус уже известен.
      detail = '';
    }

    this.logger.warn(`${this.prefix}-шлюз ответил ${response.status}: ${detail}`);

    return {
      ok: false,
      error:
        `${this.prefix}-шлюз ответил ${response.status}${detail === '' ? '' : `: ${detail}`}`.slice(
          0,
          500,
        ),
      retryable: isRetryableHttpStatus(response.status),
    };
  }
}
