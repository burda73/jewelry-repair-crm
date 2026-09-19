'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  Copy,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  X,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useCreatePriceListItem,
  useCreatePriceListVersion,
  useDeactivatePriceListItem,
  usePriceListAction,
  usePriceListVersion,
  usePriceListVersions,
  useUpdatePriceListItem,
  useUpdatePriceListVersion,
  useWorkCategories,
} from '@/lib/queries';
import { describeApiError } from '@/lib/api-client';
import { formatDate, formatMinor } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, EmptyState } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, FormError } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { t } from '@/lib/i18n';
import {
  buildPriceListPeriodInput,
  describePriceListPeriodError,
  isoToDateInput,
  type PriceListPeriodPayload,
} from '@/lib/price-list-period';
import {
  PRICE_LIST_ACTION_LABELS,
  PRICE_LIST_STATUS,
  PRICE_LIST_STATUS_LABELS,
  isPriceListEditable,
  METAL_OPTIONS,
  parseMoneyInput,
  type PriceListAction,
  type PriceListStatus,
} from '@app/shared';
import type {
  PriceListItemEditor,
  PriceListItemEditorInput,
  PriceListVersionItem,
} from '@/lib/api-types';

/**
 * Вкладка «Прейскурант» (задачи 1.4.2–1.4.3).
 *
 * ## Что здесь происходит
 *
 * Прейскурант — это цены, и они меняются иначе, чем остальные справочники:
 * версия проходит путь «черновик → на утверждение → утверждена», а утверждённая
 * становится доступна только для чтения. Поэтому экран показывает не список
 * записей, а ИСТОРИЮ ВЕРСИЙ: видно, какая действует, какая ждёт утверждения и
 * какая заменена.
 *
 * ## Почему изменения идут через новую версию
 *
 * Правка утверждённой версии запрещена (`isPriceListEditable`) — по ней уже
 * посчитаны заказы. Изменение начинается копией: кнопка «Создать версию на
 * основе этой» переносит позиции вместе со ставками по металлам, и дальше
 * правится уже копия. Так цена меняется документом, а не «поверх» истории.
 *
 * ## Почему кнопки берутся из домена, а не из локальных условий
 *
 * Доступные действия считает `availablePriceListActions` из `@app/shared` —
 * та же функция, по которой сервер решает, можно ли выполнить переход. Свой
 * набор условий здесь означал бы кнопку, ведущую к отказу: интерфейс предлагал
 * бы действие, которое сервер не разрешает.
 */
export function PriceListSection(): ReactNode {
  const { can } = useAuth();
  const { showSuccess, showError } = useToast();

  const versions = usePriceListVersions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingItem, setEditingItem] = useState<PriceListItemEditor | 'new' | null>(null);

  /*
   * Права разделены по матрице ролей (docs/02-domain-and-roles.md §4):
   * администратор правит и отправляет, руководитель и главбух утверждают.
   * Обе проверки — ТОЛЬКО для удобства: сервер отклоняет запрещённое независимо,
   * причём с явной проверкой, не пропускающей администратора «по должности».
   */
  const canEdit = can('pricelist:edit');
  const canApprove = can('pricelist:approve');

  /*
   * Выбранная версия по умолчанию — действующая (`APPROVED`), иначе самая
   * свежая. Открывать экран на архивной версии было бы бесполезно: изменять
   * нужно действующие цены.
   */
  const effectiveId = useMemo(() => {
    if (selectedId !== null) return selectedId;
    const list = versions.data ?? [];
    const approved = list.find((item) => item.status === PRICE_LIST_STATUS.APPROVED);
    return approved?.id ?? list[0]?.id ?? null;
  }, [selectedId, versions.data]);

  const detail = usePriceListVersion(effectiveId);
  const selected = (versions.data ?? []).find((item) => item.id === effectiveId) ?? null;

  if (!canEdit && !canApprove) {
    return <EmptyState title={t.errors.forbidden} hint={t.dictionaries.forbidden} />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-700">{t.priceList.title}</h2>
              <p className="text-xs text-slate-500">{t.priceList.subtitle}</p>
            </div>
            {canEdit ? (
              <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
                <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                {t.priceList.newVersion}
              </Button>
            ) : null}
          </div>

          {versions.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t.common.loading}
            </div>
          ) : versions.error !== null ? (
            <FormError>{describeApiError(versions.error)}</FormError>
          ) : (versions.data ?? []).length === 0 ? (
            <EmptyState title={t.priceList.empty} hint={t.priceList.emptyHint} />
          ) : (
            <ul className="divide-y divide-slate-100">
              {(versions.data ?? []).map((version) => (
                <li key={version.id} className="py-2">
                  <VersionRow
                    version={version}
                    isSelected={version.id === effectiveId}
                    onSelect={() => setSelectedId(version.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {selected !== null ? (
        <VersionCard
          version={selected}
          canEdit={canEdit}
          canApprove={canApprove}
          items={detail.data?.items ?? []}
          isLoading={detail.isLoading}
          error={detail.error}
          onEditItem={(item) => setEditingItem(item)}
          onNewItem={() => setEditingItem('new')}
          onDone={(message) => {
            showSuccess(message);
          }}
          onError={(error) => {
            showError(describeApiError(error));
          }}
        />
      ) : null}

      {creating ? (
        <CreateVersionDialog
          onClose={() => setCreating(false)}
          onDone={(message) => {
            setCreating(false);
            showSuccess(message);
          }}
          onError={(error) => showError(describeApiError(error))}
        />
      ) : null}

      {editingItem !== null && selected !== null ? (
        <ItemDialog
          item={editingItem === 'new' ? null : editingItem}
          versionId={selected.id}
          onClose={() => setEditingItem(null)}
          onDone={(message) => {
            setEditingItem(null);
            showSuccess(message);
          }}
          onError={(error) => showError(describeApiError(error))}
        />
      ) : null}
    </div>
  );
}

/** Строка списка версий: номер, статус, магазин, число позиций. */
function VersionRow({
  version,
  isSelected,
  onSelect,
}: {
  version: PriceListVersionItem;
  isSelected: boolean;
  onSelect: () => void;
}): ReactNode {
  const status = version.status as PriceListStatus;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        isSelected
          ? 'flex w-full flex-wrap items-center justify-between gap-2 rounded-lg bg-blue-50 px-3 py-2 text-left'
          : 'flex w-full flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-50'
      }
      aria-current={isSelected}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">
          {t.priceList.version} {version.version}
        </span>
        <StatusBadge status={status} />
        <span className="text-sm text-slate-600">
          {version.store === null
            ? t.priceList.networkWide
            : `${version.store.code} — ${version.store.name}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>
          {t.priceList.items}: {version._count.items}
        </span>
        <span>
          {t.priceList.from} {formatDate(version.effectiveFrom)}
        </span>
      </div>
    </button>
  );
}

/** Цветной значок статуса: по нему администратор понимает, что можно делать. */
function StatusBadge({ status }: { status: PriceListStatus }): ReactNode {
  const tone =
    status === PRICE_LIST_STATUS.APPROVED
      ? 'green'
      : status === PRICE_LIST_STATUS.PENDING_APPROVAL
        ? 'amber'
        : status === PRICE_LIST_STATUS.REJECTED
          ? 'red'
          : 'slate';
  return <Badge tone={tone}>{PRICE_LIST_STATUS_LABELS[status] ?? status}</Badge>;
}

/** Карточка выбранной версии: действия по статусу и работа с позициями. */
function VersionCard({
  version,
  canEdit,
  canApprove,
  items,
  isLoading,
  error,
  onEditItem,
  onNewItem,
  onDone,
  onError,
}: {
  version: PriceListVersionItem;
  canEdit: boolean;
  canApprove: boolean;
  items: PriceListItemEditor[];
  isLoading: boolean;
  error: Error | null;
  onEditItem: (item: PriceListItemEditor) => void;
  onNewItem: () => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}): ReactNode {
  const action = usePriceListAction();
  const updateVersion = useUpdatePriceListVersion();
  const deactivate = useDeactivatePriceListItem();
  const status = version.status as PriceListStatus;
  const editable = isPriceListEditable(status);

  /*
   * Права на действия по статусу:
   *  * `SUBMIT`, `RESTORE_TO_DRAFT`, `COPY` — правка (`pricelist:edit`);
   *  * `APPROVE`, `REJECT`, `ARCHIVE` — утверждение (`pricelist:approve`).
   */
  const runAction = (name: PriceListAction, body?: Record<string, unknown>): void => {
    action.mutate(
      { id: version.id, action: name, body },
      {
        onSuccess: () => onDone(t.priceList.actionDone),
        onError,
      },
    );
  };

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-700">
              {t.priceList.version} {version.version}
            </h3>
            <StatusBadge status={status} />
            {version.approvedAt !== null ? (
              <span className="text-xs text-slate-500">
                {t.priceList.approvedAt} {formatDate(version.approvedAt)}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Действия показываются по правам И по статусу: сервер проверяет то же. */}
            {canEdit && status === PRICE_LIST_STATUS.DRAFT ? (
              <Button size="sm" onClick={() => runAction('SUBMIT')} disabled={action.isPending}>
                <Send className="mr-1 h-4 w-4" aria-hidden="true" />
                {PRICE_LIST_ACTION_LABELS.SUBMIT}
              </Button>
            ) : null}
            {canEdit && status === PRICE_LIST_STATUS.REJECTED ? (
              <Button size="sm" onClick={() => runAction('SUBMIT')} disabled={action.isPending}>
                <Send className="mr-1 h-4 w-4" aria-hidden="true" />
                {PRICE_LIST_ACTION_LABELS.SUBMIT}
              </Button>
            ) : null}
            {canApprove && status === PRICE_LIST_STATUS.PENDING_APPROVAL ? (
              <>
                <Button size="sm" onClick={() => runAction('APPROVE')} disabled={action.isPending}>
                  <Check className="mr-1 h-4 w-4" aria-hidden="true" />
                  {PRICE_LIST_ACTION_LABELS.APPROVE}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => runAction('REJECT', { reason: t.priceList.rejectDefaultReason })}
                  disabled={action.isPending}
                >
                  <X className="mr-1 h-4 w-4" aria-hidden="true" />
                  {PRICE_LIST_ACTION_LABELS.REJECT}
                </Button>
              </>
            ) : null}
            {canEdit && status === PRICE_LIST_STATUS.PENDING_APPROVAL ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => runAction('RESTORE_TO_DRAFT')}
                disabled={action.isPending}
              >
                <RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" />
                {PRICE_LIST_ACTION_LABELS.RESTORE_TO_DRAFT}
              </Button>
            ) : null}
            {canEdit &&
            (status === PRICE_LIST_STATUS.APPROVED || status === PRICE_LIST_STATUS.ARCHIVED) ? (
              <Button
                size="sm"
                onClick={() => runAction('COPY', { effectiveFrom: new Date().toISOString() })}
                disabled={action.isPending}
              >
                <Copy className="mr-1 h-4 w-4" aria-hidden="true" />
                {PRICE_LIST_ACTION_LABELS.COPY}
              </Button>
            ) : null}
            {canApprove && status === PRICE_LIST_STATUS.APPROVED ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => runAction('ARCHIVE')}
                disabled={action.isPending}
              >
                <Archive className="mr-1 h-4 w-4" aria-hidden="true" />
                {PRICE_LIST_ACTION_LABELS.ARCHIVE}
              </Button>
            ) : null}
          </div>
        </div>

        {editable ? null : (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {PRICE_LIST_STATUS_LABELS[status] === undefined ? '' : `${t.priceList.readOnly} `}
              {t.priceList.readOnlyHint}
            </span>
          </div>
        )}

        {version.rejectionReason !== null ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {t.priceList.rejectionReason}: {version.rejectionReason}
          </div>
        ) : null}

        {canEdit ? (
          <PriceListPeriodEditor
            version={version}
            editable={editable}
            submitting={updateVersion.isPending}
            onSave={(input) =>
              updateVersion.mutate(
                // Хук принимает `Record<string, unknown>`: полезная нагрузка уже
                // собрана типизированно в `PriceListPeriodEditor`, и здесь она
                // только передаётся на сервер.
                { id: version.id, input: { ...input } },
                { onSuccess: () => onDone(t.priceList.periodSaved), onError },
              )
            }
          />
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-slate-700">{t.priceList.positions}</h4>
          {canEdit && editable ? (
            <Button size="sm" variant="secondary" onClick={onNewItem}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              {t.dictionaries.create}
            </Button>
          ) : null}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t.common.loading}
          </div>
        ) : error !== null ? (
          <FormError>{describeApiError(error)}</FormError>
        ) : items.length === 0 ? (
          <EmptyState title={t.priceList.empty} hint={t.priceList.emptyHint} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((item) => (
              <li key={item.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{item.name}</span>
                      <Badge tone="slate">{item.code}</Badge>
                      {item.isActive ? null : <Badge tone="amber">{t.dictionaries.inactive}</Badge>}
                      {item.priceFrom ? <Badge tone="blue">{t.priceList.priceFrom}</Badge> : null}
                      {item.metalCostSeparate ? (
                        <Badge tone="amber">{t.priceList.metalSeparate}</Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-slate-600">
                      {/* Ставки показываются отдельными подписями: у золота и серебра
                          цены разные, и одна строка «цена» вводила бы в заблуждение. */}
                      {item.rates.length > 0 ? (
                        item.rates.map((rate) => (
                          <span key={rate.metal}>
                            {metalLabel(rate.metal)}: {rate.isFrom ? t.priceList.fromPrefix : ''}
                            {formatMinor(rate.priceMinor)}
                          </span>
                        ))
                      ) : (
                        <span>
                          {item.priceFrom ? t.priceList.fromPrefix : ''}
                          {formatMinor(item.priceMinor)} / {item.unit}
                        </span>
                      )}
                    </div>
                  </div>
                  {canEdit && editable && item.isActive ? (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => onEditItem(item)}>
                        <Pencil className="mr-1 h-4 w-4" aria-hidden="true" />
                        {t.common.edit}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={deactivate.isPending}
                        onClick={() => {
                          /*
                           * Удаления нет намеренно: на позицию ссылаются работы уже
                           * принятых заказов, и удаление разорвало бы историю расчётов.
                           * Поэтому позиция только отключается — исчезает из выбора
                           * при приёме, но остаётся объяснением старых сумм.
                           */
                          deactivate.mutate(item.id, {
                            onSuccess: () => onDone(t.priceList.itemDisabled),
                            onError,
                          });
                        }}
                      >
                        {t.dictionaries.disable}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/** Русское название металла по коду. `@app/shared` отдаёт подписи вместе с кодами. */
function metalLabel(metal: string): string {
  return METAL_OPTIONS.find((option) => option.value === metal)?.label ?? metal;
}

/**
 * Срок действия, комментарий и кнопка сохранения версии.
 *
 * ДО ЭТОЙ ПРАВКИ даты версии только показывались, а комментарий сохранялся
 * неявно — по потере фокуса. Администратор не видел ни кнопки сохранения, ни
 * подтверждения, и правка дат была невозможна вовсе, хотя сервер её принимает.
 */
function PriceListPeriodEditor({
  version,
  editable,
  submitting,
  onSave,
}: {
  version: PriceListVersionItem;
  editable: boolean;
  submitting: boolean;
  onSave: (input: PriceListPeriodPayload) => void;
}): ReactNode {
  const [from, setFrom] = useState(() => isoToDateInput(version.effectiveFrom));
  const [to, setTo] = useState(() =>
    version.effectiveTo === null ? '' : isoToDateInput(version.effectiveTo),
  );
  const [comment, setComment] = useState(version.comment ?? '');
  const [error, setError] = useState<string | null>(null);

  const original = {
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
  };
  const draft = { effectiveFrom: from, effectiveTo: to === '' ? null : to };

  const periodInput = buildPriceListPeriodInput(original, draft) ?? {};
  const commentChanged = comment !== (version.comment ?? '');
  const changed = Object.keys(periodInput).length > 0 || commentChanged;
  const disabled = !editable || submitting;

  const handleSave = (): void => {
    setError(null);

    const periodError = describePriceListPeriodError(draft);
    if (periodError !== null) {
      setError(periodError);
      return;
    }

    // В одном запросе: сервер применяет частичное изменение, и два отдельных
    // PATCH ради одной кнопки оставили бы версию в промежуточном состоянии,
    // если второй запрос не прошёл.
    onSave({ ...periodInput, ...(commentChanged ? { comment: comment.trim() } : {}) });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.priceList.effectiveFrom} htmlFor={`pl-from-${version.id}`} required>
          <Input
            id={`pl-from-${version.id}`}
            type="date"
            value={from}
            disabled={disabled}
            onChange={(event) => setFrom(event.target.value)}
          />
        </Field>
        <Field
          label={t.priceList.effectiveTo}
          htmlFor={`pl-to-${version.id}`}
          hint={t.priceList.effectiveToHint}
        >
          <Input
            id={`pl-to-${version.id}`}
            type="date"
            value={to}
            disabled={disabled}
            onChange={(event) => setTo(event.target.value)}
          />
        </Field>
      </div>

      <Field label={t.priceList.comment} htmlFor={`comment-${version.id}`}>
        <Input
          id={`comment-${version.id}`}
          value={comment}
          maxLength={1000}
          disabled={disabled}
          onChange={(event) => setComment(event.target.value)}
        />
      </Field>

      {error !== null ? <FormError>{error}</FormError> : null}

      <div className="flex items-center justify-end gap-3">
        <p className="text-xs text-slate-500">
          {changed ? t.users.unsavedHint : t.users.noChangesHint}
        </p>
        <Button size="sm" onClick={handleSave} loading={submitting} disabled={disabled || !changed}>
          {submitting ? t.common.saving : t.common.save}
        </Button>
      </div>
    </div>
  );
}

/** Создание новой версии с нуля. */
function CreateVersionDialog({
  onClose,
  onDone,
  onError,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}): ReactNode {
  const create = useCreatePriceListVersion();
  const [effectiveFrom, setEffectiveFrom] = useState(toDateInput(new Date()));
  const [comment, setComment] = useState('');

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent title={t.priceList.newVersion}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              {
                effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`).toISOString(),
                ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
              },
              { onSuccess: () => onDone(t.priceList.versionCreated), onError },
            );
          }}
        >
          <Field label={t.priceList.effectiveFrom} htmlFor="pl-from" required>
            <Input
              id="pl-from"
              type="date"
              required
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              disabled={create.isPending}
            />
          </Field>
          <Field label={t.priceList.comment} htmlFor="pl-comment">
            <Input
              id="pl-comment"
              value={comment}
              maxLength={1000}
              onChange={(event) => setComment(event.target.value)}
              disabled={create.isPending}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={create.isPending}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Создание и правка позиции прейскуранта. */
function ItemDialog({
  item,
  versionId,
  onClose,
  onDone,
  onError,
}: {
  item: PriceListItemEditor | null;
  versionId: string;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}): ReactNode {
  const create = useCreatePriceListItem();
  const update = useUpdatePriceListItem();
  const categories = useWorkCategories();
  const submitting = create.isPending || update.isPending;

  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [unit, setUnit] = useState(item?.unit ?? 'шт');
  const [price, setPrice] = useState(
    item === null ? '' : String(Math.round(item.priceMinor / 100)),
  );
  const [priceFrom, setPriceFrom] = useState(item?.priceFrom ?? false);
  const [metalCostSeparate, setMetalCostSeparate] = useState(item?.metalCostSeparate ?? false);
  const [warrantyMonths, setWarrantyMonths] = useState(String(item?.warrantyMonths ?? 6));
  const [requiresPrepayment, setRequiresPrepayment] = useState(item?.requiresPrepayment ?? false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Ставки по металлам. Ключ — код металла, значение — цена в рублях строкой,
   * потому что ввод идёт в рублях, а хранится в копейках. Пустое поле означает
   * «ставки нет», и это отличается от нуля: ноль — осознанная цена.
   */
  const [rates, setRates] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const option of METAL_OPTIONS) {
      const found = item?.rates.find((rate) => rate.metal === option.value);
      initial[option.value] = found === undefined ? '' : String(Math.round(found.priceMinor / 100));
    }
    return initial;
  });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent title={item === null ? t.priceList.newItem : t.priceList.editItem}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);

            const priceParsed = parseMoneyInput(price);
            if (priceParsed === null) {
              setError(t.priceList.priceInvalid);
              return;
            }

            const parsedRates: { metal: string; priceMinor: number }[] = [];
            for (const option of METAL_OPTIONS) {
              const raw = (rates[option.value] ?? '').trim();
              if (raw === '') continue;
              const minor = parseMoneyInput(raw);
              if (minor === null) {
                setError(`${option.label}: ${t.priceList.priceInvalid}`);
                return;
              }
              parsedRates.push({ metal: option.value, priceMinor: minor });
            }

            const input: PriceListItemEditorInput = {
              code: code.trim(),
              name: name.trim(),
              unit: unit.trim() === '' ? 'шт' : unit.trim(),
              priceMinor: priceParsed,
              priceFrom,
              metalCostSeparate,
              warrantyMonths: Number(warrantyMonths),
              requiresPrepayment,
              rates: parsedRates,
              ...(categoryId === '' ? {} : { categoryId }),
            };

            if (item === null) {
              create.mutate(
                { versionId, input },
                { onSuccess: () => onDone(t.priceList.itemCreated), onError },
              );
            } else {
              update.mutate(
                { itemId: item.id, input },
                { onSuccess: () => onDone(t.priceList.itemUpdated), onError },
              );
            }
          }}
        >
          {error !== null ? <FormError>{error}</FormError> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.dictionaries.code} htmlFor="item-code" required>
              <Input
                id="item-code"
                required
                value={code}
                maxLength={50}
                onChange={(event) => setCode(event.target.value)}
                disabled={submitting}
              />
            </Field>
            <Field label={t.dictionaries.name} htmlFor="item-name" required>
              <Input
                id="item-name"
                required
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                disabled={submitting}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.dictionaries.tabCategories} htmlFor="item-category">
              <Select
                id="item-category"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                disabled={submitting}
              >
                <option value="">{t.priceList.noCategory}</option>
                {(categories.data ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.dictionaries.unit} htmlFor="item-unit">
              <Input
                id="item-unit"
                value={unit}
                maxLength={20}
                onChange={(event) => setUnit(event.target.value)}
                disabled={submitting}
              />
            </Field>
          </div>

          <Field
            label={t.priceList.basePrice}
            htmlFor="item-price"
            required
            hint={t.priceList.basePriceHint}
          >
            <Input
              id="item-price"
              required
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              disabled={submitting}
            />
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-700">
              {t.priceList.ratesByMetal}
            </legend>
            <p className="text-xs text-slate-500">{t.priceList.ratesHint}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {METAL_OPTIONS.map((option) => (
                <Field key={option.value} label={option.label} htmlFor={`rate-${option.value}`}>
                  <Input
                    id={`rate-${option.value}`}
                    inputMode="decimal"
                    value={rates[option.value] ?? ''}
                    placeholder={t.priceList.rateEmpty}
                    onChange={(event) =>
                      setRates((current) => ({ ...current, [option.value]: event.target.value }))
                    }
                    disabled={submitting}
                  />
                </Field>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <Checkbox
              id="item-price-from"
              checked={priceFrom}
              onChange={setPriceFrom}
              disabled={submitting}
              label={t.priceList.priceFromLabel}
            />
            <Checkbox
              id="item-metal-separate"
              checked={metalCostSeparate}
              onChange={setMetalCostSeparate}
              disabled={submitting}
              label={t.priceList.metalSeparateLabel}
            />
            <Checkbox
              id="item-prepayment"
              checked={requiresPrepayment}
              onChange={setRequiresPrepayment}
              disabled={submitting}
              label={t.priceList.requiresPrepayment}
            />
          </div>

          <Field label={t.priceList.warrantyMonths} htmlFor="item-warranty">
            <Input
              id="item-warranty"
              inputMode="numeric"
              value={warrantyMonths}
              onChange={(event) => setWarrantyMonths(event.target.value)}
              disabled={submitting}
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={submitting}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Флажок с подписью справа. */
function Checkbox({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  label: string;
}): ReactNode {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-slate-700">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-slate-300"
      />
      {label}
    </label>
  );
}

/** Дата в формате `input[type=date]` (ГГГГ-ММ-ДД) в UTC. */
function toDateInput(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}
