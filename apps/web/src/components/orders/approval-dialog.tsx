'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreateApproval } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FormError } from '@/components/ui/field';
import { DialogContent } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { formatMinor, formatMinorExact } from '@/lib/format';
import { parseMoneyInput } from '@app/shared';
import type { OrderDetail } from '@/lib/api-types';

type ApprovalChannel = 'IN_PERSON' | 'PHONE_VERBAL' | 'SMS' | 'MESSENGER' | 'EMAIL';
type ApprovalResult = 'PENDING' | 'APPROVED' | 'REJECTED' | 'NO_ANSWER' | 'CHANGED';

const CHANNEL_LABELS: Record<ApprovalChannel, string> = {
  IN_PERSON: 'Лично в магазине',
  PHONE_VERBAL: 'Устно по телефону',
  SMS: 'SMS',
  MESSENGER: 'Мессенджер',
  EMAIL: 'E-mail',
};

const RESULT_LABELS: Record<ApprovalResult, string> = {
  APPROVED: 'Согласовано',
  REJECTED: 'Клиент отказался',
  NO_ANSWER: 'Не дозвонились',
  CHANGED: 'Просит изменить',
  PENDING: 'Ожидает ответа',
};

/**
 * Диалог согласования с клиентом (ТЗ п. 2.4).
 *
 * Ключевые решения:
 *
 * 1. **Срок считается в рабочих днях, а не в календарной дате.** Приёмщик
 *    называет клиенту срок в днях («шесть рабочих дней»), а точную дату
 *    готовности считает сервер по производственному календарю. Если бы
 *    приёмщик выбирал дату сам, он мог бы поставить её на воскресенье,
 *    и нормативы этапов посчитали бы дедлайн неверно.
 *
 * 2. **Сумма по умолчанию — сумма заказа.** Согласование чаще всего идёт
 *    ровно на эту сумму; показываем её как готовое значение, чтобы не
 *    заставлять вводить число руками. Но изменить можно: клиент вправе
 *    попросить удешевить ремонт, и тогда сервер зафиксирует корректировку
 *    с причиной — сумма заказа и согласованная сумма не разойдутся молча.
 *
 * 3. **Предупреждаем о расхождении сумм.** Если введённая сумма отличается
 *    от суммы заказа, показываем это явно: приёмщик должен понимать, что
 *    меняет стоимость заказа, а не просто фиксирует разговор.
 *
 * 4. **Срок обязателен только для состоявшегося согласования.** Для ответа
 *    «не дозвонились» срока нет — иначе пришлось бы выдумывать дату.
 */
export function ApprovalDialog({
  open,
  onOpenChange,
  order,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderDetail;
}): ReactNode {
  const createApproval = useCreateApproval();

  const [channel, setChannel] = useState<ApprovalChannel>('PHONE_VERBAL');
  const [result, setResult] = useState<ApprovalResult>('APPROVED');
  const [amount, setAmount] = useState('');
  const [termDays, setTermDays] = useState('6');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    // Устное согласие по телефону — типовой канал (ТЗ п. 2.4 требует его
    // отдельно), поэтому он выбран по умолчанию.
    setChannel('PHONE_VERBAL');
    setResult('APPROVED');
    setAmount(String(order.totalAmountMinor / 100).replace('.', ','));
    setTermDays('6');
    setComment('');
    setError(null);
  }, [open, order.totalAmountMinor]);

  const amountMinor = useMemo(() => {
    if (amount.trim() === '') return null;
    return parseMoneyInput(amount);
  }, [amount]);

  const isApproved = result === 'APPROVED';
  const differs = isApproved && amountMinor !== null && amountMinor !== order.totalAmountMinor;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (isApproved && (amountMinor === null || amountMinor <= 0)) {
      setError('Укажите согласованную сумму');
      return;
    }

    const days = Number.parseInt(termDays, 10);
    if (isApproved && (Number.isNaN(days) || days < 0)) {
      setError('Укажите согласованный срок в рабочих днях');
      return;
    }

    try {
      await createApproval.mutateAsync({
        orderId: order.id,
        channel,
        result,
        // Сумма нужна и для отказа: она фиксирует, о какой сумме шла речь.
        amountMinor: amountMinor ?? order.totalAmountMinor,
        ...(isApproved ? { termDays: days } : {}),
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      });
      onOpenChange(false);
    } catch {
      // Тост показывает хук мутации; диалог оставляем открытым,
      // чтобы приёмщик мог исправить данные и повторить.
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Согласование с клиентом"
        description={`${order.orderNo} · сумма заказа ${formatMinorExact(order.totalAmountMinor)}`}
      >
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="space-y-4"
        >
          <Field label="Канал связи" htmlFor="approval-channel" required>
            <Select
              id="approval-channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value as ApprovalChannel)}
              disabled={createApproval.isPending}
            >
              {(Object.keys(CHANNEL_LABELS) as ApprovalChannel[]).map((value) => (
                <option key={value} value={value}>
                  {CHANNEL_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Результат" htmlFor="approval-result" required>
            <Select
              id="approval-result"
              value={result}
              onChange={(event) => setResult(event.target.value as ApprovalResult)}
              disabled={createApproval.isPending}
            >
              {(Object.keys(RESULT_LABELS) as ApprovalResult[]).map((value) => (
                <option key={value} value={value}>
                  {RESULT_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Согласованная сумма, ₽"
            htmlFor="approval-amount"
            required={isApproved}
            error={differs ? 'Отличается от суммы заказа' : undefined}
          >
            <Input
              id="approval-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              disabled={createApproval.isPending}
              aria-invalid={differs}
            />
          </Field>

          {/*
            Согласованная сумма становится суммой заказа (через корректировку
            с обязательной причиной). Приёмщик обязан видеть последствие —
            иначе он «просто фиксирует разговор», а заказ незаметно дешевеет.
          */}
          {differs ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Сумма заказа изменится: {formatMinor(order.totalAmountMinor)} →{' '}
              {amountMinor !== null ? formatMinor(amountMinor) : '—'}. Изменение будет записано
              в историю как корректировка.
            </p>
          ) : null}

          {isApproved ? (
            <Field
              label="Срок, рабочих дней"
              htmlFor="approval-term"
              required
              hint="Дату готовности сервер посчитает по производственному календарю"
            >
              <Input
                id="approval-term"
                value={termDays}
                onChange={(event) => setTermDays(event.target.value)}
                inputMode="numeric"
                disabled={createApproval.isPending}
              />
            </Field>
          ) : null}

          <Field label="Комментарий" htmlFor="approval-comment" hint="Необязательно">
            <Textarea
              id="approval-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              disabled={createApproval.isPending}
              maxLength={2000}
            />
          </Field>

          {error !== null ? <FormError>{error}</FormError> : null}

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" variant="secondary" disabled={createApproval.isPending}>
                Отмена
              </Button>
            </Dialog.Close>
            <Button type="submit" loading={createApproval.isPending}>
              {createApproval.isPending ? 'Сохраняем…' : 'Зафиксировать'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog.Root>
  );
}
