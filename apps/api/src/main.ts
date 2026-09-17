/**
 * Точка входа API.
 *
 * Порядок важен: сначала безопасность и инфраструктурные middleware,
 * затем валидация, затем маршруты.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  // --- Доверие к прокси (ответ A1) -------------------------------------------
  // API работает за внешним nginx-proxy заказчика. Без этой настройки `req.ip`
  // содержал бы адрес прокси, и ThrottlerGuard считал бы всех клиентов одним
  // адресом: несколько неудачных входов заблокировали бы вход всей сети.
  // Доверяем ровно одному хопу — иначе IP можно подделать через X-Forwarded-For.
  const trustProxyHops = Number(process.env.TRUST_PROXY ?? 1);
  if (Number.isFinite(trustProxyHops) && trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
    logger.log(`Доверие к прокси: ${trustProxyHops} хоп(ов)`);
  }

  // --- Безопасность (docs/10-nfr-security.md §3.3) ---------------------------
  app.use(
    helmet({
      contentSecurityPolicy: false, // CSP задаётся на уровне веб-приложения
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser(process.env.CSRF_SECRET));

  // --- CORS ------------------------------------------------------------------
  // Разрешаем только известный origin веб-приложения, не «*».
  app.enableCors({
    origin: process.env.APP_URL ?? 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // --- Валидация -------------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // --- Глобальный префикс ----------------------------------------------------
  app.setGlobalPrefix('api/v1', {
    exclude: ['health/live', 'health/ready'],
  });

  // --- Swagger (только вне продакшна) ----------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('CRM ремонта ювелирных изделий')
      .setDescription(
        'API системы управления и контроля операций ремонта. ' +
          'Спецификация: docs/07-api-spec.md',
      )
      .setVersion('1.0')
      .addCookieAuth('access_token')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
    logger.log('Swagger доступен на /api/docs');
  }

  // --- Graceful shutdown ------------------------------------------------------
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);

  logger.log(`API запущен на http://localhost:${port}/api/v1`);
  logger.log(`Режим: ${process.env.NODE_ENV ?? 'development'}`);
}

bootstrap().catch((error: unknown) => {
  // Ошибка на старте — приложение не должно работать в неопределённом состоянии.
  console.error('Не удалось запустить приложение:', error);
  process.exit(1);
});