'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreatePayment, useStores } from '@/lib/queries';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field, FormError } from '@/components/ui/field';
import { DialogContent } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { formatMinor, formatMinorExact } from '@/lib/format';
import { PAYMENT_KIND_LABELS, PAYMENT_METHOD_LABELS } from '@/lib/i18n';
import { parseMoneyInput } from '@app/shared';
import type { OrderDetail, PaymentKind, PaymentMethod } from '@/lib/api-types';

/**
 * Диалог приёма оплаты.
 *
 * Ключевые решения:
 *
 * 1. **Магазин приёма выбирается явно.** По ТЗ п. 2.5 оплату принимают в любой
 *    точке сети: клиент может прийти в удобный магазин, а не тот, где оформлен
 *    заказ. Поэтому магазин по умолчанию — магазин заказа, но его можно сменить
 *    (в пределах доступных пользователю).
 *
 * 2. **Сумма вводится в рублях, а уходит в копейках.** Разбор делает
 *    `parseMoneyInput` из доменного ядра — та же функция, что и на сервере,
 *    поэтому «1 500,50» понимается одинаково в обоих местах.
 *
 * 3. **Есть кнопка «остаток».** Кассир чаще всего принимает именно остаток,
 *    и ручной ввод суммы — самый вероятный источник опечаток в деньгах.
 *
 * 4. **Ключ идемпотентности не виден пользователю.** Он генерируется хуком
 *    мутации один раз на попытку и повторно не создаётся: иначе повтор при
 *    обрыве связи оформил бы второй платёж.
 */
export function PaymentDialog({
  open,
  onOpenChange,
  order,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderDetail;
}): ReactNode {
  const { user } = useAuth();
  const toast = useToast();
  const createPayment = useCreatePayment();

  const [kind, setKind] = useState<PaymentKind>('PREPAYMENT');
  const [method, setMethod] = useState<PaymentMethod>('CARD');
  const [amount, setAmount] = useState('');
  const [storeId, setStoreId] = useState('');
  const [receiptNo, setReceiptNo] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Остаток — сумма, которую кассир вносит чаще всего.
  const remaining = order.remainingMinor;

  useEffect(() => {
    if (!open) return;

    setMethod('CARD');
    setReceiptNo('');
    setComment('');
    setError(null);

    // Если заказ требует предоплату и она ещё не внесена — предлагаем именно
    // предоплату. Иначе это окончательный расчёт: так кассиру не нужно
    // выбирать вид платежа в типовом сценарии.
    const needsPrepayment =
      order.requiresPrepayment && order.paidAmountMinor < order.prepaymentRequiredMinor;
    setKind(needsPrepayment ? 'PREPAYMENT' : 'FINAL');

    // По умолчанию — магазин, в котором пользователь работает. Если у него
    // несколько магазинов, берём первый: чаще всего это его основное место.
    setStoreId(user?.storeIds[0] ?? order.createdStore.id ?? '');

    setAmount(String(remaining / 100).replace('.', ','));
  }, [open, order, remaining, user]);

  // Магазины берём из справочника, а не из `user.storeRoles`: там только
  // идентификаторы, и в списке выбора пришлось бы показывать GUID.
  const { data: allStores } = useStores();

  /**
   * Магазины, доступные пользователю для приёма оплаты.
   *
   * Приёмщик и кассир ограничены своими магазинами; администратор и
   * руководитель (полный доступ) видят все активные. Ограничение всё равно
   * проверяется на сервере — здесь оно только не показывает заведомо
   * отклоняемый выбор.
   */
  const stores = useMemo(() => {
    const list = allStores ?? [];
    const isRestricted = user !== null && user.scope !== 'ALL_STORES';
    if (!isRestricted) return list.filter((store) => store.isActive);

    const allowed = new Set(user.storeIds);
    return list.filter((store) => allowed.has(store.id));
  }, [allStores, user]);

  const amountMinor = useMemo(() => {
    if (amount.trim() === '') return null;
    return parseMoneyInput(amount);
  }, [amount]);

  const exceedsRemaining = amountMinor !== null && amountMinor > remaining;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (amountMinor === null || amountMinor <= 0) {
      setError('Укажите корректную сумму');
      return;
    }
    if (exceedsRemaining) {
      // Дублируем серверную проверку, чтобы не гонять заведомо отклоняемый
      // запрос: сервер всё равно вернёт OVERPAYMENT, но пользователь получит
      // ответ мгновенно и без тоста об ошибке.
      setError(`Сумма превышает остаток к оплате (${formatMinor(remaining)})`);
      return;
    }
    if (storeId === '') {
      setError('Выберите магазин приёма оплаты');
      return;
    }

    try {
      const result = await createPayment.mutateAsync({
        orderId: order.id,
        kind,
        method,
        amountMinor,
        storeId,
        paidAt: new Date().toISOString(),
        ...(receiptNo.trim() === '' ? {} : { receiptNo: receiptNo.trim() }),
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      });

      toast.showSuccess(
        result.order.isPaidInFull
          ? 'Заказ оплачен полностью'
          : `Принято. Остаток: ${formatMinor(result.order.remainingMinor)}`,
      );
      onOpenChange(false);
    } catch {
      // Тост показывает хук мутации; диалог оставляем открытым,
      // чтобы кассир мог исправить сумму и повторить.
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Приём оплаты"
        description={`${order.orderNo} · остаток ${formatMinorExact(remaining)}`}
      >
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="space-y-4"
        >
          <Field label="Вид платежа" htmlFor="payment-kind" required>
            <Select
              id="payment-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as PaymentKind)}
              disabled={createPayment.isPending}
            >
              {/* REVERSAL не предлагается: сторно — отдельная операция по
                  конкретному платежу, а не способ приёма денег. */}
              {(['PREPAYMENT', 'FINAL', 'ADDITIONAL', 'REFUND'] as const).map((value) => (
                <option key={value} value={value}>
                  {PAYMENT_KIND_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Способ оплаты" htmlFor="payment-method" required>
            <Select
              id="payment-method"
              value={method}
              onChange={(event) => setMethod(event.target.value as PaymentMethod)}
              disabled={createPayment.isPending}
            >
              {(['CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE'] as const).map((value) => (
                <option key={value} value={value}>
                  {PAYMENT_METHOD_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Сумма, ₽"
            htmlFor="payment-amount"
            required
            error={exceedsRemaining ? 'Больше остатка' : undefined}
          >
            <div className="flex gap-2">
              <Input
                id="payment-amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                disabled={createPayment.isPending}
                aria-invalid={exceedsRemaining}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => setAmount(String(remaining / 100).replace('.', ','))}
                disabled={createPayment.isPending}
                className="shrink-0"
              >
                Остаток
              </Button>
            </div>
          </Field>

          <Field label="Магазин приёма" htmlFor="payment-store" required>
            <Select
              id="payment-store"
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
              disabled={createPayment.isPending}
            >
              {/* Магазин приёма может отличаться от магазина заказа (ТЗ п. 2.5):
                  клиент вправе оплатить там, где ему удобно. Подсказываем,
                  какой магазин является магазином заказа. */}
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.id === order.createdStore.id
                    ? `${store.name} — магазин заказа`
                    : `${store.name} (${store.code})`}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Номер чека ККТ" htmlFor="payment-receipt" hint="Необязательно">
            <Input
              id="payment-receipt"
              value={receiptNo}
              onChange={(event) => setReceiptNo(event.target.value)}
              disabled={createPayment.isPending}
              maxLength={50}
            />
          </Field>

          <Field label="Комментарий" htmlFor="payment-comment" hint="Необязательно">
            <Textarea
              id="payment-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              disabled={createPayment.isPending}
              maxLength={1000}
            />
          </Field>

          {error !== null ? <FormError>{error}</FormError> : null}

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" variant="secondary" disabled={createPayment.isPending}>
                Отмена
              </Button>
            </Dialog.Close>
            <Button type="submit" loading={createPayment.isPending}>
              {createPayment.isPending ? 'Принимаем…' : 'Принять оплату'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog.Root>
  );
}
