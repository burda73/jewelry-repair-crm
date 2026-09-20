'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as Tabs from '@radix-ui/react-tabs';
import { ArrowLeft, AlertTriangle, Printer } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useFinishAssignment, useOrder, useOrderTimeline, usePrintReceipt } from '@/lib/queries';
import {
  formatDate,
  formatDateTime,
  formatMinor,
  formatMinorExact,
  formatPhoneValue,
  daysUntil,
  plural,
} from '@/lib/format';
import { PAYMENT_KIND_LABELS, PAYMENT_METHOD_LABELS } from '@/lib/i18n';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { TransitionDialog } from '@/components/orders/transition-dialog';
import { PaymentDialog } from '@/components/orders/payment-dialog';
import { ApprovalDialog } from '@/components/orders/approval-dialog';
import { AdjustmentDialog } from '@/components/orders/adjustment-dialog';
import { AssignPerformerDialog } from '@/components/orders/assign-performer-dialog';
import { WorksEditor } from '@/components/orders/works-editor';
import { RollbackDialog } from '@/components/orders/rollback-dialog';
import { ItemPhotos } from '@/components/orders/item-photos';
import { t, PRIORITY_LABELS } from '@/lib/i18n';
import { describeDiscount, isWorksEditable } from '@app/shared';
import { cn } from '@/lib/utils';

/** Пара «подпись — значение» для блоков карточки. */
function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-sm text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

export default function OrderDetailPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const { can } = useAuth();

  const order = useOrder(id);
  const timeline = useOrderTimeline(id);
  const printReceipt = usePrintReceipt();
  const finishAssignment = useFinishAssignment();
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [worksOpen, setWorksOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);

  if (order.isLoading) {
    return <p className="py-12 text-center text-sm text-slate-500">{t.common.loading}</p>;
  }

  if (order.isError || order.data === undefined) {
    return (
      <div className="space-y-4">
        <EmptyState
          title={t.order.notFound}
          hint="Заказ не существует или находится вне вашей области видимости"
          action={
            <Link href="/orders">
              <Button variant="secondary">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {t.common.back}
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  const data = order.data;
  const dueDays = daysUntil(data.dueAt);
  /** Скидка или надбавка — знак трактует доменная функция, а не этот компонент. */
  const discount = describeDiscount(data.discountMinor);
  const canTransition = can('order:transition') && data.availableTransitions.length > 0;
  // Отмена заказа — это тоже переход статуса (в таблице переходов есть роли
  // `CANCELLED` с обязательной причиной), поэтому отдельной кнопки и
  // отдельного права здесь нет: диалог перехода сам запросит причину.
  // Принимать деньги может кассир (PERMISSION.PAYMENT_CREATE); администратор
  // получает все права автоматически (ROLE_PERMISSIONS[ADMIN] = все права).
  // Приёмщик платежи ВИДИТ, но не принимает — это разделение ответственности
  // за наличные (docs/02-domain-and-roles.md).
  const canPay =
    can('payment:create') &&
    data.status !== 'CANCELLED' &&
    data.status !== 'REFUSED' &&
    // Отказ до начала работ (дефект 67) — деньги за невыполненный ремонт не
    // принимаются: заказ закрыт по инициативе клиента.
    data.status !== 'REFUSED_BEFORE_WORK';
  const hasDebt = data.remainingMinor > 0;

  /*
   * Согласование и корректировка доступны, пока заказ не закрыт: после выдачи
   * или отказа менять согласованную сумму бессмысленно, и сервер такие запросы
   * отклонит (`ORDER_FINAL`). Скрываем кнопки заранее — интерфейс не должен
   * предлагать действие, которое заведомо вернёт ошибку.
   */
  const isFinal =
    data.status === 'COMPLETED' ||
    data.status === 'REFUSED' ||
    data.status === 'REFUSED_BEFORE_WORK' ||
    data.status === 'CANCELLED';
  const canApprove = can('approval:create') && !isFinal;
  // Загружать фото можно, пока заказ не закрыт: после выдачи менять состав
  // доказательств уже поздно — это подрывало бы смысл фотофиксации.
  const canEdit = can('order:update') && !isFinal;
  const canAdjust = can('calc:adjust') && !isFinal;

  /*
   * Выдача работы исполнителю. Статус берём из доступных переходов, а не
   * сравниваем с `ACCEPTED_BY_WORKSHOP` вручную: список переходов приходит с
   * сервера из той же таблицы, что охраняет действие. Сравнение со статусом
   * разошлось бы с таблицей при первой же правке статусной модели.
   */
  const canAssign =
    can('production:manage') &&
    data.availableTransitions.some((transition) => transition.to === 'IN_WORK');

  /*
   * Приёмка работы — ОТДЕЛЬНОЕ условие, а не то же, что выдача.
   *
   * Здесь был дефект: кнопка «Принять работу» показывалась по `canAssign`, то
   * есть по наличию перехода В работу. Но переход в работу доступен ровно ДО
   * выдачи, а принять работу нужно ПОСЛЕ — в статусе «Выдано в работу». Условия
   * не пересекаются ни в одной точке, поэтому кнопка не показывалась никогда, и
   * заказ невозможно было перевести в «Работы завершены»: оставался только
   * переход из диалога, который всегда отвечает «Работы ещё не завершены».
   *
   * Условие выводится из доступных переходов к `WORK_COMPLETED` — той же таблицы,
   * что охраняет действие на сервере.
   */
  const canFinishAssignment =
    can('production:manage') &&
    data.availableTransitions.some((transition) => transition.to === 'WORK_COMPLETED');

  /** Действующий исполнитель: последнее незакрытое назначение. */
  const activeAssignment = [...data.assignments]
    .reverse()
    .find((assignment) => assignment.status === 'ASSIGNED' || assignment.status === 'IN_PROGRESS');

  /*
   * Граница правки берётся из ДОМЕНА, а не выписывается здесь списком статусов.
   * Своя копия разошлась бы с сервером при первой же правке правила — и
   * разошлась бы молча: кнопка появлялась бы там, где сервер отвечает отказом,
   * или, что хуже, исчезала бы там, где правка разрешена.
   */
  const canEditWorks = can('calc:composition') && isWorksEditable(data.status) && !isFinal;

  /** Строки калькуляции для выбора цели корректировки. */
  const workRows = data.works.map((work) => ({
    id: work.id,
    label: `${work.name} × ${String(work.quantity)}`,
    amountMinor: work.amountMinor,
  }));
  const stoneRows = data.stones.map((stone) => ({
    id: stone.id,
    label: `${stone.name} × ${stone.quantity}`,
    amountMinor: stone.amountMinor,
  }));

  return (
    <div className="space-y-4">
      <Link
        href="/orders"
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t.orders.title}
      </Link>

      {/* Статусная шапка: номер, статус, срок и главные действия. */}
      <header className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-xl font-bold text-slate-900">{data.orderNo}</h1>
              <StatusBadge status={data.status} label={data.statusLabel} />
              {data.isWarranty ? <Badge tone="violet">{t.orders.warranty}</Badge> : null}
              {data.priority !== 'NORMAL' ? (
                <Badge tone="amber">{PRIORITY_LABELS[data.priority] ?? data.priority}</Badge>
              ) : null}
            </div>

            <p className="mt-2 text-sm text-slate-600">
              {data.items.map((item) => item.name).join(', ') || '—'}
            </p>
            <p className="text-sm text-slate-500">
              {data.customer.fullName} ·{' '}
              <a
                href={`tel:${data.customer.phoneNormalized}`}
                className="text-blue-700 hover:underline"
              >
                {formatPhoneValue(data.customer.phoneNormalized)}
              </a>
            </p>
          </div>

          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-slate-400">{t.order.dueAt}</p>
            <p
              className={cn(
                'text-lg font-semibold',
                dueDays !== null && dueDays < 0
                  ? 'text-red-600'
                  : dueDays !== null && dueDays <= 2
                    ? 'text-amber-600'
                    : 'text-slate-900',
              )}
            >
              {formatDate(data.dueAt)}
            </p>
            {dueDays !== null ? (
              <p className="text-xs text-slate-500">
                {dueDays < 0
                  ? `${t.order.daysOverdue} ${Math.abs(dueDays)} ${plural(Math.abs(dueDays), 'день', 'дня', 'дней')}`
                  : `${t.order.daysLeft} ${dueDays} ${plural(dueDays, 'день', 'дня', 'дней')}`}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {canPay ? (
            <Button onClick={() => setPaymentOpen(true)}>
              {hasDebt ? `Принять оплату · ${formatMinor(data.remainingMinor)}` : 'Принять оплату'}
            </Button>
          ) : null}
          {canTransition ? (
            <Button variant="secondary" onClick={() => setTransitionOpen(true)}>
              {t.order.transition}
            </Button>
          ) : null}
          {canApprove ? (
            <Button variant="secondary" onClick={() => setApprovalOpen(true)}>
              Согласование
            </Button>
          ) : null}
          {canAdjust ? (
            <Button variant="secondary" onClick={() => setAdjustmentOpen(true)}>
              Корректировка
            </Button>
          ) : null}
          {/*
            Квитанция формируется на сервере и открывается в новой вкладке.
            Кнопка не блокируется: даже если печать уже была, сотрудник вправе
            напечатать копию — сервер увеличит счётчик, и перепечатка останется
            в истории заказа.
          */}
          <Button
            variant="secondary"
            onClick={() => printReceipt.mutate(data.id)}
            disabled={printReceipt.isPending}
          >
            <Printer className="h-4 w-4" aria-hidden="true" />
            {printReceipt.isPending ? 'Формирование…' : 'Печать квитанции'}
          </Button>
        </div>

        {data.requiresPrepayment && !data.canStartWork ? (
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Работы не начнутся до подтверждения предоплаты: требуется{' '}
            {formatMinor(data.prepaymentRequiredMinor)}
          </p>
        ) : null}
      </header>

      <Tabs.Root
        defaultValue="overview"
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <Tabs.List className="flex gap-1 overflow-x-auto border-b border-slate-200 px-2">
          {(
            [
              ['overview', t.order.tabs.overview],
              ['calc', t.order.tabs.calc],
              ['payments', t.order.tabs.payments],
              ['approvals', t.order.tabs.approvals],
              ['history', t.order.tabs.history],
            ] as const
          ).map(([value, label]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={cn(
                'whitespace-nowrap border-b-2 border-transparent px-3 py-3 text-sm font-medium text-slate-500',
                'hover:text-slate-700 data-[state=active]:border-blue-600 data-[state=active]:text-blue-700',
              )}
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="overview" className="p-4 focus:outline-none">
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-500">{t.order.item}</h2>
              <div className="space-y-3">
                {data.items.map((item) => (
                  <div key={item.id} className="rounded-lg border border-slate-200 p-3">
                    <p className="font-medium text-slate-900">{item.name}</p>
                    <dl className="mt-1">
                      {item.metal !== null ? <Row label="Металл" value={item.metal} /> : null}
                      {item.weightGram !== null ? (
                        <Row label="Вес" value={`${String(item.weightGram)} г`} />
                      ) : null}
                      {item.size !== null ? <Row label="Размер" value={item.size} /> : null}
                      {item.hallmark !== null ? <Row label="Пробa" value={item.hallmark} /> : null}
                      {item.completeness !== null ? (
                        <Row label="Комплектность" value={item.completeness} />
                      ) : null}
                    </dl>
                    {item.defects !== null ? (
                      <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-sm text-slate-600">
                        <span className="text-slate-500">{t.order.description}: </span>
                        {item.defects}
                      </p>
                    ) : null}
                    {/*
                      Фотофиксация при приёме (ТЗ п. 2.1): защищает и клиента,
                      и сотрудника — фиксирует состояние изделия до ремонта.
                      Блок доступен и для чтения: фотографии видны всем, кто
                      видит заказ, а загружать может тот, у кого есть право
                      правки заказа.
                    */}
                    <ItemPhotos item={item} orderId={data.id} canUpload={canEdit} />
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-500">{t.order.money}</h2>
              <div className="rounded-lg border border-slate-200 p-3">
                <dl>
                  <Row label="Работы" value={formatMinorExact(data.worksTotalMinor)} />
                  <Row label="Камни" value={formatMinorExact(data.stonesTotalMinor)} />
                  {/*
                    Скидка может быть отрицательной — это надбавка: согласованная
                    с клиентом сумма больше суммы строк (срочность, сложность).
                    Трактовку знака задаёт доменная функция, чтобы сервер и
                    интерфейс не разошлись в понимании `discountMinor`.
                  */}
                  {discount.kind !== 'NONE' ? (
                    <Row
                      label={discount.label}
                      value={`${discount.kind === 'DISCOUNT' ? '−' : '+'}${formatMinorExact(discount.amountMinor)}`}
                    />
                  ) : null}
                  <div className="my-2 border-t border-slate-200" />
                  <Row
                    label={t.order.total}
                    value={
                      <span className="text-base">{formatMinorExact(data.totalAmountMinor)}</span>
                    }
                  />
                  <Row label={t.order.paid} value={formatMinorExact(data.paidAmountMinor)} />
                  <Row
                    label={t.order.remaining}
                    value={
                      <span
                        className={data.remainingMinor > 0 ? 'text-amber-600' : 'text-emerald-600'}
                      >
                        {formatMinorExact(data.remainingMinor)}
                      </span>
                    }
                  />
                </dl>
                {data.requiresPrepayment ? (
                  <p className="mt-2 border-t border-slate-100 pt-2 text-sm">
                    {t.order.prepayment}: {formatMinor(data.prepaymentRequiredMinor)} —{' '}
                    <span className={data.canStartWork ? 'text-emerald-600' : 'text-amber-600'}>
                      {data.canStartWork ? t.order.prepaymentDone : t.order.prepaymentMissing}
                    </span>
                  </p>
                ) : null}
              </div>

              <h2 className="mb-2 mt-4 text-sm font-semibold text-slate-500">
                {t.order.production}
              </h2>
              <div className="rounded-lg border border-slate-200 p-3">
                <dl>
                  <Row label={t.orders.store} value={data.createdStore.name} />
                  {data.pickupStore.id !== data.createdStore.id ? (
                    <Row label="Выдача" value={data.pickupStore.name} />
                  ) : null}
                  <Row label={t.order.workshop} value={data.workshop?.name ?? '—'} />
                  <Row label={t.order.createdBy} value={data.createdBy?.fullName ?? '—'} />
                  <Row label="Принят" value={formatDateTime(data.acceptedAt ?? data.createdAt)} />
                  {/*
                    Исполнитель показывается отдельной строкой: заказчик
                    потребовал видеть, какой ювелир выполняет работу. Без этого
                    блока выданную работу нельзя было увидеть в карточке — её не
                    было видно и в интерфейсе, и в глаза это выглядело как
                    «исполнителя указать нельзя».
                  */}
                  {activeAssignment !== undefined ? (
                    <Row
                      label="Исполнитель"
                      value={
                        <>
                          {activeAssignment.performer.fullName}
                          {activeAssignment.performer.specialization !== null
                            ? ` · ${activeAssignment.performer.specialization}`
                            : ''}
                        </>
                      }
                    />
                  ) : null}
                </dl>

                {activeAssignment !== undefined ? (
                  <div className="mt-2 border-t border-slate-100 pt-2">
                    <p className="text-xs text-slate-500">
                      Работа выдана {formatDateTime(activeAssignment.createdAt)}
                      {` · ${activeAssignment.assignedBy.fullName}`}
                      {activeAssignment.plannedHours !== null
                        ? ` · план ${String(activeAssignment.plannedHours)} ч`
                        : ''}
                    </p>
                    {activeAssignment.comment !== null ? (
                      <p className="mt-1 text-xs text-slate-500">{activeAssignment.comment}</p>
                    ) : null}
                  </div>
                ) : null}

                {/*
                  ЕДИНЫЙ БЛОК РАБОТЫ С ИСПОЛНИТЕЛЕМ.
                  
                  Выдача и приёмка — два шага одного процесса, поэтому они стоят
                  рядом и видны в одном месте. Прежде выдача была в шапке, а
                  приёмка — здесь: сотрудник искал вторую кнопку там же, где
                  нажимал первую, и не находил.
                */}
                {canAssign || canFinishAssignment ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    {canAssign ? (
                      <Button onClick={() => setAssignOpen(true)}>Выдать работу исполнителю</Button>
                    ) : null}
                    {canFinishAssignment &&
                    activeAssignment !== undefined &&
                    activeAssignment.status !== 'DONE' ? (
                      <>
                        {/*
                          Приёмка — отдельное действие менеджера (ТЗ п. 2.7):
                          одного «я закончил» от ювелира недостаточно, иначе в
                          магазин уедет изделие, которое никто не проверял.
                        */}
                        <Button
                          variant="secondary"
                          onClick={() =>
                            finishAssignment.mutate({
                              orderId: data.id,
                              assignmentId: activeAssignment.id,
                            })
                          }
                          disabled={finishAssignment.isPending}
                        >
                          {finishAssignment.isPending ? 'Приёмка…' : 'Принять работу'}
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/*
                Предупреждение о согласовании видно и без открытия диалога выдачи:
                иначе менеджер нажимает «Выдать работу» и только там узнаёт, что
                сначала нужно согласие клиента.
              */}
              {!data.approvalCoverage.ok ? (
                <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {data.approvalCoverage.reason === 'MISSING'
                      ? 'Согласование с клиентом отсутствует — заказ нельзя передать в работу.'
                      : `Согласование устарело: клиент подтвердил ${formatMinorExact(data.approvalCoverage.approvedMinor)}, сейчас в заказе ${formatMinorExact(data.approvalCoverage.totalMinor)}.`}
                  </span>
                </p>
              ) : null}

              {data.diagnosis !== null ? (
                <>
                  <h2 className="mb-2 mt-4 text-sm font-semibold text-slate-500">
                    {t.order.diagnosis}
                  </h2>
                  <p className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
                    {data.diagnosis}
                  </p>
                </>
              ) : null}
            </section>
          </div>
        </Tabs.Content>

        <Tabs.Content value="calc" className="p-4 focus:outline-none">
          {canEditWorks ? (
            <div className="mb-3 flex justify-end">
              <Button variant="secondary" onClick={() => setWorksOpen(true)}>
                Изменить виды работ
              </Button>
            </div>
          ) : null}
          {data.works.length === 0 && data.stones.length === 0 ? (
            <EmptyState title={t.order.calcEmpty} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Наименование</th>
                    <th className="px-3 py-2 text-right font-medium">Кол-во</th>
                    <th className="px-3 py-2 text-right font-medium">Цена</th>
                    <th className="px-3 py-2 text-right font-medium">Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {data.works.map((work) => (
                    <tr key={work.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        <span className="text-slate-900">{work.name}</span>
                        <span className="ml-2 font-mono text-xs text-slate-400">{work.code}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {String(work.quantity)} {work.unit}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMinorExact(work.unitPriceMinor)}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {/*
                          Показываем ХРАНИМУЮ сумму строки, а не произведение цены
                          на количество. После корректировки (`calc:adjust`) меняется
                          именно `amountMinor`, поэтому пересчёт «на месте» показал бы
                          в таблице одну сумму, а в итоге заказа — другую.
                        */}
                        {formatMinorExact(work.amountMinor)}
                      </td>
                    </tr>
                  ))}
                  {data.stones.map((stone) => (
                    <tr key={stone.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-900">{stone.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{stone.quantity} шт</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMinorExact(stone.unitPriceMinor)}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatMinorExact(stone.unitPriceMinor * stone.quantity)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="payments" className="p-4 focus:outline-none">
          {data.payments.length === 0 ? (
            <EmptyState title={t.order.paymentsEmpty} />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.payments.map((payment) => (
                <li key={payment.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {formatMinorExact(payment.amountMinor)}
                      {payment.kind === 'PREPAYMENT' ? (
                        <Badge tone="amber" className="ml-2">
                          предоплата
                        </Badge>
                      ) : null}
                      {/* Сторнированный платёж остаётся в истории, но помечается:
                          сумма по заказу его уже не учитывает, и без пометки
                          список платежей противоречил бы итогу. */}
                      {payment.status === 'REVERSED' ? (
                        <Badge tone="slate" className="ml-2">
                          отменён
                        </Badge>
                      ) : null}
                    </p>
                    <p className="text-xs text-slate-500">
                      {formatDateTime(payment.paidAt)} · {PAYMENT_METHOD_LABELS[payment.method]} ·{' '}
                      {PAYMENT_KIND_LABELS[payment.kind]}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Tabs.Content>

        <Tabs.Content value="approvals" className="p-4 focus:outline-none">
          {data.approvals.length === 0 ? (
            <EmptyState title={t.order.approvalsEmpty} />
          ) : (
            <ul className="space-y-2">
              {data.approvals.map((approval) => (
                <li key={approval.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">
                      {formatMinorExact(approval.amountMinor)}
                    </span>
                    {approval.isVerbal ? <Badge tone="amber">Согласовано устно</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {approval.createdBy?.fullName ?? '—'} ·{' '}
                    {formatDateTime(approval.approvedAt ?? approval.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Tabs.Content>

        <Tabs.Content value="history" className="p-4 focus:outline-none">
          {/*
            Откат — инструмент администратора и стоит именно здесь: на этой
            вкладке видно, какие состояния заказ проходил, и осознанный выбор
            точки отката возможен только рядом с историей.
          */}
          {can('order:rollback') ? (
            <div className="mb-3 flex justify-end">
              <Button variant="secondary" onClick={() => setRollbackOpen(true)}>
                Откатить до состояния
              </Button>
            </div>
          ) : null}
          {timeline.isLoading ? (
            <p className="py-6 text-center text-sm text-slate-500">{t.common.loading}</p>
          ) : timeline.data === undefined || timeline.data.length === 0 ? (
            <EmptyState title={t.order.historyEmpty} />
          ) : (
            <ol className="relative space-y-4 border-l border-slate-200 pl-4">
              {timeline.data.map((entry, index) => (
                <li key={`${entry.type}-${entry.at}-${index}`} className="relative">
                  <span
                    className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-blue-500"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium text-slate-900">{entry.title}</p>
                  <p className="text-xs text-slate-500">
                    {formatDateTime(entry.at)}
                    {entry.actor !== null ? ` · ${entry.actor}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Tabs.Content>
      </Tabs.Root>

      <TransitionDialog
        open={transitionOpen}
        onOpenChange={setTransitionOpen}
        order={data}
        /*
         * Переходы, которые выполняются ОТДЕЛЬНЫМ действием, из списка убираются.
         * «Работы завершены» требует записи о работе со статусом DONE, а её
         * создаёт приёмка (`POST /assignments/:id/finish`). В списке переходов
         * этот пункт — тупик: выбор всегда отвечает «Работы по заказу ещё не
         * завершены», и сотрудник не понимает, что делать.
         */
        exclude={canFinishAssignment && activeAssignment !== undefined ? ['WORK_COMPLETED'] : []}
      />

      <PaymentDialog open={paymentOpen} onOpenChange={setPaymentOpen} order={data} />

      <ApprovalDialog open={approvalOpen} onOpenChange={setApprovalOpen} order={data} />

      <AssignPerformerDialog open={assignOpen} onOpenChange={setAssignOpen} order={data} />

      <WorksEditor open={worksOpen} onOpenChange={setWorksOpen} order={data} />

      <RollbackDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        orderId={data.id}
        orderNo={data.orderNo}
      />

      <AdjustmentDialog
        open={adjustmentOpen}
        onOpenChange={setAdjustmentOpen}
        orderId={data.id}
        orderNo={data.orderNo}
        totalAmountMinor={data.totalAmountMinor}
        works={workRows}
        stones={stoneRows}
        paidAmountMinor={data.paidAmountMinor}
      />
    </div>
  );
}
