import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';

/**
 * Модуль клиентов.
 *
 * `PrismaService` не импортируется: `PrismaModule` помечен `@Global()`.
 * Гварды аутентификации и ролей тоже не подключаются — они глобальные
 * (auth.module.ts).
 *
 * `CustomersService` экспортируется: создание заказа в orders.service.ts
 * разрешает клиента по телефону той же логикой нормализации, и при переходе
 * на прямой вызов сервиса зависимость уже готова.
 */
@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
