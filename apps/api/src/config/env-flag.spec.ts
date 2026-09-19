/**
 * Чтение флагов окружения (регрессия на дефект, найденный в задаче 5.11).
 *
 * ## Что произошло
 *
 * `envSchema` объявляет флаг как `z.coerce.boolean()`, то есть строка `'true'`
 * превращается в БУЛЕВО `true`. При этом код читал значение так:
 *
 * ```ts
 * config.get<string>('NOTIFICATIONS_SMS_ENABLED') === 'true'
 * ```
 *
 * Булево значение не равно строке `'true'` НИКОГДА. Флаг `=true` не действовал:
 * `channelsFor` получал `smsEnabled: false`, и SMS не отправлялись вовсе.
 *
 * Дефект был невидим, потому что состояние каналов считает ДРУГОЙ код
 * (`readSmsSettings`), который до этой правки читал значение как `String(enabled)`
 * и работал правильно. В интерфейсе администратора канал выглядел настроенным,
 * а сообщения не уходили — то есть проверка «канал включён?» давала верный ответ,
 * а отправка не происходила.
 *
 * ## Почему тест на `envFlag`, а не на каждом месте вызова
 *
 * Мест три (`NOTIFICATIONS_SMS_ENABLED`, `NOTIFICATIONS_MESSENGER_ENABLED`,
 * `SMTP_SECURE`), и все три ошибались одинаково. Проверка самой функции плюс
 * запрет на сравнение со строкой ниже закрывают весь класс: новое место с такой
 * же ошибкой попадёт под тот же запрет.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFlag } from './env.validation';

describe('envFlag: разбор значения окружения', () => {
  it('булево true считывается как включено', () => {
    /*
     * ГЛАВНЫЙ СЛУЧАЙ. Именно так значение приходит после `z.coerce.boolean()`:
     * схема уже привела строку `'true'` к булеву `true`.
     */
    expect(envFlag(true)).toBe(true);
  });

  it('булево false считывается как выключено', () => {
    expect(envFlag(false)).toBe(false);
  });

  it('строка true тоже работает', () => {
    // Запасной путь: если схема однажды перестанет приводить тип.
    expect(envFlag('true')).toBe(true);
  });

  it('прочие строки считаются выключенными', () => {
    // `Boolean('false')` дал бы `true` — именно поэтому нужна явная проверка.
    expect(envFlag('false')).toBe(false);
    expect(envFlag('1')).toBe(false);
    expect(envFlag('yes')).toBe(false);
    expect(envFlag('')).toBe(false);
  });

  it('отсутствующее значение считается выключенным', () => {
    // Отсутствие флага — не ошибка: каналы по умолчанию выключены.
    expect(envFlag(undefined)).toBe(false);
    expect(envFlag(null)).toBe(false);
    expect(envFlag(0)).toBe(false);
  });

  it('булево значение НЕ равно строке — обоснование функции', () => {
    /*
     * Фиксируем причину существования `envFlag`: без неё сравнение, которое
     * стояло в коде, всегда ложно. Тест останется осмысленным даже если
     * реализацию перепишут.
     */
    expect((true as unknown) === 'true').toBe(false);
  });
});

describe('Запрет сравнения флагов окружения со строкой', () => {
  it('в исходном коде API нет сравнений приведённых флагов со строкой', () => {
    /*
     * Автоматический запрет на весь класс дефекта. Перечислены флаги, которые
     * схема объявляет как `z.coerce.boolean()`: для них `=== 'true'` — ошибка
     * независимо от того, в каком файле она допущена.
     *
     * Проверка читает исходники, а не поведение: молчаливо выключенный канал не
     * проявляется ни в одном функциональном тесте — в этом и была беда.
     */
    const coercedFlags = [
      'S3_FORCE_PATH_STYLE',
      'SMTP_SECURE',
      'INTEGRATION_1C_ENABLED',
      'INTEGRATION_PBX_ENABLED',
      'NOTIFICATIONS_SMS_ENABLED',
      'NOTIFICATIONS_MESSENGER_ENABLED',
      'METRICS_ENABLED',
    ];

    const offenders: string[] = [];

    /*
     * Путь строится от самого файла теста, а не от `process.cwd()`: тесты
     * запускаются из корня репозитория, и `cwd()/src` указывал бы в никуда.
     * Абсолютный путь от `import.meta.url` не зависит от способа запуска.
     */
    const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

    for (const file of sourceFiles(apiRoot)) {
      const text = readFileSync(file, 'utf8');
      for (const flag of coercedFlags) {
        // Ищем `... 'ИМЯ_ФЛАГА') === 'true'` и обратный порядок.
        const bad = new RegExp(
          `['"\`]${flag}['"\`]\\s*\\)?\\s*[!=]==?\\s*['"]true['"]|['"]true['"]\\s*[!=]==?\\s*['"\`]${flag}`,
        );
        if (bad.test(text)) offenders.push(`${file.split('/src/')[1]}: ${flag}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/** Все файлы `.ts` под каталогом, кроме тестов. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}
