'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  useAddOrderWork,
  usePriceListItems,
  useRemoveOrderWork,
  useUpdateOrderWork,
} from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FormError } from '@/components/ui/field';
import { DialogContent } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { formatMinorExact } from '@/lib/format';
import { resolveItemPrice, detectMetalKind, parseMoneyInput } from '@app/shared';
import type { OrderDetail, OrderWork } from '@/lib/api-types';

/**
 * Добавление и правка видов работ в заказе (требование заказчика).
 *
 * ## Почему состав работ правится, а не только цена
 *
 * До этой формы работы можно было задать лишь при создании заказа. Дальше
 * оставалась корректировка (`calc:adjust`), которая меняет СУММУ строки, но не
 * перечень: добавить работу, которую нашли при разборке изделия, было нечем.
 * Приходилось заводить новый заказ — а он не связан с исходным ни историей, ни
 * платежами.
 *
 * ## Цену позиции прейскуранта считает СЕРВЕР
 *
 * Форма показывает цену для справки (по металлу изделия), но не отправляет её
 * для позиций прейскуранта. Причина в том, что ставка зависит от металла
 * КОНКРЕТНОГО изделия, а металл в форме может быть не распознан — тогда
 * применяется цена по умолчанию, и она отличалась бы от серверной. Отправлять
 * «примерно ту же» цену хуже, чем не отправлять её вовсе: в заказе оказалась бы
 * сумма, которой нет в прейскуранте.
 */
export function WorksEditor({
  open,
  onOpenChange,
  order,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderDetail;
}): ReactNode {
  const priceItems = usePriceListItems();
  const addWork = useAddOrderWork();
  const updateWork = useUpdateOrderWork();
  const removeWork = useRemoveOrderWork();

  const [mode, setMode] = useState<'list' | 'add' | 'edit'>('list');
  const [editing, setEditing] = useState<OrderWork | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Поля формы.
  const [priceListItemId, setPriceListItemId] = useState('');
  const [customName, setCustomName] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [quantity, setQuantity] = useState('1');
  const [customPrice, setCustomPrice] = useState('');
  const [comment, setComment] = useState('');
  const [removeReason, setRemoveReason] = useState('');
  const [removing, setRemoving] = useState<OrderWork | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('list');
    setEditing(null);
    setRemoving(null);
    setError(null);
  }, [open]);

  /** Металл первого изделия: по нему прейскурант задаёт ставку. */
  const detectedMetal = useMemo(() => {
    const metal = order.items[0]?.metal ?? null;
    return metal === null ? null : detectMetalKind(metal);
  }, [order.items]);

  /** Предпросмотр цены выбранной позиции прейскуранта. */
  const selectedPrice = useMemo(() => {
    if (priceListItemId === '') return null;
    const entry = (priceItems.data ?? []).find((item) => item.id === priceListItemId);
    if (entry === undefined) return null;
    return resolveItemPrice(entry, detectedMetal);
  }, [priceListItemId, priceItems.data, detectedMetal]);

  const quantityValue = Number(quantity);
  const quantityInvalid = !Number.isInteger(quantityValue) || quantityValue <= 0;

  function startEdit(work: OrderWork): void {
    setEditing(work);
    setMode('edit');
    setError(null);
    setQuantity(String(work.quantity));
    setCustomPrice(String(work.unitPriceMinor / 100));
    setComment(work.comment ?? '');
  }

  async function onAdd(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    if (!isCustom && priceListItemId === '') {
      setError('Выберите работу из прейскуранта или отметьте её как нетиповую');
      return;
    }
    if (isCustom && customName.trim().length < 2) {
      setError('Укажите название работы');
      return;
    }
    if (quantityInvalid) {
      setError('Количество должно быть целым положительным числом');
      return;
    }
    const priceMinor = isCustom ? parseMoneyInput(customPrice) : null;
    if (isCustom && (priceMinor === null || priceMinor < 0)) {
      setError('Укажите цену работы');
      return;
    }

    try {
      await addWork.mutateAsync({
        orderId: order.id,
        input: {
          quantity: quantityValue,
          isCustom,
          comment: comment.trim() === '' ? undefined : comment.trim(),
          ...(isCustom
            ? { name: customName.trim(), unitPriceMinor: priceMinor ?? 0 }
            : { priceListItemId }),
        },
      });
      setMode('list');
      setPriceListItemId('');
      setCustomName('');
      setCustomPrice('');
      setQuantity('1');
      setComment('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось добавить работу');
    }
  }

  async function onSaveEdit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (editing === null) return;
    setError(null);

    if (quantityInvalid) {
      setError('Количество должно быть целым положительным числом');
      return;
    }

    const priceMinor = parseMoneyInput(customPrice);
    if (priceMinor === null || priceMinor < 0) {
      setError('Укажите цену работы');
      return;
    }

    try {
      await updateWork.mutateAsync({
        orderId: order.id,
        workId: editing.id,
        input: {
          // Версия заказа: без неё правка затрёт изменения другого сотрудника.
          version: order.version,
          quantity: quantityValue,
          unitPriceMinor: priceMinor,
          comment: comment.trim() === '' ? undefined : comment.trim(),
        },
      });
      setMode('list');
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось изменить работу');
    }
  }

  async function onRemove(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (removing === null) return;
    setError(null);

    if (removeReason.trim().length < 3) {
      setError('Укажите причину удаления работы');
      return;
    }

    try {
      await removeWork.mutateAsync({
        orderId: order.id,
        workId: removing.id,
        version: order.version,
        reason: removeReason.trim(),
      });
      setRemoving(null);
      setRemoveReason('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось удалить работу');
    }
  }

  /*
   * Покрытие согласованием держим как объект-объединение и проверяем ЕГО, а не
   * отдельный булев флаг: только тогда TypeScript сужает тип, и обращения к
   * `approvedMinor`/`totalMinor` защищены от случая «согласование в порядке».
   * С флагом компилятор эти поля не видит, и ошибка в шаблоне прошла бы молча.
   */
  const coverage = order.approvalCoverage;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogContent
          title="Виды работ"
          description={`${order.orderNo} · итог ${formatMinorExact(order.totalAmountMinor)}`}
        >
          {/*
            Предупреждение о согласовании показывается в списке, а не только в
            форме добавления: менеджеру важно понимать последствие правки ДО
            того, как он её сделает.
          */}
          {coverage.ok ? null : (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {coverage.reason === 'MISSING' ? (
                <>Согласование с клиентом ещё не получено — заказ нельзя передать в работу.</>
              ) : (
                <>
                  Клиент согласовал {formatMinorExact(coverage.approvedMinor)}, а сейчас в заказе{' '}
                  {formatMinorExact(coverage.totalMinor)}. После правки работ потребуется новое
                  согласие клиента на итоговую сумму.
                </>
              )}
            </p>
          )}

          {mode === 'list' ? (
            <div className="space-y-3">
              {/* Список работ */}
              <ul className="divide-y divide-slate-100">
                {order.works.map((work) => (
                  <li key={work.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{work.name}</p>
                      <p className="text-xs text-slate-500">
                        {String(work.quantity)} {work.unit} ×{' '}
                        {formatMinorExact(work.unitPriceMinor)} ={' '}
                        {formatMinorExact(work.amountMinor)}
                        {work.code !== '' ? ` · ${work.code}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="secondary" onClick={() => startEdit(work)}>
                        Изменить
                      </Button>
                      {/*
                        Удаление блокируется, когда работа последняя: заказ без
                        работ — это заказ без согласованной суммы, и сервер такое
                        всё равно отклонит. Не показываем заведомо неуспешную кнопку.
                      */}
                      {order.works.length > 1 ? (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setRemoving(work);
                            setRemoveReason('');
                            setError(null);
                          }}
                        >
                          Удалить
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>

              {removing !== null ? (
                <form
                  onSubmit={(event) => {
                    void onRemove(event);
                  }}
                  className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3"
                >
                  <p className="text-sm text-red-800">
                    Удалить работу «{removing.name}»? Это изменит сумму заказа.
                  </p>
                  <Field label="Причина удаления" required>
                    <Input
                      value={removeReason}
                      onChange={(event) => setRemoveReason(event.target.value)}
                      placeholder="например: клиент отказался от услуги"
                    />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={() => setRemoving(null)}>
                      Отмена
                    </Button>
                    <Button type="submit" disabled={removeWork.isPending}>
                      {removeWork.isPending ? 'Удаление…' : 'Удалить'}
                    </Button>
                  </div>
                </form>
              ) : null}

              {error !== null ? <FormError>{error}</FormError> : null}

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => onOpenChange(false)}>
                  Закрыть
                </Button>
                <Button onClick={() => setMode('add')}>Добавить работу</Button>
              </div>
            </div>
          ) : null}

          {mode === 'add' ? (
            <form
              onSubmit={(event) => {
                void onAdd(event);
              }}
              className="space-y-3"
            >
              <Field label="Источник работы" required>
                <Select
                  value={isCustom ? 'custom' : priceListItemId}
                  onChange={(event) => {
                    if (event.target.value === 'custom') {
                      setIsCustom(true);
                      setPriceListItemId('');
                    } else {
                      setIsCustom(false);
                      setPriceListItemId(event.target.value);
                    }
                  }}
                >
                  <option value="">— выберите из прейскуранта —</option>
                  {(priceItems.data ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.name}
                    </option>
                  ))}
                  <option value="custom">Нетиповая работа (своя цена)</option>
                </Select>
              </Field>

              {isCustom ? (
                <>
                  <Field label="Название работы" required>
                    <Input
                      value={customName}
                      onChange={(event) => setCustomName(event.target.value)}
                      placeholder="например: пайка скрытого дефекта"
                    />
                  </Field>
                  <Field label="Цена, ₽" required>
                    <Input
                      value={customPrice}
                      onChange={(event) => setCustomPrice(event.target.value)}
                      inputMode="decimal"
                      placeholder="например 2500"
                    />
                  </Field>
                </>
              ) : null}

              {!isCustom && selectedPrice !== null ? (
                <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  Цена по прейскуранту: {formatMinorExact(selectedPrice.priceMinor)}
                  {selectedPrice.isFrom ? ' (от)' : ''}
                  {detectedMetal === null
                    ? ' — металл изделия не распознан, применена цена по умолчанию'
                    : ''}
                </p>
              ) : null}

              <Field label="Количество" required>
                <Input
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  inputMode="numeric"
                />
              </Field>

              <Field label="Комментарий" hint="Необязательно.">
                <Textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={2}
                />
              </Field>

              {error !== null ? <FormError>{error}</FormError> : null}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setMode('list')}>
                  Назад
                </Button>
                <Button type="submit" disabled={addWork.isPending}>
                  {addWork.isPending ? 'Добавление…' : 'Добавить'}
                </Button>
              </div>
            </form>
          ) : null}

          {mode === 'edit' && editing !== null ? (
            <form
              onSubmit={(event) => {
                void onSaveEdit(event);
              }}
              className="space-y-3"
            >
              <p className="text-sm text-slate-600">
                {editing.name} <span className="font-mono text-xs">{editing.code}</span>
              </p>

              <Field label="Количество" required>
                <Input
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  inputMode="numeric"
                />
              </Field>

              <Field label="Цена за единицу, ₽" required>
                <Input
                  value={customPrice}
                  onChange={(event) => setCustomPrice(event.target.value)}
                  inputMode="decimal"
                />
              </Field>

              <Field label="Комментарий" hint="Необязательно.">
                <Textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={2}
                />
              </Field>

              {error !== null ? <FormError>{error}</FormError> : null}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setMode('list')}>
                  Назад
                </Button>
                <Button type="submit" disabled={updateWork.isPending}>
                  {updateWork.isPending ? 'Сохранение…' : 'Сохранить'}
                </Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
