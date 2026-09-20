'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Package, Plus, RefreshCw, Truck } from 'lucide-react';
import { BATCH_DIRECTION, BATCH_STATUS } from '@app/shared';
import { useAuth } from '@/lib/auth-context';
import { useBatches, useStores } from '@/lib/queries';
import {
  BATCH_DIRECTION_LABELS,
  BATCH_STATUS_LABELS,
  batchFiltersToQuery,
  batchRoute,
  batchStatusTone,
} from '@/lib/batches';
import { formatDate, plural } from '@/lib/format';
import type { Batch } from '@/lib/api-types';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Card, CardBody, EmptyState } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Список партий (задача 7.6, дефект 58).
 *
 * ЗАЧЕМ ЭТОТ ЭКРАН. До него раздела партий в приложении не было вовсе: партии
 * создавались только через API. Согласованная схема работы — «магазин →
 * производство → магазин» — на практике не выполнялась: приёмщик не мог
 * отправить изделия в цех, а менеджер не мог вернуть их в магазин. Экран
 * курьера (`/deliveries`) показывает только уже назначенные рейсы и создать
 * партию не позволяет.
 *
 * Фильтры держатся в состоянии компонента, а не в адресе: ссылку на подборку
 * партий коллеге не передают (в отличие от списка заказов), а лишний параметр в
 * адресе после перезагрузки показывал бы неполный список без объяснения.
 */
export default function BatchesPage(): ReactNode {
  const { can } = useAuth();
  const allowed = can('logistics:read');

  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [fromStoreId, setFromStoreId] = useState('');
  const [plannedOn, setPlannedOn] = useState('');

  const filters = useMemo(
    () => batchFiltersToQuery({ direction, status, fromStoreId, plannedOn }),
    [direction, status, fromStoreId, plannedOn],
  );

  const query = useBatches(filters, allowed);
  const stores = useStores();

  if (!allowed) {
    return (
      <EmptyState
        title="Раздел недоступен"
        hint="Для работы с партиями нужны права на логистику."
      />
    );
  }

  const batches = query.data?.items ?? [];
  const hasFilters = direction !== '' || status !== '' || fromStoreId !== '' || plannedOn !== '';

  function resetFilters(): void {
    setDirection('');
    setStatus('');
    setFromStoreId('');
    setPlannedOn('');
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t.batches.title}</h1>
          <p className="mt-1 text-sm text-slate-500">{t.batches.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label={t.batches.refresh}
          >
            <RefreshCw className={cn('size-4', query.isFetching && 'animate-spin')} />
          </Button>
          {/*
           * Создание — по праву `logistics:manage`, а не по праву чтения:
           * приёмщик без второй роли логиста раздел видит (если у него есть
           * чтение), но кнопку не получает, и это правильно.
           */}
          {can('logistics:manage') ? (
            /*
             * Ссылка стилизована как кнопка: `Button` рендерит `<button>`, а
             * вложенная кнопка внутри ссылки — невалидная разметка и потеря
             * клавиатурной навигации. Классы взяты те же, высота ≥ 44 px.
             */
            <Link
              href="/batches/new"
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-base font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              <Plus className="size-4" />
              {t.batches.create}
            </Link>
          ) : null}
        </div>
      </header>

      {/* Фильтры: свёрнуты в строку, чтобы список оставался главным. */}
      <Card>
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t.batches.filterDirection} htmlFor="filter-direction">
            <Select
              id="filter-direction"
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
            >
              <option value="">{t.batches.filterAll}</option>
              <option value={BATCH_DIRECTION.TO_PRODUCTION}>
                {t.batches.directionToProduction}
              </option>
              <option value={BATCH_DIRECTION.TO_STORE}>{t.batches.directionToStore}</option>
            </Select>
          </Field>

          <Field label={t.batches.filterStatus} htmlFor="filter-status">
            <Select
              id="filter-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">{t.batches.filterAll}</option>
              {Object.values(BATCH_STATUS).map((value) => (
                <option key={value} value={value}>
                  {BATCH_STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t.batches.filterStore} htmlFor="filter-store">
            <Select
              id="filter-store"
              value={fromStoreId}
              onChange={(event) => setFromStoreId(event.target.value)}
            >
              <option value="">{t.batches.filterAll}</option>
              {(stores.data ?? []).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t.batches.filterDate} htmlFor="filter-date">
            <Input
              id="filter-date"
              type="date"
              value={plannedOn}
              onChange={(event) => setPlannedOn(event.target.value)}
            />
          </Field>

          {hasFilters ? (
            <div className="sm:col-span-2 lg:col-span-4">
              <Button variant="secondary" onClick={resetFilters}>
                {t.batches.resetFilters}
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {query.isLoading ? (
        <Card>
          <CardBody className="text-center text-sm text-slate-500">{t.batches.loading}</CardBody>
        </Card>
      ) : batches.length === 0 ? (
        <Card>
          <EmptyState title={t.batches.empty} hint={t.batches.emptyHint} />
        </Card>
      ) : (
        <BatchesTable batches={batches} />
      )}
    </div>
  );
}

/**
 * Таблица партий.
 *
 * Обёрнута в `overflow-x-auto`: без этого широкий список задал бы минимальную
 * ширину всему документу, и на планшете (360 px) горизонтально поехала бы вся
 * страница вместе с шапкой и кнопками. Инвариант проверяется тестом
 * `apps/web/src/lib/mobile-layout.spec.ts`.
 */
function BatchesTable({ batches }: { batches: Batch[] }): ReactNode {
  return (
    <>
      {/*
       * Мобильная раскладка — карточками. Таблица из шести колонок на 360 px
       * нечитаема, а горизонтальная прокрутка чужого контента на телефоне
       * неудобна: колонки уезжают вместе с заголовками. Так же устроен список
       * заказов (`hidden md:block` + карточки).
       */}
      <div className="space-y-3 md:hidden">
        {batches.map((batch) => (
          <BatchMobileCard key={batch.id} batch={batch} />
        ))}
      </div>

      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">{t.batches.columnNo}</th>
              <th className="px-4 py-3 font-medium">{t.batches.columnRoute}</th>
              <th className="px-4 py-3 font-medium">{t.batches.columnStatus}</th>
              <th className="px-4 py-3 font-medium">{t.batches.columnItems}</th>
              <th className="px-4 py-3 font-medium">{t.batches.columnPlanned}</th>
              <th className="px-4 py-3 font-medium">{t.batches.columnActions}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {batches.map((batch) => (
              <tr key={batch.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/batches/${batch.id}`}
                    className="font-medium text-blue-600 underline-offset-2 hover:underline"
                  >
                    {batch.batchNo}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {BATCH_DIRECTION_LABELS[batch.direction as 'TO_PRODUCTION' | 'TO_STORE'] ??
                      batch.direction}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <span className="flex items-start gap-1.5">
                    <Truck className="mt-0.5 size-3.5 shrink-0 text-slate-400" />
                    <span className="text-slate-700">{batchRoute(batch)}</span>
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={batchStatusTone(batch.status)}>
                    {BATCH_STATUS_LABELS[batch.status as keyof typeof BATCH_STATUS_LABELS] ??
                      batch.status}
                  </Badge>
                  <TransitNote batch={batch} />
                </td>
                <td className="px-4 py-3 text-slate-700">
                  <span className="flex items-center gap-1">
                    <Package className="size-3.5 text-slate-400" />
                    {batch.itemsCount} {plural(batch.itemsCount, 'изделие', 'изделия', 'изделий')}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-700">{formatDate(batch.plannedAt)}</td>
                <td className="px-4 py-3">
                  <Link
                    href={`/batches/${batch.id}`}
                    className="text-blue-600 underline-offset-2 hover:underline"
                  >
                    {t.batches.open}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/**
 * Состояние «в пути» одной строкой.
 *
 * Приходит готовым с сервера (задача 2.6): расчёт учитывает производственный
 * календарь и настройку норматива, и повторять его на клиенте значило бы
 * получить два разных ответа на один вопрос.
 */
function TransitNote({ batch }: { batch: Batch }): ReactNode {
  if (batch.transit.elapsedHours === null) return null;
  return (
    <p
      className={cn(
        'mt-1 text-xs',
        batch.transit.isOverdue ? 'font-medium text-red-600' : 'text-slate-500',
      )}
    >
      {batch.transit.message}
    </p>
  );
}

/**
 * Карточка партии для мобильного экрана.
 *
 * Показывает то же, что строка таблицы, но вертикально: приёмщик работает с
 * телефона у стеллажа, и ему нужно прочитать маршрут и статус без
 * горизонтальной прокрутки.
 */
function BatchMobileCard({ batch }: { batch: Batch }): ReactNode {
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <Link
              href={`/batches/${batch.id}`}
              className="text-base font-semibold text-blue-600 underline-offset-2 hover:underline"
            >
              {batch.batchNo}
            </Link>
            <p className="text-xs text-slate-500">
              {BATCH_DIRECTION_LABELS[batch.direction as 'TO_PRODUCTION' | 'TO_STORE'] ??
                batch.direction}
            </p>
          </div>
          <Badge tone={batchStatusTone(batch.status)}>
            {BATCH_STATUS_LABELS[batch.status as keyof typeof BATCH_STATUS_LABELS] ?? batch.status}
          </Badge>
        </div>

        <p className="flex items-start gap-1.5 text-sm text-slate-700">
          <Truck className="mt-0.5 size-3.5 shrink-0 text-slate-400" />
          {batchRoute(batch)}
        </p>

        <p className="flex items-center gap-1 text-sm text-slate-600">
          <Package className="size-3.5 text-slate-400" />
          {batch.itemsCount} {plural(batch.itemsCount, 'изделие', 'изделия', 'изделий')} ·{' '}
          {formatDate(batch.plannedAt)}
        </p>

        <TransitNote batch={batch} />
      </CardBody>
    </Card>
  );
}
