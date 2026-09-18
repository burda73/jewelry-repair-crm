import { Module } from '@nestjs/common';

import { EscalationsController } from './escalations.controller';
import { EscalationsService } from './escalations.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Эскалации просрочки (задача 2.8, ТЗ п. 2.7).
 *
 * `OrderWorkflowService` даёт рабочий календарь: порог эскалации считается в
 * рабочих часах, и без календаря праздники и переносы не учитывались бы.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [EscalationsController],
  providers: [EscalationsService, OrderWorkflowService],
  exports: [EscalationsService],
})
export class EscalationsModule {}
