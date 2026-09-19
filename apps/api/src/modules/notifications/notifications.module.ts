import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationDispatchModule } from '../../integrations/notifications/notification-dispatch.module';

/**
 * Уведомления (задача 2.6). `PrismaModule` и `StorageModule` — глобальные,
 * поэтому в импортах не перечисляются.
 *
 * Сервис экспортируется: его вызывают другие модули, создавая уведомления по
 * событиям (задержка рейса, приёмка партии, просрочка заказа).
 */
@Module({
  /*
   * Состояние каналов и список исчерпавших попытки показывает контроллер
   * (задача 5.10). Сам сервис уведомлений о каналах не знает: он про данные, а
   * не про доставку.
   */
  imports: [NotificationDispatchModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
