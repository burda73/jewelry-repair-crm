import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // standalone нужен для продакшн-образа: Dockerfile.web копирует
  // .next/standalone и запускает server.js с минимальным набором зависимостей.
  // Без этого режима каталог standalone не создаётся и образ не собирается.
  output: 'standalone',

  // Проверка типов и линт выполняются в CI отдельно — не замедляем сборку.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  // @app/shared — TypeScript-пакет монорепо: транспилируем его вместе с приложением.
  transpilePackages: ['@app/shared'],

  // Прокси к API: фронтенд обращается к /api/v1 на своём origin,
  // поэтому cookie с SameSite=Lax работают без CORS-сложностей.
  // `async` обязателен: NextConfig требует, чтобы эти хуки возвращали
  // Promise. Убирать его нельзя, даже если внутри нет `await`.
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${process.env.API_URL ?? 'http://localhost:4000'}/api/v1/:path*`,
      },
    ];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Базовая защита; полноценный CSP настраивается на прокси.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;