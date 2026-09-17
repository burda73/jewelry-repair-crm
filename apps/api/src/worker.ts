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

interface WorkerDefinition {
  name: string;
  /** Интервал запуска в миллисекундах. */
  intervalMs: number;
  /** Реализация. Возвращает число обработанных объектов (для логов). */
  run: () => Promise<number>;
}

const registeredWorkers: WorkerDefinition[] = [];

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
function bootstrap(): void {
  log('Запуск фоновых воркеров...');

  if (registeredWorkers.length === 0) {
    log(
      'Воркеры ещё не зарегистрированы: модули реализуются на этапах 2–5 ' +
        '(docs/09-roadmap.md). Процесс ожидает подключения задач.',
    );
  }

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

// try/catch, а не `.catch()`: bootstrap синхронный и не возвращает Promise,
// поэтому обработчик ошибок должен быть обычным блоком — `.catch()` здесь
// упал бы с «bootstrap(...).catch is not a function».
try {
  bootstrap();
} catch (error: unknown) {
  logError('bootstrap', error);
  process.exit(1);
}
