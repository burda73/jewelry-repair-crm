import { Module } from '@nestjs/common';
import { BatchesService } from './batches.service';
import { BatchesController } from './batches.controller';
import { BatchActPdfService } from './batch-act-pdf.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';

/**
 * Логистика: партии (задача 2.1, ТЗ п. 2.6).
 *
 * Отдельный модуль, а не часть заказов: партия объединяет заказы разных
 * клиентов и магазинов, живёт по своим правилам (направление, акт, приём) и
 * имеет собственные права (`logistics:read`, `logistics:manage`).
 *
 * `PrismaModule` глобальный, импортировать его не нужно.
 */
@Module({
  controllers: [BatchesController],
  // `OrderWorkflowService` даёт таблицу переходов и guard-условия: собственный
  // `UPDATE status` обошёл бы проверку роли, обязательность акта и историю
  // статусов, и заказ уехал бы без записи о том, кто и когда его отправил.
  providers: [BatchesService, BatchActPdfService, OrderWorkflowService],
  exports: [BatchesService],
})
export class BatchesModule {}
