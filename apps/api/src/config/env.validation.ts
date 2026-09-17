/**
 * Валидация переменных окружения при старте.
 *
 * Приложение НЕ должно запускаться с неполной или небезопасной конфигурацией:
 * лучше упасть сразу, чем работать с дефолтным секретом в продакшне.
 */

import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    APP_URL: z.string().url(),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    TZ: z.string().default('Europe/Moscow'),

    /**
     * Сколько прокси доверять при определении IP клиента (ответ A1).
     *
     * В продакшне API стоит за внешним nginx-proxy, поэтому `req.ip` без этой
     * настройки был бы адресом прокси. Последствие ошибки критично:
     * ThrottlerGuard считал бы ВСЕХ клиентов одним адресом и после нескольких
     * неудачных входов заблокировал бы вход для всей сети.
     *
     * `1` — доверяем одному хопу (внешний nginx). Значение `true` доверяло бы
     * произвольной цепочке и позволило бы подделать IP через заголовок
     * `X-Forwarded-For`, обойдя rate limit.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
    DATABASE_REPLICA_URL: z.string().optional(),
    /**
     * Пул соединений НА ПРОЦЕСС.
     *
     * Продакшн использует СУЩЕСТВУЮЩИЙ PostgreSQL предприятия, общий с 1С и
     * другими системами (ответ A1). `max_connections` ограничивает число
     * соединений на ВЕСЬ сервер, поэтому пул обязан быть ограничен: иначе
     * приложение займёт все соединения и остановит чужие системы.
     *
     * Всего соединений будет `DATABASE_POOL_SIZE × число процессов`
     * (реплики API + воркер) — учитывайте это при выборе значения.
     * Проверка бюджета до деплоя: infra/db/preflight.sh
     */
    DATABASE_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),
    REDIS_URL: z.string().min(1, 'REDIS_URL обязателен'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET должен быть не короче 32 символов'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET должен быть не короче 32 символов'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),
    AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
    AUTH_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
    CSRF_SECRET: z.string().min(16, 'CSRF_SECRET должен быть не короче 16 символов'),

    /**
     * Хранилище файлов (фото изделий, записи звонков, документы).
     *
     * `LOCAL` — файлы на диске сервера, раздача через API. Выбрано для текущей
     * инфраструктуры: S3/MinIO в ней нет, а диск LXC имеет запас (17 ГБ свободно).
     * `S3` — объектное хранилище; настройки ниже обязательны только при нём.
     *
     * Значение по умолчанию — `LOCAL`, потому что иначе приложение падало бы
     * на старте в среде без S3 (в том числе на этом сервере).
     */
    STORAGE_DRIVER: z.enum(['LOCAL', 'S3']).default('LOCAL'),

    /**
     * Каталог для файлов при `STORAGE_DRIVER=LOCAL`.
     *
     * Обязан быть ВНЕ каталога приложения: переустановка/пересборка не должна
     * стирать фотографии клиентов, а резервное копирование — забирать их
     * отдельно от кода.
     */
    STORAGE_LOCAL_DIR: z.string().default('/opt/repair/data/files'),

    /** Максимальный размер загружаемого файла, байт. */
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),

    /*
     * Настройки S3. Необязательны: при `STORAGE_DRIVER=LOCAL` не используются,
     * а требование их наличия ломало бы запуск в среде без объектного хранилища.
     * Проверка «при S3 они обязательны» выполняется отдельно, ниже схемы.
     */
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('ru-central1'),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
    S3_BUCKET_PHOTOS: z.string().default('repair-photos'),
    S3_BUCKET_CALLS: z.string().default('repair-calls'),
    S3_BUCKET_DOCS: z.string().default('repair-docs'),
    S3_SIGNED_URL_TTL: z.coerce.number().int().positive().default(900),

    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().default('noreply@remixgold.ru'),

    /**
     * Название организации в шапке квитанции.
     *
     * Вынесено в настройку, а не зашито в код: квитанция — документ, который
     * уходит клиенту, и при смене юридического названия или бренда правка
     * не должна требовать пересборки приложения.
     */
    COMPANY_NAME: z.string().min(1).default('РЕМИКС ГОЛД'),
    SMTP_SECURE: z.coerce.boolean().default(false),

    // --- Интеграции: по умолчанию выключены, система работает автономно ---
    INTEGRATION_1C_ENABLED: z.coerce.boolean().default(false),
    INTEGRATION_1C_TRANSPORT: z
      .enum(['HTTP_SERVICE', 'ODATA', 'FILE_EXCHANGE'])
      .default('HTTP_SERVICE'),
    INTEGRATION_1C_BASE_URL: z.string().optional(),
    INTEGRATION_1C_USER: z.string().optional(),
    INTEGRATION_1C_PASSWORD: z.string().optional(),
    INTEGRATION_1C_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    INTEGRATION_1C_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    INTEGRATION_OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

    INTEGRATION_PBX_ENABLED: z.coerce.boolean().default(false),
    INTEGRATION_PBX_PROVIDER: z
      .enum(['ASTERISK_CDR', 'ASTERISK_AMI', 'MANGO', 'BITRIX24', 'WEBHOOK'])
      .default('ASTERISK_CDR'),
    INTEGRATION_PBX_BASE_URL: z.string().optional(),
    INTEGRATION_PBX_API_KEY: z.string().optional(),
    INTEGRATION_PBX_CDR_PATH: z.string().optional(),
    INTEGRATION_PBX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
    CALL_RECORDING_RETENTION_DAYS: z.coerce.number().int().positive().default(365),

    NOTIFICATIONS_SMS_ENABLED: z.coerce.boolean().default(false),
    SMS_PROVIDER: z.string().optional(),
    SMS_API_KEY: z.string().optional(),
    SMS_SENDER: z.string().optional(),

    UNCLAIMED_AFTER_DAYS: z.coerce.number().int().positive().default(30),
    CLAIM_REVIEW_WORKDAYS: z.coerce.number().int().positive().default(10),
    WARRANTY_MONTHS_DEFAULT: z.coerce.number().int().positive().default(6),
    WARRANTY_MONTHS_SETTING: z.coerce.number().int().positive().default(3),
    ESCALATION_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),

    REPORT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REPORT_ASYNC_THRESHOLD_MS: z.coerce.number().int().positive().default(5_000),
    METRICS_ENABLED: z.coerce.boolean().default(true),
  })
  .superRefine((env, ctx) => {
    // В продакшне запрещаем дефолтные/демонстрационные секреты.
    if (env.NODE_ENV === 'production') {
      const weakSecrets = [
        ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
        ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
        ['CSRF_SECRET', env.CSRF_SECRET],
      ] as const;

      for (const [name, value] of weakSecrets) {
        if (/CHANGE_ME|secret_for_tests|ci_/i.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} содержит дефолтное значение — недопустимо в продакшне`,
          });
        }
      }

      // Включённая интеграция требует адреса.
      if (env.INTEGRATION_1C_ENABLED && !env.INTEGRATION_1C_BASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['INTEGRATION_1C_BASE_URL'],
          message: 'Обязателен при INTEGRATION_1C_ENABLED=true',
        });
      }
      /*
       * Объектное хранилище требует полного набора настроек. Проверяем здесь,
       * а не через `.min(1)` в схеме: при `STORAGE_DRIVER=LOCAL` эти переменные
       * не нужны, и жёсткое требование ломало бы запуск без S3.
       */
      if (env.STORAGE_DRIVER === 'S3') {
        const requiredS3: [string, string | undefined][] = [
          ['S3_ENDPOINT', env.S3_ENDPOINT],
          ['S3_ACCESS_KEY', env.S3_ACCESS_KEY],
          ['S3_SECRET_KEY', env.S3_SECRET_KEY],
        ];
        for (const [name, value] of requiredS3) {
          if (value === undefined || value === '') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [name],
              message: `Обязателен при STORAGE_DRIVER=S3`,
            });
          }
        }
      }

      if (
        env.INTEGRATION_PBX_ENABLED &&
        !env.INTEGRATION_PBX_BASE_URL &&
        !env.INTEGRATION_PBX_CDR_PATH
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['INTEGRATION_PBX_BASE_URL'],
          message: 'Обязателен адрес API или путь к CDR при INTEGRATION_PBX_ENABLED=true',
        });
      }
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

/** Вызывается ConfigModule. Бросает исключение — приложение не стартует. */
export function validateEnv(config: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${problems}`);
  }

  return result.data;
}
