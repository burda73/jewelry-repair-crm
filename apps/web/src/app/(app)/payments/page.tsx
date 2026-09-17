'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useSearch } from '@/lib/queries';
import { formatDate, formatMinor } from '@/lib/format';
import { StatusBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/card';
import { t } from '@/lib/i18n';
import { normalizeScanInput } from '@app/shared';

/**
 * Приём оплаты: поиск заказа по номеру, телефону, ФИО или сканированию QR.
 *
 * Ввод проходит через `normalizeScanInput`: сканер «печатает» содержимое
 * QR-кода (`repair://order/…`) и завершает ввод переводом строки. Без
 * нормализации поиск получал бы URI целиком и не находил ни одного заказа —
 * то есть основной сценарий оплаты по отсканированному номеру не работал бы
 * (ТЗ п. 2.5, дефект найден при проверке).
 */
export default function PaymentsPage(): ReactNode {
  const { can } = useAuth();
  const [term, setTerm] = useState('');

  const { data, isFetching } = useSearch(term);

  if (!can('payment:create') && !can('payment:read')) {
    return <EmptyState title={t.errors.forbidden} hint="Приём оплаты недоступен вашей роли" />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">{t.nav.payments}</h1>

      <div>
        <label htmlFor="payment-search" className="mb-1 block text-sm font-medium text-slate-700">
          Номер заказа, телефон или отсканированный QR
        </label>
        <input
          id="payment-search"
          type="search"
          value={term}
          onChange={(event) => setTerm(normalizeScanInput(event.target.value))}
          placeholder="MSK1-2509-000001 или repair://order/…"
          autoComplete="off"
          autoFocus
          className="h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <p className="mt-1 text-xs text-slate-500">
          Минимум 3 символа. Сканер вводит номер автоматически — ввод завершается переводом строки.
        </p>
      </div>

      {term.trim().length >= 3 ? (
        isFetching ? (
          <p className="py-8 text-center text-sm text-slate-500">{t.common.loading}</p>
        ) : data === undefined || data.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <EmptyState title={t.orders.empty} hint="Проверьте номер или телефон" />
          </div>
        ) : (
          <ul className="space-y-2">
            {data.map((result) => (
              <li key={result.id} className="card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/orders/${result.id}`}
                      className="font-mono font-semibold text-blue-700 hover:underline"
                    >
                      {result.orderNo}
                    </Link>
                    <p className="mt-1 text-sm text-slate-900">{result.customer.fullName}</p>
                    <p className="text-xs text-slate-500">
                      {result.createdStore.name} · срок {formatDate(result.dueAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <StatusBadge status={result.status} label={result.statusLabel} />
                    <p className="mt-1 text-sm font-medium tabular-nums text-slate-900">
                      {formatMinor(result.totalAmountMinor)}
                    </p>
                    {result.totalAmountMinor - result.paidAmountMinor > 0 ? (
                      <p className="text-xs text-amber-600">
                        к оплате {formatMinor(result.totalAmountMinor - result.paidAmountMinor)}
                      </p>
                    ) : null}
                  </div>
                </div>
                {result.outsideScope ? (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    Заказ другого магазина — оплата возможна, доступ к деталям ограничен
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
