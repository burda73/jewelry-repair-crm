'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { BATCH_DIRECTION } from '@app/shared';
import { useAuth } from '@/lib/auth-context';
import { useCreateBatch, useStores, useWorkshops } from '@/lib/queries';
import {
  isCreateBatchValid,
  validateCreateBatch,
  type CreateBatchErrors,
  type CreateBatchForm,
} from '@/lib/batches';
import { describeApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Card, CardBody, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Field, FormError } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { t } from '@/lib/i18n';

/**
 * Создание партии (задача 7.6, дефект 58).
 *
 * ЭТАП СХЕМЫ. Партия — единственный способ передать изделия между магазином и
 * цехом: без неё заказ нельзя ни отправить в производство, ни вернуть в
 * магазин. До этого экрана партии создавались только через API, поэтому схема
 * «магазин → производство → магазин» на практике не выполнялась.
 *
 * ПОЧЕМУ ПРОВЕРКА ДУБЛИРУЕТСЯ. Сервер проверяет тело тем же
 * `createBatchSchema`, но заведомо обречённый запрос лучше не отправлять:
 * ошибка вернулась бы общим сообщением, а не рядом с полем. Клиентская
 * проверка НЕ заменяет серверную — она только избавляет от лишнего запроса.
 *
 * СОСТАВ ЗДЕСЬ НЕ ВЫБИРАЕТСЯ. Форма создаёт пустую партию, а заказы
 * подбираются в карточке: там виден состав и причины отказа по каждому
 * кандидату (`GET /batches/:id/candidates`). Выбор «на глазок» до создания не
 * показал бы, почему заказ не подходит.
 */
export default function NewBatchPage(): ReactNode {
  const router = useRouter();
  const toast = useToast();
  const { can } = useAuth();
  const allowed = can('logistics:manage');

  const stores = useStores();
  const workshops = useWorkshops();
  const createBatch = useCreateBatch();

  const [form, setForm] = useState<CreateBatchForm>({
    direction: BATCH_DIRECTION.TO_PRODUCTION,
    fromStoreId: '',
    toStoreId: '',
    toWorkshopId: '',
    plannedAt: '',
    comment: '',
  });
  const [errors, setErrors] = useState<CreateBatchErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  if (!allowed) {
    return (
      <EmptyState
        title="Раздел недоступен"
        hint="Создавать партии может сотрудник с правом на управление логистикой."
      />
    );
  }

  function update<K extends keyof CreateBatchForm>(key: K, value: CreateBatchForm[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Ошибка поля снимается при исправлении: иначе она остаётся на экране
    // после того, как пользователь уже всё поправил.
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const validation = validateCreateBatch(form);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }

    try {
      const batch = await createBatch.mutateAsync({
        direction: form.direction,
        fromStoreId: form.fromStoreId,
        ...(form.direction === BATCH_DIRECTION.TO_PRODUCTION
          ? { toWorkshopId: form.toWorkshopId }
          : { toStoreId: form.toStoreId }),
        // Плановая дата передаётся полднем: сервер хранит UTC, а дата без
        // времени в минусовой/плюсовой зоне сдвинула бы сутки.
        plannedAt: new Date(`${form.plannedAt}T12:00:00.000Z`).toISOString(),
        ...(form.comment.trim() === '' ? {} : { comment: form.comment.trim() }),
      });

      toast.showSuccess(`Партия ${batch.batchNo} создана`);
      // Сразу в карточку: следующий шаг — подобрать заказы, и возврат в список
      // заставлял бы искать только что созданную партию руками.
      router.push(`/batches/${batch.id}`);
    } catch (error: unknown) {
      setFormError(describeApiError(error));
    }
  }

  const isToProduction = form.direction === BATCH_DIRECTION.TO_PRODUCTION;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="space-y-1">
        <Link
          href="/batches"
          className="inline-flex min-h-[44px] items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="size-4" />
          {t.batches.title}
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">{t.batches.createTitle}</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t.batches.createTitle}</CardTitle>
        </CardHeader>
        <CardBody>
          <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
            <Field label={t.batches.direction} htmlFor="direction" required>
              <Select
                id="direction"
                value={form.direction}
                onChange={(event) =>
                  update('direction', event.target.value as CreateBatchForm['direction'])
                }
              >
                <option value={BATCH_DIRECTION.TO_PRODUCTION}>
                  {t.batches.directionToProduction}
                </option>
                <option value={BATCH_DIRECTION.TO_STORE}>{t.batches.directionToStore}</option>
              </Select>
            </Field>

            <Field
              label={t.batches.fromStore}
              htmlFor="from-store"
              required
              error={errors.fromStoreId}
            >
              <Select
                id="from-store"
                value={form.fromStoreId}
                onChange={(event) => update('fromStoreId', event.target.value)}
                aria-invalid={errors.fromStoreId !== undefined}
              >
                <option value="">{t.batches.choose}</option>
                {(stores.data ?? []).map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </Select>
            </Field>

            {/*
             * Поле получателя зависит от направления: партия «в цех» без цеха и
             * «в магазин» без магазина выглядит допустимой, но выполнить её
             * нельзя. Показывать оба поля сразу значило бы предлагать
             * заполнить то, что не имеет смысла.
             */}
            {isToProduction ? (
              <Field
                label={t.batches.toWorkshop}
                htmlFor="to-workshop"
                required
                error={errors.toWorkshopId}
              >
                <Select
                  id="to-workshop"
                  value={form.toWorkshopId}
                  onChange={(event) => update('toWorkshopId', event.target.value)}
                  aria-invalid={errors.toWorkshopId !== undefined}
                >
                  <option value="">{t.batches.choose}</option>
                  {(workshops.data ?? []).map((workshop) => (
                    <option key={workshop.id} value={workshop.id}>
                      {workshop.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label={t.batches.toStore} htmlFor="to-store" required error={errors.toStoreId}>
                <Select
                  id="to-store"
                  value={form.toStoreId}
                  onChange={(event) => update('toStoreId', event.target.value)}
                  aria-invalid={errors.toStoreId !== undefined}
                >
                  <option value="">{t.batches.choose}</option>
                  {(stores.data ?? []).map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field
              label={t.batches.plannedAt}
              htmlFor="planned-at"
              required
              error={errors.plannedAt}
            >
              <Input
                id="planned-at"
                type="date"
                value={form.plannedAt}
                onChange={(event) => update('plannedAt', event.target.value)}
                aria-invalid={errors.plannedAt !== undefined}
              />
            </Field>

            <Field label={t.batches.comment} htmlFor="comment" error={errors.comment}>
              <Textarea
                id="comment"
                value={form.comment}
                onChange={(event) => update('comment', event.target.value)}
                maxLength={1000}
              />
            </Field>

            {formError !== null ? <FormError>{formError}</FormError> : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                loading={createBatch.isPending}
                disabled={!isCreateBatchValid(form)}
              >
                {t.batches.save}
              </Button>
              <Button type="button" variant="secondary" onClick={() => router.push('/batches')}>
                {t.batches.cancel}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
