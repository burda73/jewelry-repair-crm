'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Package, RefreshCw, ScanLine, Truck } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useMyDeliveries, useBatch, batchKeys, findBatchByScan } from '@/lib/queries';
import { formatDate, formatDateTime, plural } from '@/lib/format';
import { describeApiError } from '@/lib/api-client';
import type { Batch } from '@/lib/api-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardBody, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Экран курьера (задача 2.7, ТЗ п. 2.6).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН. Курьер работает с телефона, у машины, одной рукой.
 * Общий список партий для этого не годится: он показывает все рейсы сети, и
 * чтобы найти свой, нужно листать и фильтровать. Здесь — только назначенное на
 * этого курьера, крупными строками, с маршрутом и состоянием «в пути».
 *
 * Сканирование сделано ДВУМЯ путями: поле ввода (USB-сканер «печатает» код и
 * завершает переводом строки, а если камера недоступна — номер набирают руками)
 * и разбор на сервере. Разбор идёт на сервере, потому что правила уже описаны и
 * покрыты тестами; вторая реализация на клиенте разошлась бы с ними при первой
 * же правке.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ КАМЕРЫ. Интерфейс камеры (`BarcodeDetector`) есть не во всех
 * браузерах, а на iOS — только в Safari. Обещать сканирование камерой и не
 * выполнить его хуже, чем дать поле, которое работает всегда. Поле принимает и
 * ввод USB-сканера, и набранный номер.
 */
export default function DeliveriesPage(): ReactNode {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();

  // Показывать экран имеет смысл тому, кто везёт рейсы, либо тому, кто их
  // распределяет. Проверка по правам, а не по роли: отдельной роли «курьер» нет,
  // доставку ведёт `LOGISTICIAN` — «Логист / курьер» (docs/02 §4).
  const allowed = can('logistics:read');

  const deliveries = useMyDeliveries(allowed);

  const [scan, setScan] = useState('');
  const [scanning, setScanning] = useState(false);
  const [foundId, setFoundId] = useState<string | null>(null);

  const found = useBatch(foundId ?? '');

  async function handleScan(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const code = scan.trim();
    if (code === '') return;

    setScanning(true);
    setFoundId(null);
    try {
      const batch = await findBatchByScan(code);
      /*
       * Результат кладётся в кеш карточки, а не в отдельное состояние: дальше
       * используется тот же `useBatch`, и второй запрос не нужен.
       */
      queryClient.setQueryData(batchKeys.detail(batch.id), batch);
      setFoundId(batch.id);
    } catch (error: unknown) {
      /*
       * «Не найдено» — обычный исход сканирования (наклейка стёрлась, код не
       * отсканировался), и показывать его как ошибку системы нельзя: курьер
       * должен понять, что нужно отсканировать ещё раз.
       */
      toast.showError(describeApiError(error));
    } finally {
      setScanning(false);
    }
  }

  if (!allowed) {
    return (
      <EmptyState
        title="Раздел недоступен"
        hint="Для работы с доставками нужны права на логистику."
      />
    );
  }

  const batches = deliveries.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t.deliveries.title}</h1>
          <p className="mt-1 text-sm text-slate-500">{t.deliveries.subtitle}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void deliveries.refetch()}
          disabled={deliveries.isFetching}
          aria-label={t.deliveries.refresh}
        >
          <RefreshCw className={cn('size-4', deliveries.isFetching && 'animate-spin')} />
        </Button>
      </header>

      {/* Сканирование: крупное поле — основной инструмент курьера. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanLine className="size-4 text-slate-500" />
            {t.deliveries.scanTitle}
          </CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-slate-500">{t.deliveries.scanHint}</p>
          <form onSubmit={(event) => void handleScan(event)} className="flex gap-2">
            <Input
              value={scan}
              onChange={(event) => setScan(event.target.value)}
              placeholder={t.deliveries.scanPlaceholder}
              // `inputMode` и `autoComplete` — для телефона: клавиатура не должна
              // закрывать половину экрана, а подсказки браузера здесь бесполезны.
              inputMode="text"
              autoComplete="off"
              aria-label={t.deliveries.scanTitle}
            />
            <Button type="submit" loading={scanning} disabled={scan.trim() === ''}>
              {t.deliveries.scanAction}
            </Button>
          </form>

          {foundId !== null && found.data !== undefined ? (
            <BatchCard batch={found.data} highlight />
          ) : null}
        </CardBody>
      </Card>

      {deliveries.isLoading ? (
        <Card>
          <CardBody className="text-center text-sm text-slate-500">Загрузка…</CardBody>
        </Card>
      ) : batches.length === 0 ? (
        <Card>
          <EmptyState title={t.deliveries.empty} hint={t.deliveries.emptyHint} />
        </Card>
      ) : (
        <div className="space-y-3">
          {batches.map((batch) => (
            <BatchCard key={batch.id} batch={batch} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Карточка рейса.
 *
 * @param highlight результат сканирования: подсвечивается, чтобы курьер видел,
 *                  что нашлась именно эта накладная, а не соседняя строка
 */
function BatchCard({
  batch,
  highlight = false,
}: {
  batch: Batch;
  /** Подсветка результата поиска. */
  highlight?: boolean;
}): ReactNode {
  const isInTransit = batch.status === 'IN_TRANSIT';
  const overdue = batch.transit.isOverdue;

  return (
    <Card
      className={cn(
        highlight && 'ring-2 ring-blue-500',
        // Просроченный рейс выделяется рамкой, а не только текстом: курьер
        // смотрит на список, а не читает каждую строку.
        overdue && 'border-red-300',
      )}
    >
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-lg font-semibold text-slate-900">{batch.batchNo}</p>
            <p className="mt-0.5 flex items-center gap-1 text-sm text-slate-500">
              <Package className="size-3.5" />
              {batch.itemsCount} {plural(batch.itemsCount, 'изделие', 'изделия', 'изделий')}
            </p>
          </div>
          <Badge tone={isInTransit ? (overdue ? 'red' : 'blue') : 'slate'}>
            {isInTransit ? t.deliveries.inTransit : t.deliveries.awaitingDispatch}
          </Badge>
        </div>

        {/* Маршрут: главное, что нужно курьеру. */}
        <div className="flex items-start gap-2 text-sm">
          <Truck className="mt-0.5 size-4 shrink-0 text-slate-400" />
          <div className="min-w-0">
            <p className="text-slate-900">
              {batch.fromStoreName ?? '—'}
              <span className="mx-1 text-slate-400">→</span>
              {batch.toStoreName ?? batch.toWorkshopName ?? '—'}
            </p>
            <p className="mt-0.5 text-slate-500">
              {batch.dispatchedAt !== null
                ? `${t.deliveries.dispatchedAt}: ${formatDateTime(batch.dispatchedAt)}`
                : `${t.deliveries.plannedAt}: ${formatDate(batch.plannedAt)}`}
            </p>
          </div>
        </div>

        {/*
         * Состояние «в пути» приходит готовым с сервера (задача 2.6): расчёт
         * учитывает производственный календарь и настройку норматива, и
         * повторять его на клиенте значило бы получить два разных ответа на
         * один вопрос.
         */}
        {batch.transit.elapsedHours !== null ? (
          <p className={cn('text-sm', overdue ? 'font-medium text-red-600' : 'text-slate-600')}>
            {batch.transit.message}
          </p>
        ) : null}

        {highlight && batch.itemsCount > 0 ? (
          <p className="text-sm text-slate-500">
            <Link
              href={`/orders?batch=${batch.id}`}
              className="text-blue-600 underline-offset-2 hover:underline"
            >
              Посмотреть состав рейса
            </Link>
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
