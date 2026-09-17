'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { useSearch } from '@/lib/queries';
import { formatDate, formatMinor, formatPhoneValue } from '@/lib/format';
import { StatusBadge } from '@/components/ui/badge';
import { t } from '@/lib/i18n';
import { normalizeScanInput } from '@app/shared';

/**
 * Единая строка поиска (ТЗ п. 2.1, docs/08-ui-ux.md §8).
 *
 * Тип запроса определяется автоматически: номер заказа, телефон или ФИО
 * распознаёт сервер (`/orders/search`), клиент лишь передаёт строку.
 *
 * Сканер QR «печатает» содержимое кода и завершает переводом строки. Разбор
 * ввода выполняет общая функция `normalizeScanInput` из `@app/shared`: раньше
 * она была продублирована здесь, и экран приёма оплаты остался без неё —
 * отсканированный QR не находил заказ (docs/08-ui-ux.md §4.1).
 */
export function GlobalSearch(): ReactNode {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const { data, isFetching } = useSearch(term);

  useEffect(() => {
    if (!open) return;

    function handleClick(event: MouseEvent): void {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden="true"
        />
        <input
          type="search"
          value={term}
          onChange={(event) => {
            setTerm(normalizeScanInput(event.target.value));
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              // Сканер завершает ввод Enter — открываем единственный результат
              // сразу, не заставляя приёмщика нажимать мышью.
              const first = data?.[0];
              if (first !== undefined) {
                setOpen(false);
                router.push(`/orders/${first.id}`);
              }
            }
            if (event.key === 'Escape') setOpen(false);
          }}
          placeholder={t.orders.searchPlaceholder}
          aria-label={t.nav.search}
          className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-8 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:w-72"
        />
        {term !== '' ? (
          <button
            type="button"
            onClick={() => {
              setTerm('');
              setOpen(false);
            }}
            className="absolute right-1.5 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
            aria-label="Очистить поиск"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {open && term.trim().length >= 3 ? (
        <div className="absolute right-0 z-40 mt-1 max-h-96 w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {isFetching ? (
            <p className="px-3 py-3 text-sm text-slate-500">{t.common.loading}</p>
          ) : data === undefined || data.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-500">{t.orders.empty}</p>
          ) : (
            data.map((result) => (
              <button
                key={result.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(`/orders/${result.id}`);
                }}
                className="block w-full border-b border-slate-50 px-3 py-2.5 text-left last:border-0 hover:bg-slate-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-slate-900">
                    {result.orderNo}
                  </span>
                  <StatusBadge status={result.status} label={result.statusLabel} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span className="truncate">
                    {result.customer.fullName} · {formatPhoneValue(result.customer.phoneNormalized)}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatMinor(result.totalAmountMinor)}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-slate-400">
                  <span>{result.createdStore.name}</span>
                  <span>срок: {formatDate(result.dueAt)}</span>
                </div>
                {result.outsideScope ? (
                  // Заказ виден для приёма оплаты в любой точке (ТЗ п. 2.5),
                  // но сотрудник должен понимать, что это чужой магазин.
                  <p className="mt-1 text-xs text-amber-600">Другой магазин</p>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
