'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/api-client';

/**
 * Провайдер кэша запросов.
 *
 * `QueryClient` создаётся в состоянии компонента, а не на уровне модуля:
 * при серверном рендеринге модуль общий для всех запросов, и один кэш
 * на всех пользователей означал бы утечку чужих данных между сессиями.
 */
export function QueryProvider({ children }: { children: ReactNode }): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Данные заказов меняются часто, но мгновенная повторная выборка
            // при переходах между экранами раздражает: 30 секунд — разумный
            // компромисс.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // 4xx повторять бессмысленно: ответ не изменится. 404 и 403
              // не должны превращаться в три запроса и трёхсекундное ожидание.
              if (error instanceof ApiRequestError && error.statusCode < 500) {
                return false;
              }
              return failureCount < 2;
            },
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
