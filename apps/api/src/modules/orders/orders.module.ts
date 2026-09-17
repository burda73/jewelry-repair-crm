import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import { ReceiptService } from './receipt.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrderWorkflowService, ReceiptService],
  exports: [OrdersService, OrderWorkflowService, ReceiptService],
})
export class OrdersModule {}