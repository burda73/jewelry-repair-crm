'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTransition, useUploadPickupSignature } from '@/lib/queries';
import {
  canSubmitTransition,
  needsPickupSignature,
  validateSignatureFile,
} from '@/lib/pickup-signature';
import { STATUS_LABELS, type OrderStatus } from '@app/shared';
import type { OrderDetail } from '@/lib/api-types';
import { Button } from '@/components/ui/button';
import { Field, FormError } from '@/components/ui/field';
import { DialogContent } from '@/components/ui/dialog';
import { Select, Textarea } from '@/components/ui/input';
import { t } from '@/lib/i18n';

/**
 * Предельный размер файла подписи.
 *
 * Совпадает с серверным значением по умолчанию (`UPLOAD_MAX_BYTES`,
 * `storage.service.ts`): клиентская проверка лишь избавляет от заведомо
 * обречённого запроса, сервер ограничивает размер повторно.
 */
const MAX_SIGNATURE_BYTES = 10 * 1024 * 1024;

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
  exclude = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderDetail;
  /**
   * Переходы, которые выполняются ОТДЕЛЬНЫМ действием и потому не предлагаются.
   *
   * «Работы завершены» требует записи о работе со статусом `DONE`, а её создаёт
   * приёмка (`POST /orders/:id/assignments/:assignmentId/finish`). В списке
   * переходов этот пункт — тупик: выбор всегда отвечает «Работы по заказу ещё не
   * завершены», и сотрудник не понимает, что ему сделать.
   */
  exclude?: readonly OrderStatus[];
}): ReactNode {
  const transition = useTransition();
  const uploadSignature = useUploadPickupSignature();
  const [to, setTo] = useState<OrderStatus | ''>('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [signatureFile, setSignatureFile] = useState<File | null>(null);

  /*
   * Дефект 66: переход в «Выдан» охраняется условием `PICKUP_SIGNATURE`,
   * которое проверяет уже ЗАПИСАННЫЙ идентификатор файла. Поэтому подпись
   * загружается до перехода — иначе сервер отклонил бы сам переход, и выдача
   * заказа осталась бы невыполнимой.
   */
  const hasSignature = order.pickupSignatureFileId !== null;

  // При открытии выбираем первый доступный переход: у приёмщика обычно
  // одно очевидное действие, и лишний выбор только замедляет работу.
  useEffect(() => {
    if (open) {
      setTo(options[0]?.to ?? '');
      setReason('');
      setError(null);
      setSignatureFile(null);
    }
    // `options` пересчитывается из тех же данных; зависимость по исходному
    // списку и `exclude` не даёт лишних срабатываний.
  }, [open, order.availableTransitions, exclude]);

  /*
   * Доступные переходы с учётом исключений. Считаются ОДИН раз: список нужен и
   * для выпадающего списка, и для выбора первого пункта, и для определения
   * обязательности причины. Две независимые фильтрации разошлись бы, и диалог
   * показывал бы «причина обязательна» для перехода, которого нет в списке.
   */
  const options = order.availableTransitions.filter((item) => !exclude.includes(item.to));

  const selected = options.find((item) => item.to === to);
  const reasonRequired = selected?.requiresReason === true;
  const signatureNeeded = needsPickupSignature(to, hasSignature);

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
      /*
       * Сначала файл, потом переход: guard проверяет записанный в заказ
       * идентификатор, поэтому обратный порядок гарантированно дал бы 409.
       */
      if (signatureNeeded && signatureFile !== null) {
        const check = validateSignatureFile(signatureFile, MAX_SIGNATURE_BYTES);
        if (!check.ok) {
          setError(check.message);
          return;
        }
        await uploadSignature.mutateAsync({ orderId: order.id, file: signatureFile });
      }

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
              {options.map((item) => (
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

          {signatureNeeded ? (
            <Field
              label={t.transition.signature}
              htmlFor="transition-signature"
              required
              hint={t.transition.signatureHint}
            >
              <input
                id="transition-signature"
                type="file"
                accept="image/*,application/pdf"
                onChange={(event) => setSignatureFile(event.target.files?.[0] ?? null)}
                disabled={transition.isPending || uploadSignature.isPending}
                className="block w-full min-h-[44px] rounded-md border border-neutral-300 px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5"
              />
            </Field>
          ) : null}

          {!signatureNeeded && to === 'COMPLETED' && hasSignature ? (
            <p className="text-sm text-green-700">{t.transition.signatureUploaded}</p>
          ) : null}

          {error !== null ? <FormError>{error}</FormError> : null}

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" variant="secondary" disabled={transition.isPending}>
                {t.common.cancel}
              </Button>
            </Dialog.Close>
            <Button
              type="submit"
              loading={transition.isPending || uploadSignature.isPending}
              disabled={
                !canSubmitTransition({
                  to,
                  hasSignature,
                  signatureFile,
                  signatureUploading: uploadSignature.isPending,
                })
              }
            >
              {transition.isPending || uploadSignature.isPending
                ? t.transition.submitting
                : t.transition.submit}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog.Root>
  );
}
