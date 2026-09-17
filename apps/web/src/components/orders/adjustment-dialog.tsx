'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreateAdjustment } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FormError } from '@/components/ui/field';
import { DialogContent } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { formatMinor, formatMinorExact } from '@/lib/format';
import { parseMoneyInput } from '@app/shared';

type AdjustTarget = 'TOTAL' | 'WORK' | 'STONE';

export interface AdjustableRow {
  id: string;
  label: string;
  amountMinor: number;
}

/**
 * Диалог корректировки калькуляции (ТЗ п. 2.3).
 *
 * Ключевые решения:
 *
 * 1. **«Было» показывает сервер, а не диалог.** Здесь значение только для
 *    наглядности; в запрос уходит новая сумма, и сервер сам определит
 *    предыдущую из заказа. Принять «было» от клиента значило бы записать
 *    в историю сумму, которой в заказе не было.
 *
 * 2. **Причина обязательна и не предзаполняется.** Требование ТЗ: любая
 *    правка суммы после приёма объяснима. Готовый вариант в поле приводил бы
 *    к тому, что причиной становилось бы «изменение суммы».
 *
 * 3. **Показываем новую сумму заказа целиком.** Приёмщик правит строку, но
 *    клиент платит итог: последствие видно до сохранения.
 *
 * 4. **Уменьшение ниже внесённой суммы запрещено.** Это фактически возврат
 *    денег, который оформляется отдельной операцией с кассой и кассиром.
 */
export function AdjustmentDialog({
  open,
  onOpenChange,
  orderId,
  orderNo,
  totalAmountMinor,
  works,
  stones,
  paidAmountMinor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  orderNo: string;
  totalAmountMinor: number;
  works: AdjustableRow[];
  stones: AdjustableRow[];
  paidAmountMinor: number;
}): ReactNode {
  const createAdjustment = useCreateAdjustment();

  const [targetType, setTargetType] = useState<AdjustTarget>('TOTAL');
  const [targetId, setTargetId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rows = targetType === 'WORK' ? works : stones;

  useEffect(() => {
    if (!open) return;

    setTargetType('TOTAL');
    setTargetId('');
    setAmount(String(totalAmountMinor / 100).replace('.', ','));
    setReason('');
    setError(null);
  }, [open, totalAmountMinor]);

  // При смене цели подставляем её текущую сумму: чаще всего правят «на
  // сколько-то меньше», и отправной точкой должна быть реальная сумма строки.
  useEffect(() => {
    if (!open) return;

    if (targetType === 'TOTAL') {
      setTargetId('');
      setAmount(String(totalAmountMinor / 100).replace('.', ','));
      return;
    }

    const first = (targetType === 'WORK' ? works : stones)[0];
    setTargetId(first?.id ?? '');
    setAmount(first === undefined ? '' : String(first.amountMinor / 100).replace('.', ','));
  }, [targetType, open, totalAmountMinor, works, stones]);

  const amountMinor = useMemo(() => {
    if (amount.trim() === '') return null;
    return parseMoneyInput(amount);
  }, [amount]);

  const currentMinor = useMemo(() => {
    if (targetType === 'TOTAL') return totalAmountMinor;
    const row = rows.find((item) => item.id === targetId);
    return row?.amountMinor ?? 0;
  }, [targetType, totalAmountMinor, rows, targetId]);

  const belowPaid =
    amountMinor !== null && targetType === 'TOTAL' && amountMinor < paidAmountMinor;

  /** Новая сумма заказа с учётом правки — то, что в итоге заплатит клиент. */
  const newTotalMinor = useMemo(() => {
    if (amountMinor === null || targetType === 'TOTAL') return amountMinor;
    const delta = amountMinor - currentMinor;
    return Math.max(0, totalAmountMinor + delta);
  }, [amountMinor, targetType, currentMinor, totalAmountMinor]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (amountMinor === null || amountMinor < 0) {
      setError('Укажите корректную сумму');
      return;
    }
    if (targetType !== 'TOTAL' && targetId === '') {
      setError('Выберите строку калькуляции');
      return;
    }
    if (reason.trim().length < 3) {
      setError('Причина обязательна (минимум 3 символа)');
      return;
    }
    if (belowPaid) {
      setError(
        `Сумма ниже внесённой (${formatMinor(paidAmountMinor)}). Оформите возврат отдельной операцией.`,
      );
      return;
    }

    try {
      await createAdjustment.mutateAsync({
        orderId,
        targetType,
        ...(targetType === 'TOTAL' ? {} : { targetId }),
        amountAfterMinor: amountMinor,
        reason: reason.trim(),
      });
      onOpenChange(false);
    } catch {
      // Тост показывает хук мутации; диалог оставляем открытым,
      // чтобы сотрудник мог исправить данные и повторить.
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Корректировка калькуляции"
        description={`${orderNo} · итог ${formatMinorExact(totalAmountMinor)}`}
      >
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="space-y-4"
        >
          <Field label="Что корректируем" htmlFor="adjust-target" required>
            <Select
              id="adjust-target"
              value={targetType}
              onChange={(event) => setTargetType(event.target.value as AdjustTarget)}
              disabled={createAdjustment.isPending}
            >
              <option value="TOTAL">Итог заказа</option>
              <option value="WORK">Строку работ</option>
              <option value="STONE">Строку камней</option>
            </Select>
          </Field>

          {targetType !== 'TOTAL' ? (
            <Field label="Строка" htmlFor="adjust-row" required>
              <Select
                id="adjust-row"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                disabled={createAdjustment.isPending}
              >
                {rows.length === 0 ? <option value="">Нет строк</option> : null}
                {rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label} — {formatMinor(row.amountMinor)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field label="Было" htmlFor="adjust-before">
            <Input id="adjust-before" value={formatMinor(currentMinor)} readOnly disabled />
          </Field>

          <Field
            label="Стало, ₽"
            htmlFor="adjust-after"
            required
            error={belowPaid ? 'Ниже внесённой суммы' : undefined}
          >
            <Input
              id="adjust-after"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              disabled={createAdjustment.isPending}
              aria-invalid={belowPaid}
            />
          </Field>

          <Field label="Причина" htmlFor="adjust-reason" required hint="Минимум 3 символа">
            <Textarea
              id="adjust-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={createAdjustment.isPending}
              maxLength={1000}
              placeholder="Например: клиент отказался от полировки"
            />
          </Field>

          {newTotalMinor !== null ? (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
              Новый итог заказа: <span className="font-medium">{formatMinor(newTotalMinor)}</span>
              {paidAmountMinor > 0 ? (
                <> · уже внесено {formatMinor(paidAmountMinor)}</>
              ) : null}
            </p>
          ) : null}

          {error !== null ? <FormError>{error}</FormError> : null}

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" variant="secondary" disabled={createAdjustment.isPending}>
                Отмена
              </Button>
            </Dialog.Close>
            <Button
              type="submit"
              loading={createAdjustment.isPending}
              disabled={targetType !== 'TOTAL' && rows.length === 0}
            >
              {createAdjustment.isPending ? 'Сохраняем…' : 'Скорректировать'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog.Root>
  );
}
