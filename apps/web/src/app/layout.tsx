import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { QueryProvider } from '@/lib/query-provider';
import { AuthProvider } from '@/lib/auth-context';
import { ToastProvider } from '@/components/ui/toast';

/**
 * PWA-манифест и метаданные (docs/08-ui-ux.md §5).
 * Решение заказчика: отдельное мобильное приложение не делаем — используем PWA.
 */
export const metadata: Metadata = {
  title: 'CRM ремонта ювелирных изделий',
  description: 'Управление и контроль операций ремонта ювелирных изделий',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Ремонт',
  },
  formatDetection: { telephone: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Не блокируем масштабирование — требование доступности.
  maximumScale: 5,
  themeColor: '#1e40af',
};

/**
 * Порядок провайдеров важен: `AuthProvider` использует `QueryClient`
 * (для очистки кэша при выходе), поэтому обязан быть внутри `QueryProvider`.
 * `ToastProvider` нужен мутациям, которые объявлены в хуках данных.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): ReactNode {
  return (
    <html lang="ru">
      <body className="min-h-screen bg-slate-50">
        <QueryProvider>
          <ToastProvider>
            <AuthProvider>{children}</AuthProvider>
          </ToastProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
