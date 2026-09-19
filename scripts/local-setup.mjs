/**
 * Подготовка локальной среды отладки «в одну команду».
 *
 * ЧТО ДЕЛАЕТ:
 *   1. Поднимает локальный PostgreSQL 16.14 (scripts/local-db.mjs).
 *   2. Создаёт `.env` из `.env.example` с локальными значениями и
 *      сгенерированными секретами (если файла ещё нет — существующий не трогает).
 *   3. Применяет схему БД (prisma migrate deploy) и загружает демо-данные (seed).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ: запуск проекта требовал четырёх ручных шагов, и на
 * каждом легко ошибиться (например, не указать DATABASE_URL для Prisma — она
 * не читает корневой `.env`, если запускается из своего пакета).
 *
 * Использование: npm run local:setup
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const LOCAL_DATABASE_URL = 'postgresql://repair:repair@localhost:5432/repair?schema=public';

const log = (m) => console.log(`\n[setup] ${m}`);
const fail = (m) => {
  console.error(`\n[setup] ОШИБКА: ${m}`);
  process.exit(1);
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0 && !options.allowFailure) {
    fail(`команда завершилась с кодом ${result.status}: ${command} ${args.join(' ')}`);
  }
  return result.status;
}

// --- Шаг 1. Локальная БД -----------------------------------------------------
log('Шаг 1/4: запускаю локальный PostgreSQL 16.14');
run(process.execPath, [join(ROOT, 'scripts', 'local-db.mjs'), 'start']);

// --- Шаг 2. .env -------------------------------------------------------------
log('Шаг 2/4: проверяю .env');
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  const current = readFileSync(envPath, 'utf8');
  if (!current.includes('localhost:5432/repair')) {
    console.log('  .env уже существует и указывает на другую БД — не изменяю.');
    console.log('  Если это внешняя БД из infra/db/README.md, всё верно.');
    console.log('  Для локальной отладки замените DATABASE_URL на:');
    console.log(`  ${LOCAL_DATABASE_URL}`);
  } else {
    console.log('  .env уже настроен на локальную БД');
  }
} else {
  // Секреты генерируются, а не остаются заглушками CHANGE_ME: приложение
  // намеренно не стартует с небезопасной конфигурацией, и отладка встала бы
  // на первом же запуске.
  let template = readFileSync(join(ROOT, '.env.example'), 'utf8');
  template = template
    .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL="${LOCAL_DATABASE_URL}"`)
    .replace(/^JWT_ACCESS_SECRET=.*$/m, `JWT_ACCESS_SECRET="${randomBytes(48).toString('base64')}"`)
    .replace(
      /^JWT_REFRESH_SECRET=.*$/m,
      `JWT_REFRESH_SECRET="${randomBytes(48).toString('base64')}"`,
    )
    .replace(/^CSRF_SECRET=.*$/m, `CSRF_SECRET="${randomBytes(24).toString('base64')}"`);
  writeFileSync(envPath, template);
  console.log('  .env создан: локальная БД + сгенерированные секреты');
}

// --- Шаг 3. Схема БД ---------------------------------------------------------
// Prisma запускается из packages/db и НЕ читает корневой .env, поэтому
// DATABASE_URL передаётся явно. Внешняя БД подхватывается из .env пользователя.
log('Шаг 3/4: применяю схему БД');
const dotenv = readFileSync(envPath, 'utf8').match(/^DATABASE_URL="?([^"\n]+)"?$/m);
const databaseUrl = dotenv?.[1] ?? LOCAL_DATABASE_URL;

const prismaBin = join(ROOT, 'node_modules', '.bin', 'prisma');
const schemaPath = join(ROOT, 'packages', 'db', 'prisma', 'schema.prisma');

const migrateStatus = run(prismaBin, ['migrate', 'deploy', '--schema', schemaPath], {
  env: { DATABASE_URL: databaseUrl },
  allowFailure: true,
});

if (migrateStatus !== 0) {
  fail(
    'не удалось применить миграции.\n' +
      `  DATABASE_URL: ${databaseUrl.replace(/:[^:@]*@/, ':***@')}\n` +
      '  Проверьте доступность БД: npm run local:db:status\n' +
      '  Требования к внешней БД: infra/db/README.md',
  );
}

// --- Шаг 4. Демо-данные ------------------------------------------------------
log('Шаг 4/4: загружаю демо-данные');
run('npm', ['run', 'seed', '--workspace', '@app/db'], { env: { DATABASE_URL: databaseUrl } });

log('Готово. Запускайте проект:');
console.log('  npm run dev        — API и веб-интерфейс');
console.log('  npm run dev:api    — только API      http://localhost:4000/api/docs');
console.log('  npm run dev:web    — только веб      http://localhost:3000');
console.log('\n  Вход: receiver1@remixgold.ru / DemoPassword123 (или admin@remixgold.ru)');
