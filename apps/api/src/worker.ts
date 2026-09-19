/**
 * Точка входа фоновых воркеров.
 *
 * Воркеры выполняются отдельным контейнером (см. infra/docker/docker-compose.prod.yml):
 * фоновые задачи не должны конкурировать с HTTP-запросами за ресурсы.
 *
 * Задачи (docs/01-architecture.md §1):
 *  1. escalations          — просрочки и эскалации руководителю (ТЗ п. 2.7);
 *  2. unclaimed-orders     — перевод в «невостребовано» через 30 дней (ТЗ п. 2.8);
 *  3. integration-outbox   — отправка платежей в 1С с ретраями (ТЗ п. 2.5, 2.8);
 *  4. telephony-import     — импорт журнала звонков (ТЗ п. 2.4);
 *  5. recording-retention  — удаление записей старше 1 года (ТЗ п. 2.4);
 *  6. notifications        — отправка уведомлений;
 *  7. totals-reconcile     — ночная сверка итогов заказов с платежами.
 *
 * РЕАЛИЗАЦИЯ: на текущем этапе это рабочая точка входа с graceful shutdown;
 * сами воркеры подключаются по мере разработки соответствующих модулей
 * (этапы 2–5 в docs/09-roadmap.md).
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { EscalationsService } from './modules/escalations/escalations.service';
import { UnclaimedService } from './modules/escalations/unclaimed.service';
import { NotificationSenderService } from './integrations/notifications/notification-sender.service';

interface WorkerDefinition {
  name: string;
  /** Интервал запуска в миллисекундах. */
  intervalMs: number;
  /** Реализация. Возвращает число обработанных объектов (для логов). */
  run: () => Promise<number>;
}

/**
 * Периодичность прогона эскалаций.
 *
 * Пятнадцать минут (docs/04 §4): чаще — лишняя нагрузка без пользы, потому что
 * `dueAt` измеряется часами и днями; реже — просрочка замечалась бы с
 * задержкой, заметной клиенту.
 */
const ESCALATION_INTERVAL_MS = 15 * 60_000;

/**
 * Периодичность проверки невостребованных заказов.
 *
 * Раз в сутки (ТЗ п. 2.8): порог измеряется календарными днями, и более частый
 * прогон ничего не изменил бы. Первый запуск происходит сразу при старте, чтобы
 * после перезапуска сервиса не ждать до утра.
 */
const UNCLAIMED_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Периодичность отправки уведомлений.
 *
 * Тридцать секунд. Быстрее бессмысленно: минимальная задержка между попытками —
 * минута, и более частый прогон лишь повторно выбирал бы те же записи. Медленнее
 * — клиент узнавал бы, что заказ готов, с заметной задержкой, а повторы
 * растянулись бы вдвое против задуманного.
 */
const NOTIFICATION_INTERVAL_MS = 30_000;

const registeredWorkers: WorkerDefinition[] = [];

/** Контейнер Nest: воркеры работают через те же сервисы, что и API. */
let escalations: EscalationsService | null = null;
let unclaimed: UnclaimedService | null = null;
let notificationSender: NotificationSenderService | null = null;

const timers: NodeJS.Timeout[] = [];
let shuttingDown = false;

function log(message: string): void {
  // Структурированный лог: воркеры не имеют requestId, поэтому указываем имя.
  process.stdout.write(
    `${JSON.stringify({ level: 'info', worker: 'runner', message, ts: new Date().toISOString() })}\n`,
  );
}

function logError(workerName: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      worker: workerName,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ts: new Date().toISOString(),
    })}\n`,
  );
}

/** Запустить один цикл воркера с защитой от наложения запусков. */
function scheduleWorker(worker: WorkerDefinition): void {
  let running = false;

  const tick = async (): Promise<void> => {
    if (shuttingDown || running) return;
    running = true;
    try {
      const processed = await worker.run();
      if (processed > 0) {
        log(`${worker.name}: обработано ${processed}`);
      }
    } catch (error) {
      // Ошибка одного цикла не должна останавливать воркер целиком.
      logError(worker.name, error);
    } finally {
      running = false;
    }
  };

  // Первый запуск — сразу при старте, чтобы не ждать интервал.
  void tick();
  const timer = setInterval(() => void tick(), worker.intervalMs);
  timers.push(timer);
  log(`Воркер запущен: ${worker.name} (интервал ${worker.intervalMs} мс)`);
}

/**
 * Запуск фоновых воркеров.
 *
 * Функция намеренно **синхронная**: сейчас она только регистрирует интервалы,
 * и `async` без `await` лишь создавал бы Promise, который никто не ожидает.
 * Когда воркеры начнут обращаться к БД (этапы 2–5), функция станет `async`,
 * и её вызов ниже нужно будет await-ить.
 */
async function bootstrap(): Promise<void> {
  log('Запуск фоновых воркеров...');

  /*
   * Контейнер поднимается через тот же `AppModule`, что и API, но без HTTP:
   * воркер обязан использовать ТУ ЖЕ логику сервисов, а не свою копию запросов.
   * Копия неизбежно разошлась бы с API — и «просрочено» в воркере означало бы не
   * то же, что на дашборде.
   */
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  await app.init();
  escalations = app.get(EscalationsService);
  unclaimed = app.get(UnclaimedService);
  notificationSender = app.get(NotificationSenderService);

  registeredWorkers.push({
    name: 'escalations',
    intervalMs: ESCALATION_INTERVAL_MS,
    // Возвращается число разосланных уведомлений: по нему видно, работает ли
    // воркер, не читая его внутреннее состояние.
    run: async () => {
      if (escalations === null) return 0;
      const result = await escalations.run();
      if (result.scanned > 0) {
        log(
          `escalations: просроченных ${result.scanned}, оповещено ${result.notified}, ` +
            `повышен уровень у ${result.escalated}, без ответственного ${result.withoutResponsible}`,
        );
      }
      return result.notified;
    },
  });

  registeredWorkers.push({
    name: 'unclaimed-orders',
    intervalMs: UNCLAIMED_INTERVAL_MS,
    run: async () => {
      if (unclaimed === null) return 0;
      const result = await unclaimed.run();
      if (result.unclaimed > 0 || result.skipped > 0) {
        log(
          `unclaimed-orders: просмотрено ${result.scanned}, переведено ${result.unclaimed}, ` +
            `пропущено ${result.skipped}`,
        );
      }
      return result.unclaimed;
    },
  });

  registeredWorkers.push({
    name: 'notifications',
    intervalMs: NOTIFICATION_INTERVAL_MS,
    run: async () => {
      if (notificationSender === null) return 0;
      const result = await notificationSender.run();
      /*
       * «Пропущено» тоже пишется в журнал: без него прогон, в котором всё ждёт
       * задержки, выглядел бы как «обработано 0» каждые полминуты, и понять,
       * работает ли воркер, было бы нельзя.
       */
      if (result.scanned > 0 || result.skipped > 0 || result.exhausted > 0) {
        log(
          `notifications: готово ${result.scanned}, отправлено ${result.sent}, ` +
            `с ошибкой ${result.failed}, исчерпано ${result.exhausted}, ` +
            `отложено ${result.skipped}`,
        );
      }
      return result.sent;
    },
  });

  for (const worker of registeredWorkers) {
    scheduleWorker(worker);
  }

  log('Все воркеры запущены');
}

/** Плавная остановка: дожидаемся завершения текущих циклов. */
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Получен сигнал ${signal}, останавливаю воркеры...`);
  escalations = null;
  unclaimed = null;
  notificationSender = null;

  for (const timer of timers) {
    clearInterval(timer);
  }

  // Даём текущим задачам завершиться.
  setTimeout(() => {
    log('Воркеры остановлены');
    process.exit(0);
  }, 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/*
 * Контейнер поднимается асинхронно, поэтому ошибка запуска обрабатывается
 * `.catch()`: без него отказ инициализации (например, недоступная БД) привёл бы
 * к необработанному отклонению промиса — процесс упал бы с невнятным стеком
 * вместо сообщения о причине.
 */
bootstrap().catch((error: unknown) => {
  logError('bootstrap', error);
  process.exit(1);
});
