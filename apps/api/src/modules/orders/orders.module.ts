import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import { ReceiptService } from './receipt.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // `OrderWorkflowService` создаёт уведомления клиенту (задача 5.10):
  // эффект `NOTIFY_CUSTOMER` требует шаблонов, которые даёт этот модуль.
  imports: [NotificationsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderWorkflowService, ReceiptService],
  exports: [OrdersService, OrderWorkflowService, ReceiptService],
})
export class OrdersModule {}
