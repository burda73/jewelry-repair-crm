import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';

@Module({
  imports: [
    /**
     * JWT настраивается АСИНХРОННО через ConfigService.
     *
     * Это исправление реального дефекта. Раньше было `JwtModule.register({
     * secret: process.env.JWT_ACCESS_SECRET })`: декоратор вычисляется в момент
     * загрузки файла модуля — ДО того, как `ConfigModule.forRoot()` прочитает
     * `.env`. В итоге секрет модуля оказывался `undefined`.
     *
     * Последствие было неочевидным: вход ВЫПОЛНЯЛСЯ (при подписи секрет
     * передавался явно и уже был загружен), cookie выдавались — а следующий же
     * запрос получал «Сессия истекла», потому что `verifyAsync` без явного
     * секрета использовал `undefined`. Пользователь видел бесконечный
     * редирект на вход, и по логам это выглядело как истёкшая сессия,
     * а не как ошибка конфигурации.
     *
     * `registerAsync` гарантирует, что секрет читается после инициализации
     * конфигурации. Тот же приём нужен для refresh-секрета (см. auth.service).
     */
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_TTL') ?? '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Глобальная защита: все эндпоинты закрыты, кроме @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
