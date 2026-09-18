import { Module } from '@nestjs/common';
import { WorkingCalendarService } from './working-calendar.service';
import { WorkingCalendarController } from './working-calendar.controller';

/**
 * Рабочий календарь (задача 1.3.3).
 *
 * Отдельный модуль, а не часть `DictionariesModule`: календарь — не справочник
 * с `isActive`, у него есть `DELETE`, и его данные напрямую определяют сроки
 * заказов. Смешав его со справочниками, легко перенести на календарь правило
 * «не удалять» и снова получить строки, перекрывающие праздники.
 *
 * `PrismaModule` глобальный, импортировать его не нужно.
 */
@Module({
  controllers: [WorkingCalendarController],
  providers: [WorkingCalendarService],
  exports: [WorkingCalendarService],
})
export class WorkingCalendarModule {}
