'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api-client';
import { StatCard } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DASHBOARD_COUNTERS, counterListHref, type OrderSummaryCounts } from '@app/shared';
import { t, DASHBOARD_COUNTER_LABELS } from '@/lib/i18n';

/** Сводка заказов — ответ `GET /orders/summary`. */
type OrderSummary = OrderSummaryCounts;

/**
 * Дашборд.
 *
 * Счётчики приходят готовыми из `/orders/summary`: считать их на клиенте по
 * загруженной странице списка нельзя — она ограничена областью видимости роли
 * и размером страницы, и «просрочено: 1» вместо фактических 40 ввело бы
 * руководителя в заблуждение.
 */
export default function DashboardPage(): ReactNode {
  const { user, can } = useAuth();

  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => api.get<OrderSummary>('/orders/summary'),
    enabled: can('order:read'),
  });

  const data = summary.data;
  const isLoading = summary.isLoading;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t.dashboard.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {t.dashboard.greeting}, {user?.fullName ?? ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void summary.refetch()}
            disabled={isLoading}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t.common.retry}
          </Button>
          {can('order:create') ? (
            <Link href="/orders/new">
              <Button>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t.nav.newOrder}
              </Button>
            </Link>
          ) : null}
        </div>
      </header>

      {summary.isError ? (
        <div className="card text-sm text-red-700">
          {t.errors.server}
          <Button
            variant="secondary"
            size="sm"
            className="ml-3"
            onClick={() => void summary.refetch()}
          >
            {t.common.retry}
          </Button>
        </div>
      ) : null}

      {can('order:read') ? (
        <section aria-labelledby="dashboard-overview">
          <h2 id="dashboard-overview" className="mb-3 text-sm font-semibold text-slate-500">
            {t.dashboard.overview}
          </h2>
          {/*
            Плитки строятся из общего описания `DASHBOARD_COUNTERS`: оно же
            задаёт фильтр ссылки. Раньше подписи и фильтры были выписаны здесь
            руками рядом с числами сервера, и «просрочено» разошлось: карточка
            исключала закрытые заказы, а список по ссылке — нет. Теперь число и
            адрес берутся из одной записи, и разойтись не могут.

            Ноль не делает плитку неактивной: пустой список с фильтром —
            понятный ответ «таких заказов нет», а серая плитка выглядит как
            сломанная кнопка и не объясняет, почему она ничего не делает.
          */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {DASHBOARD_COUNTERS.map((counter) => {
              const value = data?.[counter.key] ?? 0;
              return (
                <StatCard
                  key={counter.key}
                  label={DASHBOARD_COUNTER_LABELS[counter.key].label}
                  value={isLoading ? '…' : value}
                  // Красный только при ненулевой просрочке: постоянный красный
                  // перестают замечать.
                  tone={
                    counter.key === 'overdue' && value === 0
                      ? 'default'
                      : DASHBOARD_COUNTER_LABELS[counter.key].tone
                  }
                  href={counterListHref(counter.filter)}
                  hint={isLoading ? undefined : t.dashboard.showOrders}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="dashboard-quick">
        <h2 id="dashboard-quick" className="mb-3 text-sm font-semibold text-slate-500">
          {t.dashboard.quickActions}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {can('order:read') ? (
            <Link href="/orders" className="card transition-shadow hover:shadow-md">
              <p className="font-medium text-slate-900">{t.orders.title}</p>
              <p className="mt-1 text-sm text-slate-500">Список, фильтры и поиск</p>
            </Link>
          ) : null}
          {can('order:create') ? (
            <Link href="/orders/new" className="card transition-shadow hover:shadow-md">
              <p className="font-medium text-slate-900">{t.nav.newOrder}</p>
              <p className="mt-1 text-sm text-slate-500">Мастер приёма изделия</p>
            </Link>
          ) : null}
          {can('order:read') ? (
            <Link href="/orders?overdue=true" className="card transition-shadow hover:shadow-md">
              <p className="font-medium text-slate-900">{t.dashboard.overdue}</p>
              <p className="mt-1 text-sm text-slate-500">Требуют немедленного внимания</p>
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}
