/**
 * Почтовый канал (задача 5.9, docs/05 §3).
 *
 * ЗАЧЕМ SMTP, А НЕ API ПОЧТОВОГО СЕРВИСА. У продакшн-контура **нет выхода в
 * интернет** (docs/05 §0): внешние сервисы недоступны физически. Корпоративный
 * почтовый сервер во внутренней сети — единственный работающий вариант, и он
 * говорит на SMTP. Поэтому адаптер построен на `nodemailer`, а не на SDK
 * облачного провайдера.
 *
 * ЧЕГО АДАПТЕР НЕ ДЕЛАЕТ. Не повторяет отправку: политика повторов принадлежит
 * воркеру (docs/05 §6.3). Иначе «три попытки» внутри каждой из трёх попыток
 * снаружи дали бы девять, и задержки перемножались бы.
 *
 * БЕЗ НАСТРОЕК АДАПТЕР НЕ ПАДАЕТ, А СООБЩАЕТ ОБ ОТКАЗЕ. Если SMTP не
 * сконфигурирован, `send` возвращает постоянную ошибку: уведомление остаётся в
 * базе с понятной причиной, и администратор видит, что канал не настроен, а не
 * что «почта сломалась».
 */

import { Injectable, Logger } from '@nestjs/common';
import { envFlag } from '../../config/env.validation';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import {
  NOTIFICATION_CHANNEL,
  isRetryableByCode,
  type NotificationChannel,
  type NotificationPort,
  type OutboundMessage,
  type SendResult,
} from '@app/shared';

/** Настройки SMTP, собранные из окружения. */
export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  /** Адрес отправителя: почтовые серверы отвергают письмо без него. */
  from: string;
}

/**
 * Собрать настройки SMTP из окружения.
 *
 * Возвращается `null`, если хост не задан: это признак «канал не настроен», а не
 * ошибка. Отдельная функция, а не чтение внутри адаптера, — чтобы правило было
 * проверяемо тестом без поднятия Nest.
 */
export function readSmtpSettings(config: ConfigService): SmtpSettings | null {
  const host = config.get<string>('SMTP_HOST');
  if (host === undefined || host.trim() === '') return null;

  const portRaw = config.get<string>('SMTP_PORT');
  const port = portRaw === undefined ? 25 : Number.parseInt(portRaw, 10);

  const user = config.get<string>('SMTP_USER');
  const password = config.get<string>('SMTP_PASSWORD');
  const from = config.get<string>('SMTP_FROM');

  return {
    host: host.trim(),
    /*
     * Порт по умолчанию 25: внутренний почтовый сервер обычно слушает именно
     * его. 465 и 587 подразумевают шифрование, и угадывать их нельзя — неверный
     * выбор даст таймаут вместо понятной ошибки.
     */
    port: Number.isFinite(port) && port > 0 ? port : 25,
    /*
     * Шифрование включается явно через `SMTP_SECURE`. Выводить его из номера
     * порта — распространённая ошибка: 465 требует `secure: true`, а 587
     * начинает с открытого соединения и повышает его через STARTTLS.
     */
    /*
     * Через `envFlag`: схема окружения приводит `SMTP_SECURE` к булеву значению,
     * и сравнение со строкой `'true'` всегда давало `false` — то есть шифрование
     * почты молча оставалось выключенным даже при `SMTP_SECURE=true`.
     */
    secure: envFlag(config.get('SMTP_SECURE')),
    user: user === undefined || user.trim() === '' ? null : user.trim(),
    password: password === undefined || password === '' ? null : password,
    from: from === undefined || from.trim() === '' ? 'noreply@remixgold.local' : from.trim(),
  };
}

@Injectable()
export class EmailNotificationAdapter implements NotificationPort {
  private readonly logger = new Logger(EmailNotificationAdapter.name);
  private readonly settings: SmtpSettings | null;
  /** Транспорт создаётся один раз: соединение переиспользуется между письмами. */
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    this.settings = readSmtpSettings(config);
    if (this.settings === null) {
      this.logger.warn(
        'SMTP не настроен (SMTP_HOST пуст): письма не отправляются, ' +
          'уведомления остаются в базе с ошибкой',
      );
    }
  }

  readonly channel: NotificationChannel = NOTIFICATION_CHANNEL.EMAIL;

  /** Настроен ли канал — для проверки состояния интеграции. */
  isConfigured(): boolean {
    return this.settings !== null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.settings === null) {
      /*
       * Постоянная ошибка: без настроек повтор ничего не изменит, и очередь не
       * должна крутить эти письма. Причина записана текстом — администратор
       * видит «канал не настроен», а не «почта сломалась».
       */
      return {
        ok: false,
        error: 'SMTP не настроен: не задан SMTP_HOST',
        retryable: false,
      };
    }

    try {
      const transporter = await this.getTransporter();
      await transporter.sendMail({
        from: this.settings.from,
        to: message.recipient,
        subject: message.subject ?? '',
        text: message.body,
      });

      return { ok: true, error: null, retryable: false };
    } catch (error: unknown) {
      return this.toFailure(error);
    }
  }

  /**
   * Превратить ошибку отправки в результат.
   *
   * Код ответа читается из `responseCode` (nodemailer) и `code` (сетевые ошибки).
   * По нему решается, повторять ли: 5xx — постоянная, отсутствие кода (сеть,
   * таймаут) — временная.
   */
  private toFailure(error: unknown): SendResult {
    const candidate = error as { responseCode?: number; code?: string; message?: string };
    const code = candidate?.responseCode ?? candidate?.code ?? null;
    const retryable = isRetryableByCode(code ?? null);

    this.logger.warn(
      `Письмо не отправлено (код ${String(code ?? '—')}, повтор ${retryable ? 'возможен' : 'бессмысленен'})`,
    );

    return {
      ok: false,
      error: String(candidate?.message ?? error).slice(0, 500),
      retryable,
    };
  }

  /** Транспорт создаётся при первом письме: на старте он не нужен. */
  private async getTransporter(): Promise<Transporter> {
    if (this.transporter !== null) return this.transporter;

    const { createTransport } = await import('nodemailer');
    const settings = this.settings;
    if (settings === null) throw new Error('SMTP не настроен');

    this.transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      ...(settings.user === null
        ? {}
        : { auth: { user: settings.user, pass: settings.password ?? '' } }),
      /*
       * Таймауты обязательны. Без них недоступный почтовый сервер держит запрос
       * до системного таймаута TCP (минуты), и воркер простаивает, не отправляя
       * остальные письма.
       */
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    return this.transporter;
  }
}
