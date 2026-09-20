'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAssignPerformer, usePerformers } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FormError } from '@/components/ui/field';
import { DialogContent } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { formatMinorExact } from '@/lib/format';
import type { OrderDetail } from '@/lib/api-types';

/**
 * Выдать работу исполнителю производства (задача 7.2).
 *
 * ## Зачем этот диалог
 *
 * Маршрут выдачи работы существовал на сервере, но в интерфейсе его не было
 * НИЧЕМ — ни кнопки, ни вкладки. Заказчик сообщил об этом как «нет возможности
 * указать исполнителя». Последствие серьёзнее отсутствующей кнопки: переход
 * «Выдано в работу» охраняется наличием исполнителя, поэтому без этого диалога
 * заказ физически не мог попасть в работу — цепочка обрывалась на «Принят
 * цехом».
 *
 * ## Почему согласование проверяется ЗДЕСЬ, а не только на сервере
 *
 * Сервер обязан отказать — и отказывает. Но узнать об этом после нажатия
 * «Выдать» неприятно: менеджер уже выбрал ювелира и потратил время. Поэтому
 * расхождение суммы с согласованной видно ДО отправки, вместе с суммой, на
 * которую нужно получить согласие. Проверка идёт общей доменной функцией
 * `checkApprovalCoverage` — той же, что применяет сервер, поэтому интерфейс не
 * может «разрешить» то, что сервер запретит.
 */
export function AssignPerformerDialog({
  open,
  onOpenChange,
  order,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderDetail;
}): ReactNode {
  const assign = useAssignPerformer();
  const workshopId = order.workshop?.id;
  const performers = usePerformers(workshopId);

  const [performerId, setPerformerId] = useState('');
  const [plannedHours, setPlannedHours] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPerformerId('');
    setPlannedHours('');
    setComment('');
    setError(null);
  }, [open]);

  /*
   * Покрытие согласованием приходит с СЕРВЕРА, а не считается здесь.
   *
   * Проверку выполняет та же доменная функция, что и guard перехода в работу,
   * поэтому интерфейс не может «разрешить» то, что сервер запретит. Своя копия
   * проверки разошлась бы с сервером при первой правке правил — и разошлась бы
   * молча.
   */
  const coverage = order.approvalCoverage;

  /** Часы: пусто — «не указано», иначе целое положительное число. */
  const hoursValue = plannedHours.trim() === '' ? undefined : Number(plannedHours);
  const hoursInvalid =
    hoursValue !== undefined && (!Number.isInteger(hoursValue) || hoursValue <= 0);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    if (performerId === '') {
      setError('Выберите исполнителя');
      return;
    }
    if (hoursInvalid) {
      setError('Плановые часы — целое положительное число');
      return;
    }

    try {
      await assign.mutateAsync({
        orderId: order.id,
        performerId,
        plannedHours: hoursValue,
        comment: comment.trim() === '' ? undefined : comment.trim(),
      });
      onOpenChange(false);
    } catch (caught) {
      // Текст ошибки сервера показываем как есть: он объясняет причину
      // (например, что согласование устарело), и переписать его своими словами
      // значило бы потерять подробности вроде разницы сумм.
      setError(caught instanceof Error ? caught.message : 'Не удалось выдать работу');
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogContent
          title="Выдать работу исполнителю"
          description={`${order.orderNo} · ${formatMinorExact(order.totalAmountMinor)}`}
        >
          <form
            onSubmit={(event) => {
              void onSubmit(event);
            }}
            className="space-y-4"
          >
            {/*
              Предупреждение о согласовании стоит ПЕРВЫМ и блокирует отправку.
              Если показать его после выбора исполнителя, менеджер потратит
              время на выбор, который сервер всё равно отклонит.
            */}
            {!coverage.ok ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {coverage.reason === 'MISSING' ? (
                  <>
                    Согласование с клиентом отсутствует. Заказ нельзя передать в работу, пока клиент
                    не подтвердит сумму {formatMinorExact(order.totalAmountMinor)}.
                  </>
                ) : (
                  <>
                    Согласование устарело: клиент подтвердил{' '}
                    {formatMinorExact(coverage.approvedMinor)}, а сейчас в заказе{' '}
                    {formatMinorExact(coverage.totalMinor)}. Получите согласие клиента на новую
                    сумму — без этого заказ в работу не уйдёт.
                  </>
                )}
              </p>
            ) : null}

            <Field label="Исполнитель" required>
              {performers.isLoading ? (
                <p className="text-sm text-slate-500">Загрузка…</p>
              ) : (
                <Select
                  value={performerId}
                  onChange={(event) => setPerformerId(event.target.value)}
                  disabled={!coverage.ok}
                >
                  <option value="">— выберите —</option>
                  {(performers.data ?? []).map((performer) => (
                    <option key={performer.id} value={performer.id}>
                      {performer.fullName}
                      {performer.specialization !== null ? ` · ${performer.specialization}` : ''}
                      {` · ${performer.workshop.name}`}
                    </option>
                  ))}
                </Select>
              )}
              {/*
                Пустой список объясняем словами: иначе это выглядит как поломка
                формы, а на самом деле в цехе просто нет заведённых ювелиров.
              */}
              {!performers.isLoading && (performers.data?.length ?? 0) === 0 ? (
                <p className="mt-1 text-xs text-amber-700">
                  Нет активных исполнителей
                  {order.workshop !== null ? ` в цехе «${order.workshop.name}»` : ''}. Заведите их в
                  справочнике «Исполнители».
                </p>
              ) : null}
            </Field>

            <Field
              label="Плановые часы"
              hint="Необязательно. Норматив изготовления, если известен."
            >
              <Input
                value={plannedHours}
                onChange={(event) => setPlannedHours(event.target.value)}
                inputMode="numeric"
                placeholder="например 6"
                disabled={!coverage.ok}
              />
            </Field>

            <Field label="Комментарий" hint="Необязательно. Виден в истории заказа.">
              <Textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={2}
                disabled={!coverage.ok}
              />
            </Field>

            {error !== null ? <FormError>{error}</FormError> : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={!coverage.ok || assign.isPending}>
                {assign.isPending ? 'Выдача…' : 'Выдать работу'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
