import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Уведомления (задача 2.6). `PrismaModule` и `StorageModule` — глобальные,
 * поэтому в импортах не перечисляются.
 *
 * Сервис экспортируется: его вызывают другие модули, создавая уведомления по
 * событиям (задержка рейса, приёмка партии, просрочка заказа).
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
