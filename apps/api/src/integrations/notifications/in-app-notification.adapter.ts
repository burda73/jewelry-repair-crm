/**
 * Канал «в приложении» (задача 5.9, docs/05 §3).
 *
 * ЧТО ЭТОТ АДАПТЕР ДЕЛАЕТ. Ничего не отправляет — и это правильно. Уведомление
 * `IN_APP` живёт в базе и появляется в интерфейсе у сотрудника; внешней доставки
 * ему не нужно. `send` возвращает успех, потому что доставка состоялась в момент
 * записи в базу.
 *
 * ЗАЧЕМ ОН ВООБЩЕ НУЖЕН. Воркер отправки перебирает уведомления по каналу. Если
 * бы для `IN_APP` адаптера не было, воркер либо считал бы такие уведомления
 * ошибкой (и они копились бы в `FAILED`), либо ему пришлось бы знать про
 * «особый» канал. Порт одинаков для всех каналов: «в приложении» — это канал,
 * который всегда доступен.
 */

import { Injectable } from '@nestjs/common';
import {
  NOTIFICATION_CHANNEL,
  type NotificationChannel,
  type NotificationPort,
  type OutboundMessage,
  type SendResult,
} from '@app/shared';

@Injectable()
export class InAppNotificationAdapter implements NotificationPort {
  readonly channel: NotificationChannel = NOTIFICATION_CHANNEL.IN_APP;

  async send(_message: OutboundMessage): Promise<SendResult> {
    /*
     * Доставка «в приложении» — это сама запись в базу, которая уже произошла.
     * Ошибка здесь возможна только при отсутствии адресата, а это ошибка
     * вызывающего кода, а не канала: уведомление без `userId` некому показать.
     *
     * Метод асинхронный, потому что таков контракт порта: воркер единообразно
     * ждёт результат от любого адаптера и не должен знать, что этот канал
     * отвечает мгновенно.
     */
    return await Promise.resolve({ ok: true, error: null, retryable: false });
  }
}
