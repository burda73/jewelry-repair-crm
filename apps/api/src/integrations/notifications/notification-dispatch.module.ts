/**
 * Модуль доставки уведомлений (задача 5.9, docs/05 §3).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ РАСШИРЕНИЕ `NotificationsModule`. Тот модуль —
 * про уведомления КАК ДАННЫЕ: создать, показать сотруднику, отметить прочитанным.
 * Здесь — про ДОСТАВКУ: адаптеры каналов, выбор канала, политика повторов. Разные
 * причины изменяться: список уведомлений меняется вместе с интерфейсом, а
 * отправка — вместе с почтовым сервером или SMS-провайдером.
 *
 * Модуль не экспортирует адаптеры: наружу нужен только `NotificationSenderService`
 * и состояние каналов. Прямое обращение к адаптеру в обход диспетчера означало бы,
 * что политика канала применяется не везде.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { InAppNotificationAdapter } from './in-app-notification.adapter';
import { EmailNotificationAdapter } from './email-notification.adapter';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationSenderService } from './notification-sender.service';

@Module({
  imports: [ConfigModule],
  providers: [
    InAppNotificationAdapter,
    EmailNotificationAdapter,
    NotificationDispatcher,
    NotificationSenderService,
  ],
  exports: [NotificationSenderService],
})
export class NotificationDispatchModule {}
