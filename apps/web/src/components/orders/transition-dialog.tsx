'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTransition } from '@/lib/queries';
import { STATUS_LABELS, type OrderStatus } from '@app/shared';
import type { OrderDetail } from '@/lib/api-types';
import { Button } from '@/components/ui/button';
import { Field, FormError } from '@/components/ui/field';
import { DialogContent } from '@/components/ui/dialog';
import { Select, Textarea } from '@/components/ui/input';
import { t } from '@/lib/i18n';

/**
 * Диалог перевода заказа в другой статус.
 *
 * Список допустимых переходов приходит от сервера (`availableTransitions`) —
 * он учитывает и роль пользователя, и состояние заказа. Клиент не дублирует
 * матрицу прав (docs/08-ui-ux.md §1.4): она всё равно проверяется на сервере
 * повторно, поэтому расхождение здесь не создаёт уязвимости — только
 * предотвращает показ заведомо отклоняемого действия.
 */
export function TransitionDialog({
  open,
  onOpenChange,
  order,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderDetail;
}): ReactNode {
  const transition = useTransition();
  const [to, setTo] = useState<OrderStatus | ''>('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // При открытии выбираем первый доступный переход: у приёмщика обычно
  // одно очевидное действие, и лишний выбор только замедляет работу.
  useEffect(() => {
    if (open) {
      setTo(order.availableTransitions[0]?.to ?? '');
      setReason('');
      setError(null);
    }
  }, [open, order.availableTransitions]);

  const selected = order.availableTransitions.find((item) => item.to === to);
  const reasonRequired = selected?.requiresReason === true;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (to === '') {
      setError('Выберите новый статус');
      return;
    }

    if (reasonRequired && reason.trim().length === 0) {
      setError(t.transition.reasonRequired);
      return;
    }

    try {
      await transition.mutateAsync({
        orderId: order.id,
        to,
        // `version` защищает от перезаписи чужого изменения: если заказ
        // изменили между открытием и отправкой, сервер вернёт STALE_VERSION.
        version: order.version,
        reason: reason.trim() === '' ? undefined : reason.trim(),
      });
      onOpenChange(false);
    } catch {
      // Тост показывает хук; здесь оставляем диалог открытым,
      // чтобы пользователь мог исправить причину и повторить.
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t.transition.title}
        description={`${order.orderNo} · ${order.statusLabel}`}
      >
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="space-y-4"
        >
          <Field label={t.transition.to} htmlFor="transition-to" required>
            <Select
              id="transition-to"
              value={to}
              onChange={(event) => setTo(event.target.value as OrderStatus)}
              disabled={transition.isPending}
            >
              {order.availableTransitions.map((item) => (
                <option key={item.to} value={item.to}>
                  {item.label !== '' ? item.label : STATUS_LABELS[item.to]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={t.transition.reason}
            htmlFor="transition-reason"
            required={reasonRequired}
            hint={reasonRequired ? undefined : 'Необязательно'}
          >
            <Textarea
              id="transition-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={transition.isPending}
              maxLength={1000}
              aria-invalid={error !== null && reasonRequired && reason.trim() === ''}
            />
          </Field>

          {error !== null ? <FormError>{error}</FormError> : null}

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" variant="secondary" disabled={transition.isPending}>
                {t.common.cancel}
              </Button>
            </Dialog.Close>
            <Button type="submit" loading={transition.isPending}>
              {transition.isPending ? t.transition.submitting : t.transition.submit}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog.Root>
  );
}
