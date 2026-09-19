/**
 * Проверка импортов, которые ломают запуск API в продакшне.
 *
 * ## Какая ошибка здесь ловится
 *
 * При выкате дефекта 55 `PrismaService` получил `import { connectionLimit } from '@app/db'`.
 * Сборка прошла (`nest build` транспилирует типы), тесты прошли, типы сошлись — но при
 * ЗАПУСКЕ приложение упало:
 *
 * ```
 * packages/db/src/index.ts:8
 * import type { Prisma } from '@prisma/client';
 * SyntaxError: Unexpected token '{'
 * ```
 *
 * Причина: `packages/db/package.json` указывает `main` и `exports` на `./src/index.ts`,
 * то есть на ИСХОДНЫЙ TypeScript. `@app/db` собирается не для Node, а для типов и Prisma
 * CLI; импортировать его из рантайма нельзя. `@app/shared` собирается в `dist` и
 * импортируется нормально.
 *
 * ## Почему именно так, а не запуском собранного приложения
 *
 * Запуск `dist/main.js` в тесте требовал бы рабочей базы и занял бы секунды на каждый
 * прогон. Проверка разницы здесь — это ОДНО свойство: пакет, импортируемый рантаймом,
 * обязан указывать на собранный JavaScript. Ошибка именно в этом свойстве, и находится
 * она чтением `package.json`, а не запуском.
 *
 * ## Почему не полагаться на сборку
 *
 * `nest build` резолвит типы по `types`/`exports` и не проверяет, что путь исполним для
 * Node. Ошибка видна только при запуске — то есть на сервере, в работающей системе.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Корень репозитория: файл лежит в `apps/api/src/common/prisma/`. */
const repoRoot = resolve(__dirname, '../../../../..');

function readPackage(path: string): {
  main?: string;
  exports?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as {
    main?: string;
    exports?: Record<string, unknown>;
  };
}

/** Путь, на который указывает `main` или `exports['.']`, в каком бы виде он ни был задан. */
function entryPoint(pkg: { main?: string; exports?: Record<string, unknown> }): string {
  const exported = pkg.exports?.['.'];
  if (typeof exported === 'string') return exported;
  if (exported !== null && typeof exported === 'object') {
    const record = exported as { default?: string; types?: string };
    if (typeof record.default === 'string') return record.default;
    if (typeof record.types === 'string') return record.types;
  }
  return pkg.main ?? '';
}

describe('Импорты, исполнимые при запуске API', () => {
  it('@app/shared указывает на собранный JavaScript, а не на исходники', () => {
    /*
     * От `@app/shared` зависит рантайм API: из него берутся правила домена,
     * схемы проверки и, начиная с дефекта 55, ограничение пула соединений.
     */
    const entry = entryPoint(readPackage('packages/shared/package.json'));
    expect(entry).toMatch(/\.js$/);
    expect(entry).not.toMatch(/\.ts$/);
  });

  it('@app/db НЕ указывает на собранный JavaScript — его нельзя импортировать в рантайме', () => {
    /*
     * Это фиксация ФАКТА, а не желаемого поведения. Пакет задуман как источник
     * типов и клиента для Prisma CLI; рантайм API использует свой `PrismaService`.
     * Если однажды `@app/db` соберут в `dist`, тест упадёт — и это правильный
     * момент перечитать, не пора ли объединить клиентов Prisma.
     */
    const entry = entryPoint(readPackage('packages/db/package.json'));
    expect(entry).toMatch(/\.ts$/);
  });

  it('PrismaService не импортирует @app/db', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА. Именно этот импорт вывел API из строя: сборка и типы
     * прошли, а `import ... from '@app/db'` в исполняемом файле не резолвится.
     * Проверяется по исходнику, потому что transpiled-вывод создаётся только
     * при сборке, а ошибку нужно увидеть раньше — на прогоне тестов.
     */
    const source = readFileSync(
      resolve(repoRoot, 'apps/api/src/common/prisma/prisma.service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]@app\/db['"]/);
  });
});
