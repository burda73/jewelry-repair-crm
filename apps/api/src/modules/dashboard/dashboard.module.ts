import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ReportsModule } from '../reports/reports.module';

/**
 * Главный экран (задача 5.8).
 *
 * Зависит от `ReportsModule`, а не считает числа сам: выручка, предоплаты,
 * средний срок и загрузка должны совпадать с отчётами, которые открываются по
 * клику. Свой запрос здесь дал бы второе определение выручки, и два числа на
 * одном экране разошлись бы при первой же правке одного из них.
 */
@Module({
  imports: [ReportsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
