import type { Config } from 'tailwindcss';

/**
 * Дизайн-система (docs/08-ui-ux.md §6).
 * Цвета статусов задаются токенами, чтобы бейдж в списке и в карточке
 * заказа выглядели одинаково.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Палитра статусов — соответствует STATUS_COLORS из @app/shared
        status: {
          draft: '#6b7280', // серый
          awaiting: '#f59e0b', // янтарный
          accepted: '#3b82f6', // синий
          transit: '#8b5cf6', // фиолетовый
          production: '#06b6d4', // голубой
          ready: '#22c55e', // зелёный
          unclaimed: '#f97316', // оранжевый
          completed: '#10b981', // тёмно-зелёный
          closed: '#ef4444', // красный
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      // Базовая типографика 16 px — читаемость на планшетах (docs/08-ui-ux.md §6)
      fontSize: {
        base: ['16px', { lineHeight: '24px' }],
      },
    },
  },
  plugins: [],
};

export default config;
