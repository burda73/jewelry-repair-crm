import { defineConfig } from 'vitest/config';

/**
 * Тесты пакета БД.
 *
 * Здесь проверяется соответствие данных кода утверждённому прейскуранту
 * заказчика (`price-list-spec.spec.ts`). Тесты не требуют подключения к
 * базе: они сравнивают описание прейскуранта в коде с базисом, извлечённым
 * из документа, поэтому их можно запускать где угодно, включая CI без БД.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['prisma/**/*.spec.ts'],
  },
});
