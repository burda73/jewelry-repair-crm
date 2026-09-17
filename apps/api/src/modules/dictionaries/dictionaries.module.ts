import { Module } from '@nestjs/common';
import { DictionariesService } from './dictionaries.service';
import { DictionariesController } from './dictionaries.controller';

/**
 * Справочники. Модуль отдаёт только чтение (GET) — CRUD справочников
 * реализуется отдельной задачей. `PrismaModule` глобальный, повторно
 * импортировать его не нужно.
 *
 * `DictionariesService` экспортируется: мастер приёма заказа и расчёт в
 * `OrdersService`/`PaymentsService` используют ту же логику выбора действующего
 * прейскуранта, и дублировать её они не должны.
 */
@Module({
  controllers: [DictionariesController],
  providers: [DictionariesService],
  exports: [DictionariesService],
})
export class DictionariesModule {}
