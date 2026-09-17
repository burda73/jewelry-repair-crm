import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { validateEnv } from './config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { StorageModule } from './common/storage/storage.module';
import { PhotosModule } from './modules/photos/photos.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DictionariesModule } from './modules/dictionaries/dictionaries.module';
import { UsersModule } from './modules/users/users.module';

/**
 * Найти файл `.env`.
 *
 * Проблема, которую это решает: в монорепозитории `.env` лежит в КОРНЕ, а
 * workspace-скрипты npm выполняются с `cwd` пакета (`apps/api`). При указании
 * просто `'.env'` файл не находился, и приложение падало с «DATABASE_URL: Required»,
 * хотя переменные в корневом `.env` заполнены — при этом документированный
 * способ запуска (`npm run dev`) именно такой.
 *
 * Ищем вверх от текущего каталога: сначала корень монорепозитория, затем `cwd`.
 * dist/main.js лежит в `apps/api/dist`, поэтому двух уровней вверх достаточно.
 */
function resolveEnvPaths(): string[] {
  const candidates = [
    join(__dirname, '..', '..', '..', '.env'), // apps/api/dist → корень (собранный вид)
    join(__dirname, '..', '..', '.env'), // apps/api/src → корень (ts-node/nest)
    resolve(process.cwd(), '.env'), // cwd пакета
    resolve(process.cwd(), '..', '..', '.env'), // страховка: cwd=apps/api
  ];
  // Возвращаем только существующие пути, чтобы @nestjs/config не спотыкался
  // на несуществующих файлах, и сохраняем порядок приоритета.
  const found = candidates.filter((path) => existsSync(path));
  return found.length > 0 ? found : ['.env'];
}

@Module({
  imports: [
    // Конфигурация с валидацией: приложение не стартует с неполным .env.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: resolveEnvPaths(),
      validate: validateEnv,
    }),

    // Структурированные логи с requestId (docs/10-nfr-security.md §7)
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req) => (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
        redact: {
          // PII и секреты не попадают в логи
          paths: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.body.password',
            'req.body.currentPassword',
            'req.body.newPassword',
            'res.headers["set-cookie"]',
          ],
          censor: '[скрыто]',
        },
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
            : undefined,
      },
    }),

    // Rate limiting — защита от брутфорса (docs/10-nfr-security.md §3.3)
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 20 },
      { name: 'medium', ttl: 60_000, limit: 300 },
    ]),

    PrismaModule,
    StorageModule,
    PhotosModule,
    HealthModule,
    AuthModule,
    OrdersModule,
    PaymentsModule,
    CustomersModule,
    DictionariesModule,
    UsersModule,
  ],
  providers: [
    // Rate limit применяется глобально; отдельные эндпоинты переопределяют лимиты.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
