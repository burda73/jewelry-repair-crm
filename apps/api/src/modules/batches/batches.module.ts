import { Module } from '@nestjs/common';
import { BatchesService } from './batches.service';
import { BatchesController } from './batches.controller';

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
  providers: [BatchesService],
  exports: [BatchesService],
})
export class BatchesModule {}
