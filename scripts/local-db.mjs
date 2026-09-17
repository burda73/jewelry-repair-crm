/**
 * Локальный PostgreSQL 16 для отладки — без Docker и без установки в систему.
 *
 * ЗАЧЕМ: в продакшне БД внешняя (ответ A1, infra/db/README.md), но для отладки
 * нужен локальный сервер. Скрипт поднимает настоящий PostgreSQL 16.14 из
 * npm-пакета `embedded-postgres`: бинарники лежат в node_modules, данные — в
 * `.local/postgres`. Ничего не устанавливается в систему, права root не нужны.
 *
 * Версия совпадает с продакшном (16.x) — важно, потому что поведение БД и
 * планировщик отличаются между мажорными версиями, и отладка на другой версии
 * может скрыть проблему, которая проявится на сервере.
 *
 * Процесс запускается через `pg_ctl`, а не через API пакета: API останавливает
 * сервер при завершении скрипта, а нам нужна БД, живущая в фоне между командами.
 *
 * Использование:
 *   node scripts/local-db.mjs start     — запустить
 *   node scripts/local-db.mjs stop      — остановить
 *   node scripts/local-db.mjs status    — проверить состояние
 *   node scripts/local-db.mjs reset     — удалить данные и создать заново
 *   node scripts/local-db.mjs psql      — открыть psql-консоль
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOCAL_DIR = join(ROOT, '.local');
const DATA_DIR = join(LOCAL_DIR, 'postgres');
const LOG_FILE = join(LOCAL_DIR, 'postgres.log');
const STATE_FILE = join(LOCAL_DIR, 'postgres.state.json');

/** Каталог с бинарниками PostgreSQL из состава npm-пакета. */
const BIN_DIR = join(
  ROOT,
  'node_modules',
  '@embedded-postgres',
  process.platform === 'darwin' ? 'darwin-x64' : 'linux-x64',
  'native',
  'bin',
);

/** Параметры совпадают с DATABASE_URL в .env.example — править ничего не нужно. */
const DB = {
  user: 'repair',
  password: 'repair',
  name: 'repair',
  port: Number(process.env.LOCAL_DB_PORT ?? 5432),
};

const log = (m) => console.log(`[local-db] ${m}`);
const fail = (m) => {
  console.error(`[local-db] ОШИБКА: ${m}`);
  process.exit(1);
};

/** Запустить бинарник PostgreSQL с аргументами. */
function pg(bin, args, options = {}) {
  const result = spawnSync(join(BIN_DIR, bin), args, {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: DB.password },
    ...options,
  });
  return result;
}

const isInitialised = () => existsSync(join(DATA_DIR, 'PG_VERSION'));

function isRunning() {
  if (!isInitialised()) return false;
  return pg('pg_ctl', ['status', '-D', DATA_DIR]).status === 0;
}

function initialise() {
  mkdirSync(LOCAL_DIR, { recursive: true });
  log('Создаю кластер PostgreSQL 16.14 (несколько секунд)');

  // Локаль ru_RU.UTF-8, как требует infra/db/README.md §1.1: иначе русские ФИО
  // сортируются неверно — расхождение с продакшном скрыло бы ошибки поиска.
  const result = pg('initdb', [
    '-D', DATA_DIR,
    '-U', DB.user,
    '--auth=scram-sha-256',
    '--pwfile=/dev/stdin',
    '--encoding=UTF8',
    `--locale=ru_RU.UTF-8`,
  ], { input: `${DB.password}\n` });

  if (result.status !== 0) {
    fail(`initdb завершился с ошибкой:\n${result.stderr || result.stdout}`);
  }
  log('Кластер создан');
}

async function start() {
  if (isRunning()) {
    log(`PostgreSQL уже запущен на порту ${DB.port}`);
    printConnection();
    return;
  }

  if (!isInitialised()) {
    initialise();
  }

  // -l: лог сервера в файл. Без него pg_ctl молча теряет вывод postgres.
  const result = pg('pg_ctl', [
    'start',
    '-D', DATA_DIR,
    '-l', LOG_FILE,
    '-o', `-p ${DB.port} -c listen_addresses=localhost`,
    '-w', '-t', '60',
  ]);

  if (result.status !== 0) {
    fail(`Не удалось запустить PostgreSQL:\n${result.stderr || result.stdout}\nЛог: ${LOG_FILE}`);
  }

  await ensureDatabase();

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ ...DB, startedAt: new Date().toISOString() }, null, 2),
  );

  log(`PostgreSQL 16.14 запущен на порту ${DB.port}`);
  printConnection();
}

/** Создать базу приложения, если её ещё нет. */
async function ensureDatabase() {
  const { Client } = await import('pg');

  // Подключаемся к служебной БД postgres: в npm-пакете нет утилиты createdb,
  // поэтому создаём базу SQL-запросом через pg-клиент.
  const client = new Client({
    host: 'localhost',
    port: DB.port,
    user: DB.user,
    password: DB.password,
    database: 'postgres',
  });

  try {
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB.name]);
    if (exists.rowCount === 0) {
      // Имя базы нельзя параметризовать в CREATE DATABASE — экранируем кавычками.
      await client.query(`CREATE DATABASE "${DB.name.replace(/"/g, '""')}"`);
      log(`База «${DB.name}» создана`);
    }
  } catch (error) {
    log(`Предупреждение: не удалось проверить/создать базу: ${error.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

function stop() {
  if (!isRunning()) {
    log('PostgreSQL не запущен');
    return;
  }
  const result = pg('pg_ctl', ['stop', '-D', DATA_DIR, '-m', 'fast', '-w', '-t', '60']);
  if (result.status !== 0) fail(`Не удалось остановить:\n${result.stderr || result.stdout}`);
  log('PostgreSQL остановлен');
}

function status() {
  const running = isRunning();
  log(running ? `запущен на порту ${DB.port}` : 'не запущен');
  if (existsSync(STATE_FILE)) {
    try {
      // Файл состояния читаем, чтобы показать реальные параметры работающего
      // кластера: раньше значение парсилось и не использовалось, поэтому
      // status показывал только «запущен», без порта и каталога данных.
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      if (state.port) log(`порт: ${state.port}`);
      log(`данные: ${DATA_DIR}`);
    } catch { /* повреждённый файл состояния не критичен */ }
  }
  if (!running) process.exitCode = 1;
}

async function reset() {
  if (isRunning()) stop();
  if (existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    log('Данные удалены');
  }
  await start();
}

function printConnection() {
  console.log('');
  console.log('  DATABASE_URL:');
  console.log(`  postgresql://${DB.user}:${DB.password}@localhost:${DB.port}/${DB.name}?schema=public`);
  console.log('');
  console.log('  Данные: .local/postgres (в .gitignore)');
  console.log('  Лог:    .local/postgres.log');
  console.log('');
}

const command = process.argv[2] ?? 'start';

switch (command) {
  case 'start': await start(); break;
  case 'stop': stop(); break;
  case 'status': status(); break;
  case 'reset': await reset(); break;
  case 'psql': {
    // Бинарника psql в npm-пакете нет, поэтому подключаемся через pg-клиент.
    if (!isRunning()) fail('PostgreSQL не запущен. Сначала: node scripts/local-db.mjs start');
    const { Client } = await import('pg');
    const client = new Client({
      host: 'localhost', port: DB.port,
      user: DB.user, password: DB.password, database: DB.name,
    });
    await client.connect();
    console.log(`Подключено к ${DB.name}@localhost:${DB.port}. Введите SQL, пустая строка — выход.`);
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const sql = (await rl.question('sql> ')).trim();
      if (!sql) break;
      try {
        const res = await client.query(sql);
        console.log(res.rows.length ? res.rows : `OK, строк: ${res.rowCount}`);
      } catch (error) {
        console.error(`Ошибка: ${error.message}`);
      }
    }
    rl.close();
    await client.end();
    break;
  }
  default:
    console.error(`Неизвестная команда: ${command}`);
    console.error('Использование: node scripts/local-db.mjs {start|stop|status|reset|psql}');
    process.exit(1);
}
