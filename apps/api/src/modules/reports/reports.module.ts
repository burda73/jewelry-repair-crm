import { Module } from '@nestjs/common';

import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';

/**
 * Отчёты (задача 5.1, ТЗ п. 2.11).
 *
 * `OrderWorkflowService` даёт рабочий календарь: нормативы этапов заданы в
 * рабочих днях и часах, и перевести их в часы без календаря нельзя — жёсткая
 * константа «9 часов» разошлась бы с расчётом сроков.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, OrderWorkflowService],
  exports: [ReportsService],
})
export class ReportsModule {}
