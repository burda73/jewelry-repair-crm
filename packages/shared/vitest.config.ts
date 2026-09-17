import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts'],
      thresholds: {
        // Доменное ядро обязано быть покрыто: docs/10-nfr-security.md §7
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
