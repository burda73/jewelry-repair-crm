import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Настройки системы.
 *
 * `SettingsService` экспортируется: наименование организации нужно печати
 * квитанции и акта, и брать его напрямую из таблицы `setting` эти модули не
 * должны — иначе правило выбора источника (настройки → окружение) разошлось бы
 * между тремя местами.
 */
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
