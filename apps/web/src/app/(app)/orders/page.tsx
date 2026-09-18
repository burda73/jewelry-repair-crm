'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bookmark, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { ALL_ORDER_STATUSES, STATUS_LABELS, type OrderStatus } from '@app/shared';
import { useAuth } from '@/lib/auth-context';
import { useOrders } from '@/lib/queries';
import {
  filtersEqual,
  filtersToQuery,
  hasAnyCondition,
  queryToFilters,
  useSavedViews,
  MAX_VIEW_NAME_LENGTH,
  type SavedView,
} from '@/lib/saved-views';
import { formatDate, formatMinor, formatPhoneValue, daysUntil, plural } from '@/lib/format';
import type { OrderFilters, OrderListItem } from '@/lib/api-types';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
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
        {formatDate(order.dueAt)} · {t.order.daysLeft} {days} {plural(days, 'день', 'дня', 'дней')}
      </span>
    );
  }

  return <span className="text-slate-600">{formatDate(order.dueAt)}</span>;
}

export default function OrdersPage(): ReactNode {
  const { can, user } = useAuth();
  const toast = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  /*
   * Начальный срез читается из адреса: ссылку на подборку заказов передают
   * коллеге, а с дашборда приходит `?overdue=true`. Разбор идёт через ту же
   * нормализацию, что и сохранённые представления, — адрес правит пользователь,
   * и лишний параметр не должен уходить в запрос к API.
   */
  const initialSlice = useMemo(() => queryToFilters(searchParams), [searchParams]);
  const [filters, setFilters] = useState<OrderFilters>(initialSlice.filters);
  const [search, setSearch] = useState(initialSlice.search);
  const [showFilters, setShowFilters] = useState(false);
  const [showViews, setShowViews] = useState(false);
  const [viewName, setViewName] = useState('');
  const savedViews = useSavedViews(user?.id ?? null);
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

  /*
   * Срез отражается в адресе страницы.
   *
   * Без этого ссылку на подборку нельзя передать коллеге, и сохранённые
   * представления остаются личными. `replace`, а не `push`: смена фильтра —
   * не переход на другую страницу, иначе кнопка «назад» возвращала бы по
   * одному фильтру за раз. Параметры сбрасываются в `pathname`, чтобы в
   * адресе не осталось лишнего от предыдущего среза.
   */
  useEffect(() => {
    const query = filtersToQuery(filters, search);
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  }, [filters, search, pathname, router]);

  /** Применить сохранённое представление. */
  function applyView(view: SavedView): void {
    setFilters(view.filters);
    setSearch(view.search);
    setPages([]);
    setCursor(null);
    setShowViews(false);
  }

  /** Сохранить текущий срез под именем. */
  function saveCurrentView(): void {
    const created = savedViews.save(viewName, filters, search);
    if (created !== null) {
      setViewName('');
      setShowViews(false);
      toast.showSuccess(`Представление «${created.name}» сохранено`);
    }
  }

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
          {/*
            Сохранённые представления: срезы, к которым возвращаются каждый
            день («просроченные», «в работе»). Панель показывает и список
            сохранённых, и сохранение текущего среза.
          */}
          <Button
            variant="secondary"
            onClick={() => setShowViews((value) => !value)}
            aria-expanded={showViews}
          >
            <Bookmark className="h-4 w-4" aria-hidden="true" />
            Представления
            {savedViews.views.length > 0 ? (
              <span className="ml-1 rounded-full bg-slate-200 px-1.5 text-xs text-slate-700">
                {savedViews.views.length}
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
              <span className="mb-1 block text-sm font-medium text-slate-700">
                {t.orders.status}
              </span>
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

      {showViews ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Сохранённые представления</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Срез можно передать коллеге ссылкой — фильтры сохраняются в адресе страницы.
          </p>

          {savedViews.views.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              Пока ничего не сохранено. Выставьте фильтры и сохраните срез под именем.
            </p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-2">
              {savedViews.views.map((view) => {
                // Отмечаем представление, совпадающее с текущим срезом: иначе
                // непонятно, какой из сохранённых срезов сейчас на экране.
                const isActive = filtersEqual(view.filters, filters, view.search, search);
                return (
                  <li key={view.id} className="flex items-center">
                    <button
                      type="button"
                      onClick={() => applyView(view)}
                      className={cn(
                        'rounded-l-lg border px-3 py-1.5 text-sm transition-colors',
                        isActive
                          ? 'border-blue-500 bg-blue-50 font-medium text-blue-700'
                          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
                      )}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      {view.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => savedViews.remove(view.id)}
                      aria-label={`Удалить представление «${view.name}»`}
                      className="rounded-r-lg border border-l-0 border-slate-300 bg-white px-2 py-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/*
            Сохранение текущего среза. Пустой срез сохранить нельзя — это и
            есть исходный экран, а место в списке он бы занимал.
          */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              maxLength={MAX_VIEW_NAME_LENGTH}
              placeholder="Название представления"
              aria-label="Название представления"
              disabled={!hasAnyCondition(filters, search)}
              className="h-11 w-full max-w-xs rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-400"
            />
            <Button
              size="sm"
              disabled={viewName.trim() === '' || !hasAnyCondition(filters, search)}
              onClick={saveCurrentView}
            >
              Сохранить текущий срез
            </Button>
            {!hasAnyCondition(filters, search) ? (
              <span className="text-sm text-slate-500">
                Сначала выставьте хотя бы один фильтр или задайте поиск
              </span>
            ) : null}
          </div>
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
