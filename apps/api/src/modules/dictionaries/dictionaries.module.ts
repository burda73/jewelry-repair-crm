import { Module } from '@nestjs/common';
import { DictionariesService } from './dictionaries.service';
import { DictionariesAdminService } from './dictionaries-admin.service';
import { PriceListAdminService } from './price-list-admin.service';
import { DictionariesController } from './dictionaries.controller';
import { DictionariesAdminController } from './dictionaries-admin.controller';

/**
 * Справочники: чтение и администрирование.
 *
 * Запись вынесена в `DictionariesAdminService` (задача 1.3.1), чтение осталось
 * в `DictionariesService`. Разделение не косметическое: чтение доступно почти
 * всем ролям и не пишет в журнал, а изменение — только ADMIN и всегда оставляет
 * след в `AuditLog` (ТЗ п. 4). `PrismaModule` глобальный, импортировать его не
 * нужно.
 *
 * `DictionariesService` экспортируется: мастер приёма заказа и расчёт в
 * `OrdersService`/`PaymentsService` используют ту же логику выбора действующего
 * прейскуранта, и дублировать её они не должны.
 */
@Module({
  controllers: [DictionariesController, DictionariesAdminController],
  providers: [DictionariesService, DictionariesAdminService, PriceListAdminService],
  exports: [DictionariesService],
})
export class DictionariesModule {}
