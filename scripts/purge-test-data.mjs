#!/usr/bin/env node
/**
 * Очистка тестовых данных перед переключением системы в продакшн.
 *
 * Требование заказчика: в момент перевода проекта в боевую эксплуатацию
 * должна быть возможность удалить всё, что накопилось при разработке и
 * проверках, — заказы, клиентов, платежи, фотографии, историю операций.
 *
 * Что удаляется (транзакционные данные — результат работы людей и проверок):
 *   заказы, изделия, работы, камни, платежи, согласования, корректировки,
 *   история статусов, фотографии и файлы, партии и их акты, рекламации,
 *   уведомления, обмен с внешними системами, записи разговоров, отказы,
 *   клиенты, журнал аудита, сессии входа.
 *
 * Что СОХРАНЯЕТСЯ (настроечные данные — их не создают в ходе работы):
 *   сеть магазинов и цехов, прейскурант и его утверждённая версия, виды
 *   камней, категории работ, рабочий календарь, шаблоны уведомлений,
 *   исполнители, нормы этапов, настройки.
 *
 * Пользователи по умолчанию СОХРАНЯЮТСЯ. Причина практическая: управления
 * пользователями в системе пока нет (раздел 1.2.4 не реализован), поэтому
 * удаление учётных записей оставило бы систему без возможности входа.
 *
 * Демонстрационные учётные записи удаляются флагом `--users`, но ТОЛЬКО вместе
 * с `--keep-admin=<email>` — адресом реальной учётной записи администратора,
 * которая должна остаться. Без этого флага `--users` отказывается работать.
 *
 * Почему так, а не «удалить всех, кроме админов»: все девять учётных записей
 * из `seed.ts` демонстрационные, включая администратора, и у всех один
 * общеизвестный пароль. Поэтому «сохранить администратора» в общем случае
 * означало бы сохранить демо-учётку с известным паролем. Оператор должен явно
 * назвать ту учётную запись, которая останется рабочей, — тогда удаление
 * демо-аккаунтов не может запереть систему.
 *
 * Поведение по умолчанию — ПОКАЗАТЬ ПЛАН И НИЧЕГО НЕ МЕНЯТЬ. Удаление
 * выполняется только с флагом `--apply`: необратимая операция не должна
 * запускаться случайным нажатием.
 *
 * Использование:
 *   node scripts/purge-test-data.mjs                       # показать план
 *   node scripts/purge-test-data.mjs --apply               # удалить данные
 *   node scripts/purge-test-data.mjs --apply --files       # ещё и файлы с диска
 *   node scripts/purge-test-data.mjs --apply --users \
 *        --keep-admin=director@remixgold.ru                # и демо-аккаунты
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

/**
 * Транзакционные таблицы. Порядок не важен: используется `TRUNCATE ... CASCADE`
 * внутри одной транзакции, а внешние ключи разрешаются автоматически.
 *
 * Состав выверен по фактическому списку таблиц в БД (42 таблицы): перечислены
 * все, кроме настроечных. Если появится новая таблица с данными, её нужно
 * добавить сюда — иначе очистка останется неполной, и в продакшн попадут
 * данные проверок. Проверка полноты вынесена в отдельную функцию ниже.
 */
const TRANSACTIONAL_TABLES = [
  'approval',
  'calc_adjustment',
  'call_recording',
  'document',
  'integration_log',
  'integration_outbox',
  'notification',
  'item_photo',
  'item',
  'order_assignment',
  'order_status_history',
  'order_stone',
  'order_work',
  'payment',
  'refusal_act',
  'warranty_claim',
  'batch_act',
  'batch_photo',
  'batch_item',
  'batch',
  'order',
  'customer',
  'file_object',
  'audit_log',
  'user_session',
  // Нумерация заказов начинается заново: `generateOrderNo` создаёт счётчик
  // через `upsert` при первом заказе (см. пояснение в блоке удаления).
  'counter',
];

/**
 * Настроечные таблицы: сохраняются. Список нужен, чтобы скрипт сам заметил
 * новую таблицу и потребовал осознанного решения, а не молча её пропустил.
 */
const PRESERVED_TABLES = [
  '_prisma_migrations',
  'store',
  'workshop',
  'work_category',
  'price_list_version',
  'price_list_item',
  'price_list_item_rate',
  'stone_type',
  'working_calendar',
  'setting',
  'notification_template',
  'stage_norm',
  'performer',
  'user',
  'user_role',
  'user_store',
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => !a.startsWith('--keep-admin=')));
const APPLY = flags.has('--apply');
const PURGE_FILES = flags.has('--files');
const PURGE_USERS = flags.has('--users');

/** Адреса учётных записей, которые должны остаться при удалении демо-аккаунтов. */
const KEEP_ADMINS = args
  .filter((a) => a.startsWith('--keep-admin='))
  .map((a) => a.slice('--keep-admin='.length).trim().toLowerCase())
  .filter((a) => a !== '');

/** Строка подключения обязательна: у скрипта нет значения по умолчанию. */
function requireConnectionString() {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === '') {
    console.error('Не задан DATABASE_URL.');
    console.error('Пример: DATABASE_URL="postgresql://repair:…@localhost:5432/repair" \\');
    console.error('         node scripts/purge-test-data.mjs --apply');
    process.exit(1);
  }
  return url;
}

/** Сколько строк в таблице; `null`, если таблицы нет. */
async function countRows(client, table) {
  try {
    const result = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
    return result.rows[0].n;
  } catch {
    return null;
  }
}

/**
 * Проверить, что списки покрывают все таблицы базы.
 *
 * Без этой проверки новая таблица (например, добавленная на этапе 2) молча
 * осталась бы вне очистки, и тестовые данные попали бы в продакшн. Лучше
 * остановиться и потребовать решения, чем удалить неполно.
 */
async function assertCoversSchema(client) {
  const result = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const known = new Set([...TRANSACTIONAL_TABLES, ...PRESERVED_TABLES]);
  const unknown = result.rows.map((row) => row.tablename).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    console.error('Обнаружены таблицы, не отнесённые ни к тестовым, ни к настроечным:');
    for (const name of unknown) console.error(`  - ${name}`);
    console.error('');
    console.error('Добавьте их в TRANSACTIONAL_TABLES или PRESERVED_TABLES в scripts/purge-test-data.mjs.');
    console.error('Очистка остановлена: молча пропустить эти данные нельзя — они попадут в продакшн.');
    process.exit(1);
  }
}

/** Каталог файлов фотографий: переопределяется переменной окружения. */
function storageDir() {
  return process.env.STORAGE_LOCAL_DIR ?? '/opt/repair/data/files';
}

/** Удалить файлы фотографий с диска, сохранив сам каталог. */
async function purgeFiles() {
  const dir = storageDir();
  let removed = 0;
  try {
    await fs.access(dir);
  } catch {
    console.log(`  каталог ${dir} отсутствует — нечего удалять`);
    return 0;
  }
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const target = path.join(dir, entry);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      removed += await countFiles(target);
      await fs.rm(target, { recursive: true, force: true });
    } else {
      await fs.rm(target, { force: true });
      removed += 1;
    }
  }
  console.log(`  удалено файлов: ${removed}`);
  return removed;
}

/** Рекурсивно посчитать файлы — нужен только для отчёта. */
async function countFiles(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

async function main() {
  const connectionString = requireConnectionString();
  const client = new pg.Client({ connectionString });
  await client.connect();

  console.log('=== Очистка тестовых данных ===');
  console.log(APPLY ? 'Режим: УДАЛЕНИЕ' : 'Режим: только план (для удаления добавьте --apply)');
  console.log('');

  // Без явно названной сохраняемой учётной записи удалять пользователей нельзя:
  // все демо-аккаунты, включая администратора, имеют общеизвестный пароль.
  if (PURGE_USERS && KEEP_ADMINS.length === 0) {
    console.error('Отказ: флаг --users требует --keep-admin=<email>.');
    console.error('');
    console.error('Укажите учётную запись администратора, которая должна остаться рабочей:');
    console.error('  node scripts/purge-test-data.mjs --apply --users --keep-admin=director@remixgold.ru');
    console.error('');
    console.error('Без этого удаление демонстрационных записей оставило бы систему без входа.');
    await client.end();
    process.exit(1);
  }

  await assertCoversSchema(client);

  console.log('Будет УДАЛЕНО:');
  let totalRows = 0;
  for (const table of TRANSACTIONAL_TABLES) {
    const n = await countRows(client, table);
    if (n === null) continue;
    totalRows += n;
    if (n > 0) console.log(`  ${table.padEnd(24)} ${String(n).padStart(7)}`);
  }
  console.log(`  ${'ИТОГО'.padEnd(24)} ${String(totalRows).padStart(7)}`);

  console.log('');
  console.log('Будет СОХРАНЕНО:');
  for (const table of PRESERVED_TABLES) {
    if (table === '_prisma_migrations') continue;
    const n = await countRows(client, table);
    if (n === null) continue;
    console.log(`  ${table.padEnd(24)} ${String(n).padStart(7)}`);
  }

  if (!PURGE_USERS) {
    console.log('');
    console.log('Пользователи сохраняются. Для удаления демонстрационных учётных записей');
    console.log('добавьте --users и --keep-admin=<email> — адрес той записи администратора,');
    console.log('которая должна остаться рабочей.');
  } else {
    console.log('');
    console.log(`Будут удалены ВСЕ демонстрационные учётные записи, кроме: ${KEEP_ADMINS.join(', ')}`);
  }

  if (!APPLY) {
    console.log('');
    console.log('Ничего не изменено. Для удаления запустите с флагом --apply.');
    await client.end();
    return;
  }

  console.log('');
  console.log('=== Удаление ===');
  await client.query('BEGIN');
  try {
    /*
     * Флаг разрешает изменение журнала аудита только внутри этой транзакции.
     * Триггер `audit_log_append_only` (миграция 20260918000000) блокирует
     * правку и удаление аудита во всех остальных случаях — журнал остаётся
     * неизменяемым, а очистка тестовых данных возможна.
     */
    await client.query("SELECT set_config('app.allow_audit_purge', 'on', true)");

    const list = TRANSACTIONAL_TABLES.map((t) => `"${t}"`).join(', ');
    await client.query(`TRUNCATE ${list} CASCADE`);
    console.log(`  ${TRANSACTIONAL_TABLES.length} таблиц очищено`);

    /*
     * Счётчики номеров заказов отдельно не сбрасываются: таблица `counter`
     * очищается вместе с остальными. `generateOrderNo` создаёт счётчик через
     * `upsert` с `create: { value: 1 }`, поэтому после очистки нумерация
     * начинается с `…-000001` сама — отдельный сброс был бы мёртвым кодом и
     * создавал бы ложное впечатление, что он что-то делает.
     */

    if (PURGE_USERS) {
      /*
       * Удаляем все демонстрационные учётные записи, КРОМЕ явно названных
       * оператором (`--keep-admin=<email>`).
       *
       * Проверка «удалить всех, кроме администраторов» здесь не годится: все
       * девять учётных записей из `seed.ts` демонстрационные, и у администратора
       * тот же общеизвестный пароль. Если в базе не окажется роли `ADMIN`,
       * такая проверка пропустила бы удаление вообще всех записей — и вход в
       * систему стал бы невозможен. Поэтому имя сохраняемой учётной записи
       * задаётся явно, а её отсутствие в базе — ошибка.
       */
      const keep = KEEP_ADMINS;
      const kept = await client.query(
        'SELECT id, email FROM "user" WHERE lower(email) = ANY($1::text[])',
        [keep],
      );
      const found = new Set(kept.rows.map((row) => row.id));

      if (found.size !== keep.length) {
        const missing = keep.filter(
          (email) => !kept.rows.some((row) => row.email.toLowerCase() === email),
        );
        throw new Error(
          `Отказ: сохраняемые учётные записи не найдены в базе: ${missing.join(', ')}. ` +
            'Создайте администратора до очистки — иначе удаление оставит систему без входа.',
        );
      }

      await client.query('DELETE FROM "user_role" WHERE "userId" <> ALL($1::text[])', [[...found]]);
      await client.query('DELETE FROM "user_store" WHERE "userId" <> ALL($1::text[])', [[...found]]);
      const removed = await client.query('DELETE FROM "user" WHERE id <> ALL($1::text[])', [
        [...found],
      ]);
      console.log(`  пользователей удалено: ${removed.rowCount}`);
      console.log(`  сохранено учётных записей: ${found.size} (${keep.join(', ')})`);

      // Сохранённая учётная запись обязана иметь роль, иначе она не сможет
      // работать: область видимости и права берутся именно из `user_role`.
      const roles = await client.query(
        'SELECT count(*)::int AS n FROM "user_role" WHERE "userId" = ANY($1::text[])',
        [[...found]],
      );
      if (roles.rows[0].n === 0) {
        throw new Error(
          'Отказ: у сохраняемой учётной записи нет ни одной роли. ' +
            'Восстановите роль до очистки, иначе войти в систему будет нельзя.',
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('');
    console.error('Удаление отменено, база не изменена:', error.message);
    await client.end();
    process.exit(1);
  }

  if (PURGE_FILES) {
    console.log('');
    console.log('=== Удаление файлов фотографий ===');
    await purgeFiles();
  } else {
    console.log('');
    console.log('Файлы фотографий на диске не тронуты (добавьте --files, чтобы удалить).');
  }

  console.log('');
  console.log('Проверка после очистки:');
  let left = 0;
  for (const table of TRANSACTIONAL_TABLES) {
    const n = await countRows(client, table);
    if (n === null) continue;
    left += n;
    if (n > 0) console.log(`  ВНИМАНИЕ: ${table} содержит ${n}`);
  }
  console.log(left === 0 ? '  тестовых данных не осталось' : `  осталось строк: ${left}`);

  await client.end();
  console.log('');
  console.log('Готово.');
}

main().catch((error) => {
  console.error('Ошибка:', error.message);
  process.exit(1);
});
