import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

/**
 * Управление учётными записями и ролями (задача 1.2.4).
 *
 * `PrismaModule` глобальный, повторно импортировать его не нужно. Сервис не
 * экспортируется: никто, кроме собственного контроллера, учётные записи
 * менять не должен — иначе появился бы второй путь создания пользователей,
 * который не писал бы аудит и не проверял уникальность почты.
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
