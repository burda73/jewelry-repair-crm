/**
 * Генерация Prisma Client после установки зависимостей.
 *
 * ЗАЧЕМ: `npm ci`/`npm install` полностью пересоздают `node_modules`, вместе с
 * каталогом `node_modules/.prisma/client`. В нём живут типы всех моделей
 * (`Prisma.OrderWhereInput`, `Prisma.validator`, `StageNorm`, …), поэтому без
 * повторной генерации сборка API падает с десятком ошибок вида
 * `Namespace 'Prisma' has no exported member 'OrderWhereInput'`.
 *
 * Дефект реально проявился при развёртывании интерфейса на сервере
 * (`infra/db/deployment-report.md` §5.7): после `npm ci` сборка API не проходила,
 * пока не выполнили `prisma generate` вручную.
 *
 * ПОЧЕМУ НЕ ПРОСТО `npm run db:generate`: Prisma CLI объявлен в
 * `devDependencies`, и при установке с `--omit=dev` (или в среде, где он не
 * поставлен) команда завершится ошибкой. Postinstall не должен ронять установку
 * боевых зависимостей из-за инструмента сборки, поэтому отсутствие CLI — не
 * ошибка, а повод пропустить шаг с понятным сообщением.
 *
 * Генерация не требует подключения к БД: читается только `schema.prisma`,
 * поэтому `DATABASE_URL` здесь не нужен.
 *
 * Использование (вызывается автоматически при `npm install`):
 *   node scripts/postinstall.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = join(rootDir, 'packages/db/prisma/schema.prisma');

/**
 * Ищем CLI Prisma в `node_modules/.bin`, а не полагаемся на `npx`:
 * `npx` при отсутствии пакета попытается скачать его из сети, и установка
 * становится непредсказуемой — вплоть до падения без интернета.
 */
function findPrismaCli() {
  const candidate = join(rootDir, 'node_modules/.bin/prisma');
  return existsSync(candidate) ? candidate : null;
}

function main() {
  if (!existsSync(schemaPath)) {
    console.log('[postinstall] Схема Prisma не найдена, шаг пропущен:', schemaPath);
    return;
  }

  const prismaCli = findPrismaCli();

  if (prismaCli === null) {
    // Это нормальная ситуация: установка только боевых зависимостей.
    console.log(
      '[postinstall] Prisma CLI не установлен (нет devDependencies).\n' +
        '              Генерация клиента пропущена.\n' +
        '              Если собираетесь запускать сборку или тесты, выполните:\n' +
        '                npm install && npm run db:generate',
    );
    return;
  }

  console.log('[postinstall] Генерация Prisma Client...');

  const result = spawnSync(prismaCli, ['generate', `--schema=${schemaPath}`], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error('[postinstall] Не удалось запустить Prisma CLI:', result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error('[postinstall] prisma generate завершился с кодом', result.status);
    process.exit(1);
  }

  console.log('[postinstall] Prisma Client сгенерирован.');
}

main();
