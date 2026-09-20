import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { AssignmentsService } from './assignments.service';
import { OrderWorksService } from './order-works.service';
import { OrderRollbackService } from './order-rollback.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import { ReceiptService } from './receipt.service';
import { PickupSignatureService } from './pickup-signature.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // `OrderWorkflowService` создаёт уведомления клиенту (задача 5.10):
  // эффект `NOTIFY_CUSTOMER` требует шаблонов, которые даёт этот модуль.
  imports: [NotificationsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    AssignmentsService,
    OrderWorksService,
    OrderRollbackService,
    OrderWorkflowService,
    ReceiptService,
    PickupSignatureService,
  ],
  exports: [
    OrdersService,
    AssignmentsService,
    OrderWorksService,
    OrderRollbackService,
    OrderWorkflowService,
    ReceiptService,
    PickupSignatureService,
  ],
})
export class OrdersModule {}
