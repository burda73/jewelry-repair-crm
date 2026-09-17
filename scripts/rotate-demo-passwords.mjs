/**
 * Ротация паролей демонстрационных учётных записей.
 *
 * ЗАЧЕМ: пароль `DemoPassword123` из `packages/db/prisma/seed.ts` попадает в
 * открытый репозиторий вместе с адресами девяти учётных записей
 * (`admin@remixgold.ru`, `manager@remixgold.ru`, …). Пока учётные записи с этим
 * паролем существуют в базе, любой, кто видит репозиторий и имеет доступ во
 * внутреннюю сеть, может войти в систему. `gitleaks` такой пароль не находит:
 * для сканера он не является секретом.
 *
 * ЧТО ДЕЛАЕТ: генерирует каждому пользователю отдельный стойкий пароль,
 * записывает его хеш (Argon2id, те же параметры, что у приложения) и выводит
 * пароли один раз в открытом виде — сохранить их нужно сразу, восстановить
 * нельзя, в базе лежит только хеш.
 *
 * ПОЧЕМУ СКРИПТ, А НЕ `auth.changePassword`: тот требует текущий пароль, а
 * массовая ротация по определению делается без него. Скрипт повторяет всё
 * остальное поведение приложения: те же параметры Argon2id, `mustChangePassword:
 * true` (пользователь обязан задать свой пароль при первом входе) и запись в
 * `audit_log` с явной причиной — чтобы в аудите было видно, откуда взялись
 * новые пароли, и запись не выглядела подменой.
 *
 * ВАЖНО: учётная запись, чей пароль меняется, должна остаться с ролью. Учётная
 * запись без ролей не может войти в систему, и её «ротация» была бы ложным
 * успокоением: скрипт сообщает о таких и завершается ошибкой.
 *
 * Использование (по умолчанию — только показать план, ничего не менять):
 *   node scripts/rotate-demo-passwords.mjs
 *   node scripts/rotate-demo-passwords.mjs --apply
 *   node scripts/rotate-demo-passwords.mjs --apply --emails=admin@remixgold.ru
 *   node scripts/rotate-demo-passwords.mjs --apply --out=.local/new-passwords.txt
 *
 * Переменные окружения:
 *   DATABASE_URL  — строка подключения (как у API).
 */

import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function argValue(name) {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return null;
}

const APPLY = argv.includes('--apply');
const EMAILS_ARG = argValue('emails');
const OUT_ARG = argValue('out');

/** Отбирать только перечисленные адреса — чтобы можно было ротировать часть. */
const onlyEmails = EMAILS_ARG
  ? new Set(
      EMAILS_ARG.split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    )
  : null;

// ---------------------------------------------------------------------------
// Подключение
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ОШИБКА: не задан DATABASE_URL.');
  console.error('  Пример: DATABASE_URL="postgresql://…" node scripts/rotate-demo-passwords.mjs');
  process.exit(1);
}

const rootDir = resolve(import.meta.dirname, '..');

/** Резолвим пакеты из корня воркспейса: скрипт запускают и из подкаталога. */
function resolveFromRoot(specifier) {
  return import.meta.resolve(specifier, `file://${resolve(rootDir, 'package.json')}`);
}

const { PrismaClient } = await import(resolveFromRoot('@prisma/client'));

let argon2;
try {
  argon2 = await import(resolveFromRoot('argon2'));
} catch {
  console.error('ОШИБКА: не найден пакет `argon2`.');
  console.error('  Он объявлен в зависимостях API, поэтому запускайте скрипт');
  console.error('  из корня проекта после `npm ci`.');
  process.exit(1);
}
const { hash } = argon2.default ?? argon2;

// Параметры обязаны совпадать с `ARGON2_OPTIONS` в
// `apps/api/src/modules/auth/auth.service.ts`. Иначе хеш останется
// проверяемым (Argon2 хранит параметры внутри строки), но новые пароли
// окажутся слабее принятой в проекте нормы.
const ARGON2_OPTIONS = {
  type: 2, // argon2id
  memoryCost: 65_536, // 64 МБ
  timeCost: 3,
  parallelism: 4,
};

// ---------------------------------------------------------------------------
// Генерация пароля
// ---------------------------------------------------------------------------

// Алфавит без визуально неоднозначных символов (0/O, 1/l/I), потому что
// пароли придётся перенабирать вручную с экрана или из распечатки.
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const ALL = LOWER + UPPER + DIGIT;

// Парольная политика проекта требует минимум 12 символов. Берём 20: запас
// прочности при ручном вводе не мешает, а перебор делает бессмысленным.
const PASSWORD_LENGTH = 20;

/**
 * Криптостойкий пароль, гарантированно проходящий `passwordSchema`:
 * длина ≥ 12, есть строчная, заглавная и цифра.
 *
 * Первые три символа берутся по одному из каждой группы, остальные —
 * из общего алфавита, затем позиции перемешиваются. Так требование
 * «есть цифра» выполняется всегда, а не с вероятностью.
 */
function generatePassword() {
  const chars = [
    LOWER[randomInt(LOWER.length)],
    UPPER[randomInt(UPPER.length)],
    DIGIT[randomInt(DIGIT.length)],
  ];
  while (chars.length < PASSWORD_LENGTH) {
    chars.push(ALL[randomInt(ALL.length)]);
  }
  // Перемешивание Фишера—Йетса на криптостойком источнике: иначе первые три
  // позиции всегда имели бы предсказуемый состав групп.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Основной сценарий
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

function fail(message) {
  console.error(`\nОШИБКА: ${message}`);
  process.exitCode = 1;
}

try {
  const users = await prisma.user.findMany({
    where: onlyEmails ? { email: { in: [...onlyEmails] } } : undefined,
    select: {
      id: true,
      email: true,
      fullName: true,
      isActive: true,
      roles: { select: { role: true } },
      // Активные сессии отзываются вместе с паролем: без этого refresh-токен
      // продолжал бы работать 30 дней, и ротация ничего не давала бы тому,
      // кто уже вошёл старым паролем.
      sessions: { where: { revokedAt: null }, select: { id: true } },
    },
    orderBy: { email: 'asc' },
  });

  if (users.length === 0) {
    fail('в базе нет учётных записей, подходящих под фильтр.');
  } else {
    // Учётная запись без ролей войти не может, и менять ей пароль бессмысленно:
    // это создало бы видимость защищённой системы. Сообщаем отдельно.
    const withoutRoles = users.filter((u) => u.roles.length === 0);

    console.log(
      `\nУчётных записей к ротации: ${users.length}${onlyEmails ? ' (фильтр по адресам)' : ''}`,
    );
    console.log(
      `Режим: ${APPLY ? 'ПРИМЕНЕНИЕ — пароли будут изменены' : 'план (ничего не меняется)'}\n`,
    );

    const totalSessions = users.reduce((n, u) => n + u.sessions.length, 0);
    if (totalSessions > 0) {
      console.log(
        `Активных сессий к отзыву: ${totalSessions}\n` +
          '  Все, кто уже вошёл под этими учётными записями, будут разлогинены.\n',
      );
    }

    for (const u of users) {
      const marks = [];
      if (!u.isActive) marks.push('отключена');
      if (u.roles.length === 0) marks.push('БЕЗ РОЛЕЙ');
      const suffix = marks.length ? `  [${marks.join(', ')}]` : '';
      console.log(`  ${u.email.padEnd(28)} ${u.fullName}${suffix}`);
    }

    if (withoutRoles.length > 0) {
      fail(
        `учётные записи без ролей: ${withoutRoles.map((u) => u.email).join(', ')}.\n` +
          '  Ротация пароля такой учётной записи ничего не защищает — сначала выдайте роль.',
      );
    } else if (!APPLY) {
      console.log('\nЭто был план. Для применения добавьте --apply\n');
    } else {
      const results = [];

      for (const u of users) {
        const password = generatePassword();
        const passwordHash = await hash(password, ARGON2_OPTIONS);

        await prisma.$transaction([
          prisma.user.update({
            where: { id: u.id },
            data: {
              passwordHash,
              // Пароль знает администратор, а не владелец учётной записи,
              // поэтому требуем смену при первом входе — как при выдаче
              // учётной записи в `seed.ts`.
              mustChangePassword: true,
              // Сбрасываем блокировки и счётчик неудачных попыток: иначе
              // учётная запись с исчерпанным лимитом осталась бы недоступна
              // даже с новым паролем.
              failedAttempts: 0,
              lockedUntil: null,
            },
          }),
          prisma.auditLog.create({
            data: {
              actorId: u.id,
              actorRole: u.roles[0].role,
              action: 'UPDATE',
              entity: 'User',
              entityId: u.id,
              after: { passwordRotated: true, mustChangePassword: true },
              reason:
                'Плановая ротация пароля: демонстрационный пароль был опубликован в репозитории',
            },
          }),
          // Отзываем активные сессии — ровно так же, как это делает
          // `AuthService.changePassword`. Без этого шага ротация пароля почти
          // бесполезна: refresh-токен живёт 30 дней, и тот, кто вошёл старым
          // паролем, сохранил бы доступ, даже не зная нового.
          prisma.userSession.updateMany({
            where: { userId: u.id, revokedAt: null },
            data: { revokedAt: new Date() },
          }),
        ]);

        results.push({ email: u.email, fullName: u.fullName, password });
        console.log(`  изменён пароль: ${u.email}`);
      }

      console.log(`\nПароли изменены: ${results.length}\n`);
      console.log('='.repeat(72));
      console.log('НОВЫЕ ПАРОЛИ — сохраните сейчас, восстановить их нельзя');
      console.log('(в базе хранится только хеш Argon2id)');
      console.log('='.repeat(72));
      for (const r of results) {
        console.log(`  ${r.email.padEnd(28)} ${r.password}   (${r.fullName})`);
      }
      console.log('='.repeat(72));
      console.log('\nПри первом входе система потребует сменить пароль на свой.\n');

      if (OUT_ARG) {
        const outPath = resolve(rootDir, OUT_ARG);
        // Каталог .local/ в .gitignore — файл с паролями не должен попасть в git.
        mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
        writeFileSync(
          outPath,
          [
            '# Новые пароли демонстрационных учётных записей',
            `# Создан: ${new Date().toISOString()}`,
            '# При первом входе система потребует сменить пароль.',
            '',
            ...results.map((r) => `${r.email}\t${r.password}\t${r.fullName}`),
            '',
          ].join('\n'),
          { mode: 0o600 },
        );
        console.log(`Пароли записаны в ${outPath} (права 600)`);
        if (!existsSync(resolve(rootDir, '.gitignore'))) {
          console.warn('ВНИМАНИЕ: не найден .gitignore — убедитесь, что файл не попадёт в git.');
        }
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  await prisma.$disconnect();
}
