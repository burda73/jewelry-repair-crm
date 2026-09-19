/**
 * Отправка уведомлений (задача 5.9, docs/05 §3 и §6.3).
 *
 * МОДЕЛЬ РАБОТЫ. Уведомление сначала записывается в базу со статусом `PENDING`
 * — это и есть очередь отправки (docs/05 §3). Воркер берёт пачку ожидающих,
 * отправляет подходящим каналом и обновляет статус: `SENT` при успехе, `FAILED`
 * с текстом ошибки и числом попыток — при неудаче. Уведомление не удаляется
 * никогда: история отправки нужна, чтобы ответить на вопрос «почему клиент не
 * получил сообщение».
 *
 * ПОЧЕМУ ОТПРАВКА ОТДЕЛЬНО ОТ СОЗДАНИЯ. Если бы уведомление отправлялось в
 * момент бизнес-операции, сбой почты откатывал бы операцию: партия не
 * отправилась бы из-за недоступного SMTP. Разделение обязательно ещё и потому,
 * что внешняя система не должна участвовать в нашей транзакции (docs/05 §6.3).
 *
 * ЧТО БЕРЁТ ВОРКЕР. Только уведомления `PENDING` и `FAILED` с незаконченными
 * попытками, у которых канал поддержан адаптером. Последнее важно: уведомления
 * `SMS` и `MESSENGER` (задача 5.10) не должны копиться в очереди, пока провайдер
 * не подключён.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_SEND_ATTEMPTS,
  NOTIFICATION_CHANNEL,
  canRetry,
  isRetryDue,
  type OutboundMessage,
} from '@app/shared';

import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationDispatcher } from '../../integrations/notifications/notification-dispatcher.service';

/** Сколько уведомлений обрабатывается за один прогон. */
export const SEND_BATCH_SIZE = 100;

/** Итог одного прогона — для журнала воркера. */
export interface SendRunResult {
  /** Сколько уведомлений было готово к отправке. */
  scanned: number;
  /** Успешно отправлено. */
  sent: number;
  /** Не отправлено, но попытки остались. */
  failed: number;
  /** Исчерпало попытки — требует вмешательства. */
  exhausted: number;
  /**
   * Пропущено из-за задержки между попытками.
   *
   * Без этого числа журнал показывал бы «обработано 0» каждые полминуты, и было
   * бы неясно, работает ли воркер вообще.
   */
  skipped: number;
}

@Injectable()
export class NotificationSenderService {
  private readonly logger = new Logger(NotificationSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  /**
   * Отправить готовые уведомления.
   *
   * `now` передаётся явно: прогон должен быть воспроизводим в тесте, иначе
   * задержку между попытками нельзя проверить, не выжидая минуты.
   */
  async run(now: Date = new Date()): Promise<SendRunResult> {
    const channels = this.dispatcher.supportedChannels();

    const candidates = await this.prisma.notification.findMany({
      where: {
        /*
         * `READ` исключается намеренно: прочитанное уведомление в приложении уже
         * доставлено, и отправлять его письмом повторно не нужно.
         */
        status: { in: ['PENDING', 'FAILED'] },
        channel: { in: [...channels] },
      },
      orderBy: { createdAt: 'asc' },
      take: SEND_BATCH_SIZE,
    });

    const result: SendRunResult = {
      scanned: 0,
      sent: 0,
      failed: 0,
      exhausted: 0,
      skipped: 0,
    };

    for (const notification of candidates) {
      /*
       * Ограничение попыток проверяется ДО отправки. Уведомление, исчерпавшее
       * попытки, остаётся в `FAILED` как запись для разбора, но воркер его не
       * берёт — иначе очередь никогда не опустеет.
       */
      if (!canRetry(notification.attempts)) {
        result.exhausted += 1;
        continue;
      }

      /*
       * Задержка экспоненциальная: 1 мин, 5 мин, 25 мин. Отсчёт идёт от времени
       * ПОСЛЕДНЕЙ ПОПЫТКИ, а не от создания уведомления: иначе после второго
       * сбоя повтор ждал бы 25 минут от создания, то есть срабатывал бы почти
       * сразу, и три попытки уложились бы в секунды.
       *
       * `lastAttemptAt` пуст у уведомления, которое ещё не пытались отправить:
       * тогда попытка выполняется сразу.
       */
      const lastAttemptAt = notification.lastAttemptAt ?? notification.createdAt;
      if (notification.attempts > 0 && !isRetryDue(notification.attempts, lastAttemptAt, now)) {
        result.skipped += 1;
        continue;
      }

      result.scanned += 1;
      const message: OutboundMessage = {
        recipient: notification.recipient,
        subject: notification.subject,
        body: notification.body,
        templateCode: notification.templateCode,
      };

      const outcome = await this.dispatcher.dispatch(notification.channel, message);

      if (outcome.ok) {
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: {
            status: 'SENT',
            sentAt: now,
            lastAttemptAt: now,
            attempts: { increment: 1 },
            error: null,
          },
        });
        result.sent += 1;
        continue;
      }

      /*
       * Постоянная ошибка (неверный адрес, отказ сервера) не повторяется: попытки
       * закончатся одинаково, а очередь будет расти.
       *
       * Поэтому счётчик попыток не ИНКРЕМЕНТИРУЕТСЯ, а СРАЗУ ставится в предел.
       * `increment: 1` здесь был бы дефектом: постоянная ошибка на первой попытке
       * дала бы `attempts = 1`, а `canRetry(1)` истинно — и воркер возвращался бы
       * к безнадёжному уведомлению каждые полминуты до конца работы системы.
       */
      const nextAttempts = outcome.retryable ? notification.attempts + 1 : MAX_SEND_ATTEMPTS;

      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: 'FAILED',
          error: outcome.error?.slice(0, 500) ?? 'Неизвестная ошибка отправки',
          lastAttemptAt: now,
          // Предел ставится присваиванием: `increment` не выражает «сразу предел».
          attempts: nextAttempts,
        },
      });

      if (outcome.retryable && canRetry(nextAttempts)) {
        result.failed += 1;
      } else {
        result.exhausted += 1;
      }
    }

    if (result.sent > 0 || result.exhausted > 0) {
      this.logger.log(
        `Отправка: готово ${result.scanned}, ушло ${result.sent}, ` +
          `с ошибкой ${result.failed}, исчерпано ${result.exhausted}, пропущено ${result.skipped}`,
      );
    }

    return result;
  }

  /**
   * Уведомления, требующие вмешательства: отправка не удалась окончательно.
   *
   * Нужны администратору. Без этого списка «письмо не ушло» обнаруживается
   * только тогда, когда клиент позвонит и спросит, почему его не предупредили.
   */
  async listExhausted(limit = 100): Promise<
    {
      id: string;
      templateCode: string;
      channel: string;
      recipient: string;
      attempts: number;
      error: string | null;
      createdAt: string;
    }[]
  > {
    const rows = await this.prisma.notification.findMany({
      where: { status: 'FAILED', attempts: { gte: 3 } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        templateCode: true,
        channel: true,
        recipient: true,
        attempts: true,
        error: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Состояние каналов: подключён ли адаптер и настроен ли он.
   *
   * `reason` объясняет причину, а не только факт: вопрос «почему клиент не
   * получил SMS» имеет ответ «канал выключен настройкой», и он должен быть виден
   * администратору, а не только в журнале сервера.
   */
  channelsState(): { channel: string; configured: boolean; reason: string }[] {
    return this.dispatcher.channelsState();
  }
}

/** Каналы, которые поддерживаются с задачами 5.9 (для проверок и документации). */
export const SUPPORTED_CHANNELS_NOW = [NOTIFICATION_CHANNEL.IN_APP, NOTIFICATION_CHANNEL.EMAIL];
