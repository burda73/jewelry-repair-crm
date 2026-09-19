import { Module } from '@nestjs/common';
import { PublicStatusController } from './public-status.controller';
import { PublicStatusService } from './public-status.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Публичная проверка статуса заказа (задача 5.11).
 *
 * `NotificationsModule` импортируется, потому что код подтверждения уходит
 * клиенту через существующий порт уведомлений: заводить второй способ отправки
 * SMS означало бы вторую реализацию, вторую настройку канала и два разных ответа
 * на вопрос «почему клиент не получил сообщение».
 */
@Module({
  imports: [NotificationsModule],
  controllers: [PublicStatusController],
  providers: [PublicStatusService],
  exports: [PublicStatusService],
})
export class PublicStatusModule {}
