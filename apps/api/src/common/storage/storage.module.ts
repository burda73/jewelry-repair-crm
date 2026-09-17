import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Хранилище файлов — глобальный модуль.
 *
 * Нужен и заказам (фото изделий), и записям звонков, и документам партий.
 * Импортировать его в каждый модуль значило бы повторять одну строку в четырёх
 * местах и однажды забыть её — поэтому он глобальный, как `ConfigModule`.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
