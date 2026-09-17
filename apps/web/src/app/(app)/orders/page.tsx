'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Plus, SlidersHorizontal, X } from 'lucide-react';
import {
  ALL_ORDER_STATUSES,
  STATUS_LABELS,
  type OrderStatus,
} from '@app/shared';
import { useAuth } from '@/lib/auth-context';
import { useOrders } from '@/lib/queries';
import { formatDate, formatMinor, formatPhoneValue, daysUntil, plural } from '@/lib/format';
import type { OrderFilters, OrderListItem } from '@/lib/api-types';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/card';
import { t, PRIORITY_LABELS } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Строка срока: подсвечивает просрочку и близкий дедлайн. */
function DueCell({ order }: { order: OrderListItem }): ReactNode {
  const days = daysUntil(order.dueAt);

  if (days === null) {
    return <span className="text-slate-400">{t.order.noDueDate}</span>;
  }

  if (days < 0) {
    return (
      <span className="font-medium text-red-600">
        {formatDate(order.dueAt)} · {t.order.daysOverdue} {Math.abs(days)}{' '}
        {plural(Math.abs(days), 'день', 'дня', 'дней')}
      </span>
    );
  }

  if (days <= 2) {
    return (
      <span className="font-medium text-amber-600">
        {formatDate(order.dueAt)} · {t.order.daysLeft} {days}{' '}
        {plural(days, 'день', 'дня', 'дней')}
      </span>
    );
  }

  return <span className="text-slate-600">{formatDate(order.dueAt)}</span>;
}

export default function OrdersPage(): ReactNode {
  const { can } = useAuth();
  const searchParams = useSearchParams();

  // Фильтр «просроченные» может прийти ссылкой с дашборда.
  const [filters, setFilters] = useState<OrderFilters>(() => ({
    overdue: searchParams.get('overdue') === 'true' ? true : undefined,
  }));
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // Накопленные страницы: «показать ещё» добавляет результат к уже видимому.
  const [pages, setPages] = useState<OrderListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const query = useOrders(filters, search, cursor);
  const currentPage = useMemo(() => query.data?.items ?? [], [query.data]);

  // Список = уже накопленные страницы плюс текущая. Дубли исключаются по id:
  // при повторной выборке та же страница могла прийти дважды.
  const rows = useMemo(() => {
    if (cursor === null) return currentPage;
    const seen = new Set(pages.map((order) => order.id));
    return [...pages, ...currentPage.filter((order) => !seen.has(order.id))];
  }, [pages, currentPage, cursor]);

  function updateFilter(patch: Partial<OrderFilters>): void {
    setFilters((current) => ({ ...current, ...patch }));
    // Смена фильтров сбрасывает накопленные страницы: старые строки
    // не соответствуют новому условию и не должны оставаться в списке.
    setPages([]);
    setCursor(null);
  }

  const activeFilterCount =
    (filters.status?.length ?? 0) +
    (filters.overdue === true ? 1 : 0) +
    (filters.isWarranty === true ? 1 : 0) +
    (filters.priority !== undefined ? 1 : 0);

  if (!can('order:read')) {
    return (
      <EmptyState title={t.errors.forbidden} hint="У вашей роли нет доступа к списку заказов" />
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">{t.orders.title}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setShowFilters((value) => !value)}
            aria-expanded={showFilters}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            {t.orders.filters}
            {activeFilterCount > 0 ? (
              <span className="ml-1 rounded-full bg-blue-600 px-1.5 text-xs text-white">
                {activeFilterCount}
              </span>
            ) : null}
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

      {showFilters ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">{t.orders.status}</span>
              <Select
                value={filters.status?.[0] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  updateFilter({
                    status: value === '' ? undefined : [value as OrderStatus],
                  });
                }}
              >
                <option value="">{t.common.all}</option>
                {ALL_ORDER_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                {t.orders.priority}
              </span>
              <Select
                value={filters.priority ?? ''}
                onChange={(event) =>
                  updateFilter({
                    priority: event.target.value === '' ? undefined : event.target.value,
                  })
                }
              >
                <option value="">{t.common.all}</option>
                {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="flex min-h-[44px] items-center gap-2 self-end">
              <input
                type="checkbox"
                className="h-5 w-5 rounded border-slate-300"
                checked={filters.overdue === true}
                onChange={(event) =>
                  updateFilter({ overdue: event.target.checked ? true : undefined })
                }
              />
              <span className="text-sm text-slate-700">{t.orders.overdue}</span>
            </label>

            <label className="flex min-h-[44px] items-center gap-2 self-end">
              <input
                type="checkbox"
                className="h-5 w-5 rounded border-slate-300"
                checked={filters.isWarranty === true}
                onChange={(event) =>
                  updateFilter({ isWarranty: event.target.checked ? true : undefined })
                }
              />
              <span className="text-sm text-slate-700">{t.orders.warranty}</span>
            </label>
          </div>

          {activeFilterCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              onClick={() => {
                setFilters({});
                setPages([]);
                setCursor(null);
              }}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              {t.orders.resetFilters}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Поиск по номеру или телефону внутри списка — серверный, не по загруженным строкам. */}
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPages([]);
            setCursor(null);
          }}
          placeholder="Номер заказа или телефон"
          aria-label="Поиск по списку"
          className="h-11 w-full max-w-md rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {query.isLoading ? (
        <p className="py-12 text-center text-sm text-slate-500">{t.orders.loading}</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState title={t.orders.empty} hint={t.orders.emptyHint} />
        </div>
      ) : (
        <>
          {/* Десктопная таблица. На мобильном тот же список выводится карточками. */}
          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">{t.orders.orderNo}</th>
                  <th className="px-4 py-3 font-medium">{t.orders.customer}</th>
                  <th className="px-4 py-3 font-medium">{t.orders.status}</th>
                  <th className="px-4 py-3 text-right font-medium">{t.orders.amount}</th>
                  <th className="px-4 py-3 font-medium">{t.orders.due}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/orders/${order.id}`}
                        className="font-mono font-semibold text-blue-700 hover:underline"
                      >
                        {order.orderNo}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {order.isWarranty ? <Badge tone="violet">{t.orders.warranty}</Badge> : null}
                        {order.priority !== 'NORMAL' ? (
                          <Badge tone="amber">
                            {PRIORITY_LABELS[order.priority] ?? order.priority}
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-slate-900">{order.customer.fullName}</div>
                      <div className="text-xs text-slate-500">
                        {formatPhoneValue(order.customer.phoneNormalized)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={order.status} label={order.statusLabel} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <div className="font-medium text-slate-900">
                        {formatMinor(order.totalAmountMinor)}
                      </div>
                      {order.remainingMinor > 0 ? (
                        <div className="text-xs text-amber-600">
                          к оплате {formatMinor(order.remainingMinor)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <DueCell order={order} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Мобильные карточки */}
          <div className="space-y-2 md:hidden">
            {rows.map((order) => (
              <Link
                key={order.id}
                href={`/orders/${order.id}`}
                className={cn('block rounded-xl border border-slate-200 bg-white p-3 shadow-sm')}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-blue-700">
                    {order.orderNo}
                  </span>
                  <StatusBadge status={order.status} label={order.statusLabel} />
                </div>
                <div className="mt-2 text-sm text-slate-900">{order.customer.fullName}</div>
                <div className="text-xs text-slate-500">
                  {formatPhoneValue(order.customer.phoneNormalized)}
                </div>
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="font-medium tabular-nums text-slate-900">
                    {formatMinor(order.totalAmountMinor)}
                  </span>
                  <DueCell order={order} />
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {query.data?.hasMore === true ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onClick={() => {
              // Текущую страницу сохраняем перед запросом следующей.
              setPages(rows);
              setCursor(query.data?.nextCursor ?? null);
            }}
            loading={query.isFetching && cursor !== null}
          >
            {t.orders.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
