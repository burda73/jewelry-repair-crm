'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useOrderRollback, useRollbackStates } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FormError } from '@/components/ui/field';
import { DialogContent } from '@/components/ui/dialog';
import { Select, Textarea } from '@/components/ui/input';
import { STATUS_LABELS, type OrderStatus } from '@app/shared';

/**
 * Откат заказа до состояния из истории (инструмент администратора).
 *
 * ## Зачем это нужно
 *
 * Заказ может оказаться в состоянии, куда его привела неверная операция, и
 * вернуть его штатным путём нельзя: обратного перехода в таблице может просто не
 * быть. Откат — аварийный инструмент разбора таких случаев.
 *
 * ## Почему барьеров два
 *
 * Откат ОБХОДИТ таблицу переходов, то есть отменяет её гарантии: именно она
 * защищает от «выдали изделие, а потом вернули в работу». Поэтому причина
 * обязательна (след в документах) и требуется явное подтверждение — опасное
 * действие не должно выполняться одним нажатием.
 *
 * ## Почему список состояний приходит с сервера
 *
 * Какие состояния достижимы, зависит от текущего статуса и от того, закрыт ли
 * заказ. Своя копия правила на клиенте разошлась бы с сервером, и интерфейс
 * предлагал бы откат, который сервер отклонит.
 */
export function RollbackDialog({
  open,
  onOpenChange,
  orderId,
  orderNo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  orderNo: string;
}): ReactNode {
  const states = useRollbackStates(orderId, open);
  const rollback = useOrderRollback();

  const [toStatus, setToStatus] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setToStatus('');
    setReason('');
    setConfirmed(false);
    setError(null);
  }, [open]);

  /** Подпись статуса: берётся из домена, чтобы не дублировать словарь. */
  function label(status: string): string {
    return STATUS_LABELS[status as OrderStatus] ?? status;
  }

  const available = states.data?.states ?? [];
  const canSubmit =
    toStatus !== '' && reason.trim().length >= 3 && confirmed && !rollback.isPending;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    if (toStatus === '') {
      setError('Выберите состояние для отката');
      return;
    }
    if (reason.trim().length < 3) {
      setError('Укажите причину отката');
      return;
    }

    try {
      await rollback.mutateAsync({ orderId, toStatus, reason: reason.trim() });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось выполнить откат');
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogContent title="Откат заказа" description={orderNo}>
          {states.isLoading ? (
            <p className="text-sm text-slate-500">Загрузка…</p>
          ) : states.data?.isFinal ? (
            /*
             * Закрытый заказ: откат невозможен, и объясняем почему. Показывать
             * пустой список без объяснения значило бы выглядеть как поломка.
             */
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Заказ закрыт: откат невозможен. Выдача подтверждена подписью клиента и оплатой, отказ
              и отмена — документами.
            </p>
          ) : available.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              У заказа нет пройденных состояний, кроме текущего, — откатывать некуда.
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                void onSubmit(event);
              }}
              className="space-y-4"
            >
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Откат обходит правила переходов. Платежи, работы, согласования и документы останутся
                без изменений — они отменяются отдельными операциями.
              </p>

              <Field label="Состояние для отката" required>
                <Select
                  value={toStatus}
                  onChange={(event) => setToStatus(event.target.value)}
                  aria-invalid={error !== null && toStatus === ''}
                >
                  <option value="">— выберите —</option>
                  {available.map((status) => (
                    <option key={status} value={status}>
                      {label(status)}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Причина отката" required hint="Попадёт в историю и аудит.">
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  placeholder="например: заказ ошибочно переведён в работу"
                />
              </Field>

              {/*
                Подтверждение обязательно: действие необратимо меняет состояние
                заказа в обход правил, и одно нажатие здесь слишком дёшево.
              */}
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  Подтверждаю откат заказа в состояние «{toStatus === '' ? '—' : label(toStatus)}»
                </span>
              </label>

              {error !== null ? <FormError>{error}</FormError> : null}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                  Отмена
                </Button>
                <Button type="submit" disabled={!canSubmit}>
                  {rollback.isPending ? 'Откат…' : 'Откатить'}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
