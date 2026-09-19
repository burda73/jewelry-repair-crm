import { Module } from '@nestjs/common';

import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { ClaimDeadlineService } from './claim-deadline.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';

/**
 * Рекламации и гарантия (этап 6, ТЗ п. 2.9).
 *
 * `OrderWorkflowService` даёт рабочий календарь: срок рассмотрения считается в
 * РАБОЧИХ днях, и без календаря праздники и переносы не учитывались бы — срок
 * истекал бы в нерабочий день. `NotificationsModule` нужен для рассылки
 * предупреждений о приближении срока (задача 6.6).
 */
@Module({
  imports: [NotificationsModule],
  controllers: [ClaimsController],
  providers: [ClaimsService, ClaimDeadlineService, OrderWorkflowService],
  exports: [ClaimsService, ClaimDeadlineService],
})
export class ClaimsModule {}
