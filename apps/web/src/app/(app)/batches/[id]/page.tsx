'use client';

import { useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Check, FileText, Printer, Send, Trash2, X } from 'lucide-react';
import { BATCH_DIRECTION, batchOrderTargetStatus, STATUS_LABELS } from '@app/shared';
import { useAuth } from '@/lib/auth-context';
import {
  useAddBatchOrders,
  useBatch,
  useBatchCandidates,
  useBatchPhaseAction,
  useFormBatchAct,
  useRemoveBatchOrder,
  useSignBatchAct,
} from '@/lib/queries';
import {
  BATCH_STATUS_LABELS,
  batchActions,
  batchActPdfPath,
  batchRoute,
  batchStatusTone,
  candidateViews,
  dispatchConsequences,
  hasWarnings,
  receiveConsequences,
} from '@/lib/batches';
import { describeApiError } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMinor, plural } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Card, CardBody, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Field, FormError } from '@/components/ui/field';
import { Dialog, DialogContent, DialogTrigger, DialogClose } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Карточка партии (задача 7.6, дефект 58).
 *
 * ЭТО ГЛАВНЫЙ ЭКРАН СХЕМЫ. Здесь выполняется весь путь партии: состав →
 * подбор заказов → акт → печать реестра → отправка → приём. До него эти шаги
 * существовали только в API, поэтому согласованная схема работы не выполнялась.
 *
 * ПОЧЕМУ ДЕЙСТВИЯ ПОКАЗЫВАЮТСЯ, А НЕ СКРЫВАЮТСЯ. Недоступные кнопки не
 * убираются, а остаются с причиной: сотрудник должен понимать, чего не хватает
 * (не сформирован акт? не его роль? партия уже уехала?), иначе он идёт
 * спрашивать. Причины берутся из домена (`batchActions`) — они уже
 * сформулированы по-русски и покрыты тестами.
 *
 * ПРЕДУПРЕЖДЕНИЕ О ЧУЖОМ МАГАЗИНЕ. Контроль «где приняли, там и выдаём» —
 * зона ответственности менеджера (решение заказчика), поэтому несовпадение
 * магазина показывается замечанием, но не блокирует добавление заказа.
 */
export default function BatchDetailPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const toast = useToast();
  const { can, user } = useAuth();
  const canManage = can('logistics:manage');

  const batch = useBatch(id);
  const actions = batch.data === undefined ? null : batchActions(batch.data.status);

  /*
   * Кандидаты запрашиваются только когда состав ещё можно менять: в подписанной
   * партии подбор бессмысленен, а лишний запрос на сервер — это работа с базой
   * без пользы.
   */
  const candidates = useBatchCandidates(id, actions?.canEditComposition === true);

  const formAct = useFormBatchAct();
  const phaseAction = useBatchPhaseAction();
  const signAct = useSignBatchAct();
  const removeOrder = useRemoveBatchOrder();

  if (batch.isLoading) {
    return (
      <Card>
        <CardBody className="text-center text-sm text-slate-500">{t.batches.loading}</CardBody>
      </Card>
    );
  }

  if (batch.data === undefined) {
    return (
      <EmptyState
        title="Партия не найдена"
        hint="Возможно, она была удалена или ссылка устарела."
      />
    );
  }

  const data = batch.data;
  const state = batchActions(data.status);
  const isToProduction = data.direction === BATCH_DIRECTION.TO_PRODUCTION;

  /*
   * Целевой статус заказов берётся из домена, а не пишется здесь: то же
   * правило применяет сервер при отправке, и отдельная копия на клиенте
   * разошлась бы с ним при первой правке статусной модели.
   */
  const dispatchTarget = batchOrderTargetStatus(
    data.direction as 'TO_PRODUCTION' | 'TO_STORE',
    'DISPATCH',
  );
  const receiveTarget = batchOrderTargetStatus(
    data.direction as 'TO_PRODUCTION' | 'TO_STORE',
    'RECEIVE',
  );

  async function runAct(): Promise<void> {
    try {
      await formAct.mutateAsync(id);
      toast.showSuccess('Акт сформирован');
    } catch (error: unknown) {
      toast.showError(describeApiError(error));
    }
  }

  async function runPhase(phase: 'dispatch' | 'receive'): Promise<void> {
    try {
      await phaseAction.mutateAsync({ id, phase });
      toast.showSuccess(phase === 'dispatch' ? 'Партия отправлена' : 'Партия принята');
    } catch (error: unknown) {
      toast.showError(describeApiError(error));
    }
  }

  async function runSign(side: 'FROM' | 'TO'): Promise<void> {
    try {
      await signAct.mutateAsync({ id, side });
      toast.showSuccess('Акт подписан');
    } catch (error: unknown) {
      toast.showError(describeApiError(error));
    }
  }

  async function runRemove(orderId: string, reason: string): Promise<void> {
    try {
      await removeOrder.mutateAsync({ id, orderId, reason });
      toast.showSuccess('Заказ исключён из партии');
    } catch (error: unknown) {
      toast.showError(describeApiError(error));
    }
  }

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <Link
          href="/batches"
          className="inline-flex min-h-[44px] items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="size-4" />
          {t.batches.title}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{data.batchNo}</h1>
            <p className="mt-1 text-sm text-slate-500">{batchRoute(data)}</p>
          </div>
          <Badge tone={batchStatusTone(data.status)}>
            {BATCH_STATUS_LABELS[data.status as keyof typeof BATCH_STATUS_LABELS] ?? data.status}
          </Badge>
        </div>
      </header>

      {/* Сводка по партии: что за рейс, когда и сколько. */}
      <Card>
        <CardBody className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Info label={t.batches.filterDirection}>
            {isToProduction ? t.batches.directionToProduction : t.batches.directionToStore}
          </Info>
          <Info label={t.batches.columnItems}>
            {data.itemsCount} {plural(data.itemsCount, 'изделие', 'изделия', 'изделий')}
          </Info>
          <Info label={t.batches.plannedAt}>{formatDate(data.plannedAt)}</Info>
          <Info label={t.batches.columnStatus}>
            {data.dispatchedAt !== null ? formatDateTime(data.dispatchedAt) : '—'}
          </Info>
          {data.transit.elapsedHours !== null ? (
            <p
              className={cn(
                'sm:col-span-2 lg:col-span-4',
                data.transit.isOverdue ? 'font-medium text-red-600' : 'text-slate-600',
              )}
            >
              {data.transit.message}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/*
       * Акт: формирование, подпись, печать. Печать — это и есть «реестр
       * отправляемых документов» из схемы заказчика; PDF открывается в новой
       * вкладке, откуда его печатают и подписывают на бумаге.
       */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-4 text-slate-500" />
            {t.batches.printAct}
          </CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {canManage && data.status === 'DRAFT' ? (
              <Button onClick={() => void runAct()} loading={formAct.isPending}>
                {t.batches.formAct}
              </Button>
            ) : null}

            {/*
             * Печать доступна, когда акт сформирован: печатать нечего, пока
             * состав не зафиксирован документом.
             */}
            {data.status !== 'DRAFT' ? (
              <a
                href={batchActPdfPath(data.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-base font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                <Printer className="size-4" />
                {t.batches.printAct}
              </a>
            ) : null}

            {canManage && data.status !== 'DRAFT' && data.status !== 'CANCELLED' ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => void runSign('FROM')}
                  loading={signAct.isPending}
                >
                  {t.batches.signFrom}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void runSign('TO')}
                  loading={signAct.isPending}
                >
                  {t.batches.signTo}
                </Button>
              </>
            ) : null}
          </div>

          {data.status === 'DRAFT' ? (
            <p className="text-sm text-slate-500">
              Состав можно менять до формирования акта. После формирования акт фиксирует перечень
              изделий, и добавление заказа сделало бы документ несоответствующим факту.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/*
       * Отправка и приём. Последствия показываются текстом: одно нажатие
       * переводит десятки заказов, и отменить это одним действием нельзя.
       */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="size-4 text-slate-500" />
            {t.batches.dispatch}
          </CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {canManage ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button disabled={!state.canDispatch}>{t.batches.dispatch}</Button>
                </DialogTrigger>
                <DialogContent
                  title={t.batches.dispatchConfirm}
                  description={
                    dispatchTarget !== null
                      ? dispatchConsequences(data, STATUS_LABELS[dispatchTarget])
                      : undefined
                  }
                >
                  <div className="flex justify-end gap-2">
                    <DialogClose asChild>
                      <Button variant="secondary">{t.batches.cancel}</Button>
                    </DialogClose>
                    <Button
                      loading={phaseAction.isPending}
                      onClick={() => void runPhase('dispatch')}
                    >
                      {t.batches.dispatch}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            ) : null}

            {canManage ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="secondary" disabled={!state.canReceive}>
                    {t.batches.receive}
                  </Button>
                </DialogTrigger>
                <DialogContent
                  title={t.batches.receiveConfirm}
                  description={
                    receiveTarget !== null
                      ? receiveConsequences(data, STATUS_LABELS[receiveTarget])
                      : undefined
                  }
                >
                  <div className="flex justify-end gap-2">
                    <DialogClose asChild>
                      <Button variant="secondary">{t.batches.cancel}</Button>
                    </DialogClose>
                    <Button
                      loading={phaseAction.isPending}
                      onClick={() => void runPhase('receive')}
                    >
                      {t.batches.receive}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>

          {/* Причина недоступности: серая кнопка без объяснения бесполезна. */}
          {state.dispatchLockReason !== null ? (
            <p className="text-sm text-slate-500">{state.dispatchLockReason}</p>
          ) : null}
          {state.canDispatch && dispatchTarget !== null ? (
            <p className="text-sm text-slate-600">
              {dispatchConsequences(data, STATUS_LABELS[dispatchTarget])}
            </p>
          ) : null}
          {state.canReceive && receiveTarget !== null ? (
            <p className="text-sm text-slate-600">
              {receiveConsequences(data, STATUS_LABELS[receiveTarget])}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* Состав партии. */}
      <Card>
        <CardHeader>
          <CardTitle>{t.batches.itemsTitle}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {data.items.length === 0 ? (
            <p className="text-sm text-slate-500">{t.batches.noItems}</p>
          ) : (
            <div className="overflow-x-auto">
              {/*
               * Состав — таблицей: колонок немного, и они короткие (номер,
               * клиент, сумма, статус). Обёртка `overflow-x-auto` обязательна:
               * без неё широкая таблица задала бы минимальную ширину всему
               * документу и на планшете поехала бы вся страница целиком.
               */}
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t.batches.columnNo}</th>
                    <th className="px-3 py-2 font-medium">{t.batches.customer}</th>
                    <th className="px-3 py-2 font-medium">{t.batches.amount}</th>
                    <th className="px-3 py-2 font-medium">{t.batches.status}</th>
                    {state.canEditComposition && canManage ? (
                      <th className="px-3 py-2 font-medium">{t.batches.columnActions}</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item) => (
                    <tr key={item.orderId}>
                      <td className="px-3 py-2">
                        <Link
                          href={`/orders/${item.orderId}`}
                          className="font-medium text-blue-600 underline-offset-2 hover:underline"
                        >
                          {item.orderNo}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-slate-700">{item.customerName ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-700">
                        {formatMinor(item.totalAmountMinor)}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={item.status} label={STATUS_LABELS[item.status]} />
                      </td>
                      {state.canEditComposition && canManage ? (
                        <td className="px-3 py-2">
                          <RemoveOrderDialog
                            orderNo={item.orderNo}
                            onConfirm={(reason) => runRemove(item.orderId, reason)}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {state.compositionLockReason !== null ? (
            <p className="text-sm text-slate-500">{state.compositionLockReason}</p>
          ) : null}
        </CardBody>
      </Card>

      {/* Подбор заказов — только пока состав открыт. */}
      {state.canEditComposition && canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.batches.candidatesTitle}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-slate-500">{t.batches.candidatesHint}</p>
            {candidates.isLoading ? (
              <p className="text-sm text-slate-500">{t.batches.loading}</p>
            ) : candidates.data === undefined ? (
              <p className="text-sm text-slate-500">{t.batches.candidatesEmpty}</p>
            ) : (
              <CandidateList
                group={candidates.data}
                batchId={id}
                onAdded={() => toast.showSuccess('Заказы добавлены в партию')}
              />
            )}
          </CardBody>
        </Card>
      ) : null}

      {/* Кто и когда создал — для разбирательств это первое, что спрашивают. */}
      <p className="text-xs text-slate-500">
        Создана {formatDateTime(data.createdAt)}
        {user !== null ? ` · ${user.fullName}` : ''}
      </p>
    </div>
  );
}

/** Короткая пара «подпись — значение» в сводке. */
function Info({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-slate-900">{children}</p>
    </div>
  );
}

/**
 * Диалог исключения заказа: причина обязательна.
 *
 * Строка не удаляется физически, а помечается с причиной: состав входит в акт
 * приёма-передачи, и «куда делся заказ» должно быть объяснимо после подписания.
 */
function RemoveOrderDialog({
  orderNo,
  onConfirm,
}: {
  orderNo: string;
  onConfirm: (reason: string) => Promise<void>;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`${t.batches.removeOrder} ${orderNo}`}>
          <Trash2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent title={`${t.batches.removeOrder}: ${orderNo}`}>
        <div className="space-y-3">
          <Field
            label={t.batches.removeReason}
            htmlFor={`remove-reason-${orderNo}`}
            required
            error={error ?? undefined}
          >
            <Textarea
              id={`remove-reason-${orderNo}`}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setError(null);
              }}
              maxLength={1000}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">{t.batches.cancel}</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                // Требование сервера и смысл операции: причина от 3 символов.
                if (reason.trim().length < 3) {
                  setError(t.batches.removeReasonRequired);
                  return;
                }
                void onConfirm(reason.trim());
              }}
            >
              {t.batches.removeOrder}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Список кандидатов: подходящие с отметками выбора и отклонённые с причинами.
 *
 * Отклонённые показываются рядом, а не скрываются: иначе сотрудник видит
 * «заказ пропал» и ищет его вручную, не понимая, что он не подходит по статусу
 * или уже в другой партии.
 */
function CandidateList({
  group,
  batchId,
  onAdded,
}: {
  group: Parameters<typeof candidateViews>[0];
  batchId: string;
  onAdded: () => void;
}): ReactNode {
  const addOrders = useAddBatchOrders();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const views = candidateViews(group);

  function toggle(orderId: string): void {
    setSelected((prev) =>
      prev.includes(orderId) ? prev.filter((value) => value !== orderId) : [...prev, orderId],
    );
  }

  async function submit(): Promise<void> {
    setError(null);
    try {
      await addOrders.mutateAsync({ id: batchId, orderIds: selected });
      setSelected([]);
      onAdded();
    } catch (caught: unknown) {
      setError(describeApiError(caught));
    }
  }

  if (views.length === 0) {
    return <p className="text-sm text-slate-500">{t.batches.candidatesEmpty}</p>;
  }

  return (
    <div className="space-y-3">
      {hasWarnings(group) ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t.batches.warningsTitle}
        </p>
      ) : null}

      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {views.map((view) => {
          const rejected = view.rejectionLabel !== null;
          return (
            <li key={view.orderId} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900">{view.orderNo}</p>
                {rejected ? (
                  <p className="mt-0.5 text-sm text-red-600">
                    {t.batches.rejectedTitle}: {view.rejectionLabel}
                  </p>
                ) : view.warning !== null ? (
                  // Замечание, а не отказ: заказ можно добавить (задача 7.4).
                  <p className="mt-0.5 text-sm text-amber-700">{view.warning}</p>
                ) : null}
              </div>
              {rejected ? (
                <X className="mt-1 size-4 shrink-0 text-red-400" aria-hidden="true" />
              ) : (
                <label className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    className="size-6"
                    checked={selected.includes(view.orderId)}
                    onChange={() => toggle(view.orderId)}
                    aria-label={`Добавить ${view.orderNo}`}
                  />
                </label>
              )}
            </li>
          );
        })}
      </ul>

      {selected.length > 0 ? (
        <p className="text-sm text-slate-600">
          {t.batches.selected}: {selected.length}
        </p>
      ) : null}
      {error !== null ? <FormError>{error}</FormError> : null}

      <Button
        onClick={() => void submit()}
        loading={addOrders.isPending}
        disabled={selected.length === 0}
      >
        <Check className="size-4" />
        {t.batches.addSelected}
      </Button>
    </div>
  );
}
