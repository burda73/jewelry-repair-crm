import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Правила, важные для проекта:
 *  * запрет `any` — иначе теряется весь смысл TypeScript;
 *  * запрет `console.log` — логи только через структурированный логгер;
 *  * запрет `Float`-арифметики для денег проверяется ревью и тестами (см. money.ts).
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.spec.ts',
      '**/prisma/migrations/**',
      // Автогенерируется Next.js при каждой сборке — править бессмысленно.
      'apps/web/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Конфигурационные файлы и служебные скрипты не входят ни в один
          // tsconfig, из-за чего линт падал на них с «was not found by the
          // project service» — то есть `npm run lint` не доходил до проверки
          // реального кода. Перечисляем их явно: проверяются как отдельные
          // единицы, без типов из проекта.
          allowDefaultProject: [
            '*.config.mjs',
            'apps/web/*.config.mjs',
            'packages/shared/*.config.ts',
            // Конфигурация тестов пакета БД. Без этой строки линт падал на ней
            // с «was not found by the project service» и не доходил до
            // остального кода — уже случалось с другими конфигами.
            'packages/db/*.config.ts',
            'scripts/*.mjs',
          ],
          // Предел файлов, которые parserService разбирает вне tsconfig.
          // По умолчанию он равен 8, и добавление обычного служебного скрипта
          // упирается в него с ошибкой
          // «Too many files (>8) have matched the default project» — то есть
          // `npm run lint` падает не из-за кода, а из-за роста числа скриптов.
          // Значение с запасом: файлов сейчас 9, лимит 16.
          //
          // Почему не отдельный tsconfig для `scripts/`: файлы там — простые
          // `.mjs` без типов, и включение их в проект потребовало бы `allowJs`,
          // после чего линт начал бы проверять их как типизированный код и
          // потребовал бы аннотаций там, где они бессмысленны. Проверка этих
          // файлов всё равно идёт без типов (`disableTypeChecked` ниже).
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Типизация — основная защита от ошибок, ослаблять её нельзя.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/require-await': 'warn',

      // Логи только структурированные (docs/10-nfr-security.md §7).
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Безопасность: не сравниваем с NaN, не используем eval.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Конфигурационные файлы и служебные скрипты: правила, требующие информации
  // о типах, неприменимы (файлы не входят в tsconfig проекта), а глобалии Node
  // нужно объявить явно — иначе `no-undef` ругается на `console` и `process`.
  {
    files: [
      '*.config.ts',
      '*.config.mjs',
      '*.config.js',
      'apps/web/*.config.mjs',
      'packages/shared/*.config.ts',
      'scripts/*.mjs',
    ],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // CLI-инструменты и seed пишут в stdout — это их интерфейс, а не логирование
  // приложения. Правило `no-console` защищает рантайм от неструктурированных
  // логов, и на консольные утилиты оно не распространяется.
  {
    // `apply-price-list.ts` — такой же CLI-инструмент, как `seed.ts`: он
    // сообщает о ходе загрузки прейскуранта в stdout, и это его результат.
    files: ['scripts/**/*.mjs', 'packages/db/prisma/seed.ts', 'packages/db/prisma/apply-price-list.ts'],
    rules: {
      'no-console': 'off',
      // Явный тип возврата обязателен в коде приложения; в утилитах, где
      // функции короткие и локальные, он не даёт ничего, кроме шума.
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // `next.config.ts`: хуки `rewrites` и `headers` объявлены `async` вынужденно —
  // тип `NextConfig` требует от них `Promise`, хотя `await` внутри нет.
  // Убрать `async` нельзя: сборка падает с ошибкой типизации. Правило
  // отключается только для этого файла, чтобы не ослаблять проверку в коде.
  {
    files: ['apps/web/next.config.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
);