/**
 * Диспетчер уведомлений (задача 5.9, docs/05 §3 и §6.3).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СЕРВИС. Воркер отправки должен уметь одно: взять уведомления,
 * ждущие доставки, и отправить их подходящим каналом. Выбор адаптера по каналу —
 * это то, что не должно быть в воркере: иначе при добавлении SMS-провайдера
 * (задача 5.10) правится цикл отправки, то есть самая рискованная часть.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Диспетчер не пишет в базу: он получает сообщение и возвращает
 * результат. Запись статуса — дело вызывающего кода, в его транзакции
 * (docs/05 §6.3). Так сбой почты не откатывает бизнес-операцию.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFICATION_CHANNEL,
  type NotificationChannel,
  type NotificationPort,
  type OutboundMessage,
  type SendResult,
} from '@app/shared';

import { InAppNotificationAdapter } from './in-app-notification.adapter';
import { EmailNotificationAdapter } from './email-notification.adapter';

@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly adapters: Map<string, NotificationPort>;

  constructor(
    private readonly inApp: InAppNotificationAdapter,
    private readonly email: EmailNotificationAdapter,
  ) {
    this.adapters = new Map<string, NotificationPort>([
      [inApp.channel, inApp],
      [email.channel, email],
    ]);
  }

  /** Есть ли адаптер для канала. */
  supports(channel: string): boolean {
    return this.adapters.has(channel);
  }

  /**
   * Каналы, для которых есть адаптер.
   *
   * Нужно воркеру: он берёт из базы только те уведомления, которые сможет
   * отправить. Иначе уведомления `SMS` и `MESSENGER` (задача 5.10) копились бы в
   * очереди, и воркер каждые полминуты пытался бы их обработать без пользы.
   */
  supportedChannels(): readonly NotificationChannel[] {
    return [...this.adapters.keys()] as NotificationChannel[];
  }

  /**
   * Отправить сообщение по каналу.
   *
   * Неизвестный канал — это постоянная ошибка, а не исключение: уведомление
   * останется в базе с понятной причиной, и администратор увидит, что канал не
   * подключён. Исключение уронило бы весь цикл отправки из-за одной записи.
   */
  async dispatch(channel: string, message: OutboundMessage): Promise<SendResult> {
    const adapter = this.adapters.get(channel);
    if (adapter === undefined) {
      this.logger.warn(`Канал ${channel} не подключён: адаптера нет`);
      return {
        ok: false,
        error: `Канал ${channel} не подключён`,
        // Постоянная: без адаптера повтор ничего не изменит.
        retryable: false,
      };
    }

    try {
      return await adapter.send(message);
    } catch (error: unknown) {
      /*
       * Порт не должен бросать исключения (docs/05 §6.3), но адаптер может
       * нарушить контракт — например, упасть на разборе ответа. Тогда цикл
       * отправки не должен останавливаться: одно письмо не стоит всех
       * остальных.
       */
      this.logger.error(
        `Адаптер канала ${channel} нарушил контракт и бросил исключение`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        ok: false,
        error: String(error instanceof Error ? error.message : error).slice(0, 500),
        // Временная: неизвестная ошибка — безопаснее повторить.
        retryable: true,
      };
    }
  }

  /** Состояние каналов — для проверки интеграции администратором. */
  channelsState(): { channel: string; configured: boolean }[] {
    return [
      { channel: NOTIFICATION_CHANNEL.IN_APP, configured: true },
      { channel: NOTIFICATION_CHANNEL.EMAIL, configured: this.email.isConfigured() },
    ];
  }
}
