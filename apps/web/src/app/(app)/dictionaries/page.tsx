'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useAdminPerformers,
  useAdminStoneTypes,
  useAdminStores,
  useAdminWorkCategories,
  useAdminWorkshops,
  useCreatePerformer,
  useCreateStoneType,
  useCreateStore,
  useCreateWorkCategory,
  useCreateWorkshop,
  useUpdatePerformer,
  useUpdateStoneType,
  useUpdateStore,
  useUpdateWorkCategory,
  useUpdateWorkshop,
} from '@/lib/queries';
import { describeApiError } from '@/lib/api-client';
import { formatMinor } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, EmptyState } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, FormError } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { t } from '@/lib/i18n';
import type {
  PerformerAdminInput,
  PerformerAdminItem,
  StoneTypeAdminInput,
  StoneTypeAdminItem,
  StoreAdminInput,
  StoreAdminItem,
  WorkCategoryAdminInput,
  WorkCategoryAdminItem,
  WorkshopAdminInput,
  WorkshopAdminItem,
} from '@/lib/api-types';

/**
 * Право на управление магазинами, цехами, категориями и камнями.
 * Совпадает с серверным `SETTINGS_MANAGE` (ADMIN).
 */
const SETTINGS_MANAGE = 'settings:manage';

/**
 * Право на управление исполнителями. По матрице ролей
 * (docs/02-domain-and-roles.md §4) строку «Исполнители производства» ведёт
 * менеджер производства, поэтому вкладка доступна и ему.
 */
const PERFORMER_MANAGE = 'performer:manage';

/** Вкладки экрана. Исполнители выделены: у них отдельное право. */
type Tab = 'stores' | 'workshops' | 'performers' | 'categories' | 'stones';

/**
 * Справочники: магазины, цеха, исполнители, категории работ и типы камней
 * (задача 1.3.1, docs/08-ui-ux.md §2).
 *
 * ## Удаления нет
 *
 * Кнопки «удалить» на экране нет намеренно. На магазины, цеха и исполнителей
 * ссылаются заказы, на категории — позиции прейскуранта, на типы камней —
 * строки камней в заказах. Удаление разорвало бы историю расчётов, поэтому
 * запись можно только отключить (`isActive: false`): она исчезает из выбора при
 * оформлении заказа, но остаётся в справочнике и в уже созданных документах.
 *
 * ## Отключённые записи видны администратору
 *
 * По умолчанию список показывает только активные записи, а переключатель
 * «Показывать отключённые» их добавляет. Так администратор не ищет по всему
 * списку то, что когда-то отключил, и при этом не теряет отключённое совсем.
 *
 * ## Права проверяются на сервере
 *
 * Проверки `can(...)` ниже — для удобства: сервер независимо отклоняет запросы
 * без права (`403`). Клиентская проверка нужна лишь чтобы не показывать
 * административный интерфейс тем, кому он недоступен.
 */
export default function DictionariesPage(): ReactNode {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('stores');
  const [showInactive, setShowInactive] = useState(false);

  const canSettings = can(SETTINGS_MANAGE);
  const canPerformers = can(PERFORMER_MANAGE);

  // Если прав на исполнителей нет, а вкладка открыта (например, права изменили
  // в другой вкладке), экран не должен оставаться на недоступном разделе.
  const effectiveTab: Tab = tab === 'performers' && !canPerformers ? 'stores' : tab;

  const tabs = useMemo<{ id: Tab; label: string }[]>(() => {
    const list: { id: Tab; label: string }[] = [
      { id: 'stores', label: t.dictionaries.tabStores },
      { id: 'workshops', label: t.dictionaries.tabWorkshops },
    ];
    if (canPerformers) list.push({ id: 'performers', label: t.dictionaries.tabPerformers });
    list.push(
      { id: 'categories', label: t.dictionaries.tabCategories },
      { id: 'stones', label: t.dictionaries.tabStones },
    );
    return list;
  }, [canPerformers]);

  if (!canSettings && !canPerformers) {
    return <EmptyState title={t.errors.forbidden} hint={t.dictionaries.forbidden} />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t.dictionaries.title}</h1>
        <p className="text-sm text-slate-500">{t.dictionaries.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t.dictionaries.title}>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={effectiveTab === item.id}
              onClick={() => setTab(item.id)}
              className={
                effectiveTab === item.id
                  ? 'rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700'
                  : 'rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100'
              }
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          {t.dictionaries.showInactive}
        </label>
      </div>

      {effectiveTab === 'stores' ? <StoresSection showInactive={showInactive} /> : null}
      {effectiveTab === 'workshops' ? <WorkshopsSection showInactive={showInactive} /> : null}
      {effectiveTab === 'performers' ? <PerformersSection showInactive={showInactive} /> : null}
      {effectiveTab === 'categories' ? <CategoriesSection showInactive={showInactive} /> : null}
      {effectiveTab === 'stones' ? <StonesSection showInactive={showInactive} /> : null}
    </div>
  );
}

/** Признак «отключена» — один вид на всех вкладках. */
function ActiveBadge({ isActive }: { isActive: boolean }): ReactNode {
  return (
    <Badge tone={isActive ? 'green' : 'slate'} dot>
      {isActive ? t.dictionaries.active : t.dictionaries.inactive}
    </Badge>
  );
}

/**
 * Общая оболочка раздела справочника.
 *
 * Пять разделов отличаются полями карточки, но не поведением: загрузка, пустое
 * состояние, кнопка «Добавить» и сообщения об ошибках у них одинаковы. Общая
 * оболочка гарантирует, что исправление, например, текста ошибки не придётся
 * повторять пять раз и что где-то оно не отстанет.
 */
function DictionarySection<T extends { id: string; isActive: boolean }>({
  title,
  items,
  isLoading,
  error,
  emptyHint,
  rowKey,
  renderRow,
  onCreate,
  createDisabled = false,
}: {
  title: string;
  items: T[] | undefined;
  isLoading: boolean;
  error: Error | null;
  emptyHint: string;
  rowKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  onCreate: () => void;
  createDisabled?: boolean;
}): ReactNode {
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
          <Button size="sm" variant="secondary" onClick={onCreate} disabled={createDisabled}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            {t.dictionaries.create}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t.common.loading}
          </div>
        ) : error !== null ? (
          <FormError>{describeApiError(error)}</FormError>
        ) : items === undefined || items.length === 0 ? (
          <EmptyState title={t.dictionaries.empty} hint={emptyHint} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((item) => (
              <li key={rowKey(item)} className="py-2">
                {renderRow(item)}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/** Строка списка: основное содержимое плюс кнопка правки. */
function Row({
  main,
  onEdit,
  editDisabled = false,
}: {
  main: ReactNode;
  onEdit: () => void;
  editDisabled?: boolean;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">{main}</div>
      <Button size="sm" variant="ghost" onClick={onEdit} disabled={editDisabled}>
        <Pencil className="mr-1 h-4 w-4" aria-hidden="true" />
        {t.common.edit}
      </Button>
    </div>
  );
}

/** Фильтр по активности: по умолчанию отключённые скрыты. */
function useVisible<T extends { isActive: boolean }>(
  items: T[] | undefined,
  showInactive: boolean,
): T[] | undefined {
  return useMemo(() => {
    if (items === undefined) return undefined;
    return showInactive ? items : items.filter((item) => item.isActive);
  }, [items, showInactive]);
}

// ---------------------------------------------------------------------------
// Магазины
// ---------------------------------------------------------------------------

function StoresSection({ showInactive }: { showInactive: boolean }): ReactNode {
  const { can } = useAuth();
  const { showSuccess, showError } = useToast();
  const stores = useAdminStores();
  const visible = useVisible(stores.data, showInactive);
  const create = useCreateStore();
  const update = useUpdateStore();
  const [editing, setEditing] = useState<StoreAdminItem | 'new' | null>(null);

  const canWrite = can(SETTINGS_MANAGE);

  if (!canWrite) return <EmptyState title={t.errors.forbidden} hint={t.dictionaries.forbidden} />;

  /** Записи с заказами: у них сервер запретит смену кода. */
  const isEditingExisting = editing !== null && editing !== 'new';

  return (
    <>
      <DictionarySection
        title={t.dictionaries.tabStores}
        items={visible}
        isLoading={stores.isLoading}
        error={stores.error}
        emptyHint={t.dictionaries.emptyHint}
        rowKey={(item) => item.id}
        onCreate={() => setEditing('new')}
        renderRow={(item) => (
          <Row
            main={
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{item.name}</span>
                  <Badge tone="slate">{item.code}</Badge>
                  <ActiveBadge isActive={item.isActive} />
                </div>
                <p className="text-xs text-slate-500">
                  {[item.address, item.phone, item.timezone].filter(Boolean).join(' · ')}
                </p>
              </div>
            }
            onEdit={() => setEditing(item)}
          />
        )}
      />

      {editing !== null ? (
        <StoreDialog
          store={isEditingExisting ? editing : null}
          submitting={create.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            const target = isEditingExisting ? editing : null;
            const mutation = target === null ? create : update;
            mutation.mutate(
              { id: target?.id, input },
              {
                onSuccess: () => {
                  showSuccess(target === null ? t.dictionaries.created : t.dictionaries.updated);
                  setEditing(null);
                },
                // Сообщение сервера объясняет причину отказа (например, код
                // входит в номера заказов), поэтому показываем именно его.
                onError: (error) => showError(describeApiError(error)),
              },
            );
          }}
        />
      ) : null}
    </>
  );
}

function StoreDialog({
  store,
  submitting,
  onClose,
  onSubmit,
}: {
  store: StoreAdminItem | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: StoreAdminInput & { isActive?: boolean }) => void;
}): ReactNode {
  const [code, setCode] = useState(store?.code ?? '');
  const [name, setName] = useState(store?.name ?? '');
  const [address, setAddress] = useState(store?.address ?? '');
  const [phone, setPhone] = useState(store?.phone ?? '');
  const [timezone, setTimezone] = useState(store?.timezone ?? 'Europe/Moscow');
  const [isActive, setIsActive] = useState(store?.isActive ?? true);

  const isNew = store === null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={isNew ? t.dictionaries.createTitle : t.dictionaries.editTitle}
        description={t.dictionaries.tabStores}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              code: code.trim().toUpperCase(),
              name: name.trim(),
              // Пустая строка означает «не задано», а не пустое значение:
              // иначе в базе появился бы адрес из пробелов.
              address: address.trim() === '' ? null : address.trim(),
              phone: phone.trim() === '' ? null : phone.trim(),
              timezone: timezone.trim(),
              isActive,
            });
          }}
        >
          <Field
            label={t.dictionaries.code}
            htmlFor="store-code"
            required
            hint={t.dictionaries.codeHint}
          >
            <Input
              id="store-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={20}
            />
          </Field>
          <Field label={t.dictionaries.name} htmlFor="store-name" required>
            <Input
              id="store-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label={t.dictionaries.address} htmlFor="store-address">
            <Input
              id="store-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              maxLength={300}
            />
          </Field>
          <Field label={t.dictionaries.phone} htmlFor="store-phone">
            <Input
              id="store-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={25}
            />
          </Field>
          <Field label={t.dictionaries.timezone} htmlFor="store-tz" hint="Europe/Moscow">
            <Input
              id="store-tz"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              maxLength={64}
            />
          </Field>

          {!isNew ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t.dictionaries.active}
            </label>
          ) : null}

          <DialogActions submitting={submitting} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Цеха
// ---------------------------------------------------------------------------

function WorkshopsSection({ showInactive }: { showInactive: boolean }): ReactNode {
  const { can } = useAuth();
  const { showSuccess, showError } = useToast();
  const workshops = useAdminWorkshops();
  const visible = useVisible(workshops.data, showInactive);
  const create = useCreateWorkshop();
  const update = useUpdateWorkshop();
  const [editing, setEditing] = useState<WorkshopAdminItem | 'new' | null>(null);

  if (!can(SETTINGS_MANAGE)) {
    return <EmptyState title={t.errors.forbidden} hint={t.dictionaries.forbidden} />;
  }

  const target = editing !== null && editing !== 'new' ? editing : null;

  return (
    <>
      <DictionarySection
        title={t.dictionaries.tabWorkshops}
        items={visible}
        isLoading={workshops.isLoading}
        error={workshops.error}
        emptyHint={t.dictionaries.emptyHint}
        rowKey={(item) => item.id}
        onCreate={() => setEditing('new')}
        renderRow={(item) => (
          <Row
            main={
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{item.name}</span>
                  <Badge tone="slate">{item.code}</Badge>
                  <ActiveBadge isActive={item.isActive} />
                </div>
                {item.address !== null ? (
                  <p className="text-xs text-slate-500">{item.address}</p>
                ) : null}
              </div>
            }
            onEdit={() => setEditing(item)}
          />
        )}
      />

      {editing !== null ? (
        <WorkshopDialog
          workshop={target}
          submitting={create.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            const mutation = target === null ? create : update;
            mutation.mutate(
              { id: target?.id, input },
              {
                onSuccess: () => {
                  showSuccess(target === null ? t.dictionaries.created : t.dictionaries.updated);
                  setEditing(null);
                },
                onError: (error) => showError(describeApiError(error)),
              },
            );
          }}
        />
      ) : null}
    </>
  );
}

function WorkshopDialog({
  workshop,
  submitting,
  onClose,
  onSubmit,
}: {
  workshop: WorkshopAdminItem | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: WorkshopAdminInput & { isActive?: boolean }) => void;
}): ReactNode {
  const [code, setCode] = useState(workshop?.code ?? '');
  const [name, setName] = useState(workshop?.name ?? '');
  const [address, setAddress] = useState(workshop?.address ?? '');
  const [isActive, setIsActive] = useState(workshop?.isActive ?? true);
  const isNew = workshop === null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={isNew ? t.dictionaries.createTitle : t.dictionaries.editTitle}
        description={t.dictionaries.tabWorkshops}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              code: code.trim().toUpperCase(),
              name: name.trim(),
              address: address.trim() === '' ? null : address.trim(),
              isActive,
            });
          }}
        >
          <Field
            label={t.dictionaries.code}
            htmlFor="ws-code"
            required
            hint={t.dictionaries.codeHint}
          >
            <Input
              id="ws-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={20}
            />
          </Field>
          <Field label={t.dictionaries.name} htmlFor="ws-name" required>
            <Input
              id="ws-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label={t.dictionaries.address} htmlFor="ws-address">
            <Input
              id="ws-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              maxLength={300}
            />
          </Field>

          {!isNew ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t.dictionaries.active}
            </label>
          ) : null}

          <DialogActions submitting={submitting} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Исполнители
// ---------------------------------------------------------------------------

function PerformersSection({ showInactive }: { showInactive: boolean }): ReactNode {
  const { showSuccess, showError } = useToast();
  const performers = useAdminPerformers();
  const workshops = useAdminWorkshops();
  const visible = useVisible(performers.data, showInactive);
  const create = useCreatePerformer();
  const update = useUpdatePerformer();
  const [editing, setEditing] = useState<PerformerAdminItem | 'new' | null>(null);
  const [filterWorkshop, setFilterWorkshop] = useState('');

  const filtered = useMemo(() => {
    if (visible === undefined) return undefined;
    if (filterWorkshop === '') return visible;
    return visible.filter((item) => item.workshop.id === filterWorkshop);
  }, [visible, filterWorkshop]);

  // Заводить исполнителя некуда, если нет ни одного активного цеха.
  const activeWorkshops = (workshops.data ?? []).filter((workshop) => workshop.isActive);
  const target = editing !== null && editing !== 'new' ? editing : null;

  return (
    <>
      <DictionarySection
        title={t.dictionaries.tabPerformers}
        items={filtered}
        isLoading={performers.isLoading}
        error={performers.error}
        emptyHint={t.dictionaries.emptyHint}
        rowKey={(item) => item.id}
        onCreate={() => setEditing('new')}
        createDisabled={activeWorkshops.length === 0}
        renderRow={(item) => (
          <Row
            main={
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{item.fullName}</span>
                  <ActiveBadge isActive={item.isActive} />
                </div>
                <p className="text-xs text-slate-500">
                  {[item.workshop.name, item.specialization, item.grade]
                    .filter((value): value is string => Boolean(value))
                    .join(' · ')}
                </p>
              </div>
            }
            onEdit={() => setEditing(item)}
          />
        )}
      />

      <div className="flex flex-wrap items-center gap-2 px-1">
        <label className="text-sm text-slate-600" htmlFor="performer-workshop-filter">
          {t.dictionaries.workshop}
        </label>
        <Select
          id="performer-workshop-filter"
          value={filterWorkshop}
          onChange={(event) => setFilterWorkshop(event.target.value)}
          className="max-w-xs"
        >
          <option value="">{t.common.all}</option>
          {(workshops.data ?? []).map((workshop) => (
            <option key={workshop.id} value={workshop.id}>
              {workshop.name}
            </option>
          ))}
        </Select>
      </div>

      {editing !== null ? (
        <PerformerDialog
          performer={target}
          workshops={activeWorkshops}
          submitting={create.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            const mutation = target === null ? create : update;
            mutation.mutate(
              { id: target?.id, input },
              {
                onSuccess: () => {
                  showSuccess(target === null ? t.dictionaries.created : t.dictionaries.updated);
                  setEditing(null);
                },
                onError: (error) => showError(describeApiError(error)),
              },
            );
          }}
        />
      ) : null}
    </>
  );
}

function PerformerDialog({
  performer,
  workshops,
  submitting,
  onClose,
  onSubmit,
}: {
  performer: PerformerAdminItem | null;
  workshops: WorkshopAdminItem[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: PerformerAdminInput) => void;
}): ReactNode {
  const [workshopId, setWorkshopId] = useState(performer?.workshop.id ?? workshops[0]?.id ?? '');
  const [fullName, setFullName] = useState(performer?.fullName ?? '');
  const [specialization, setSpecialization] = useState(performer?.specialization ?? '');
  const [grade, setGrade] = useState(performer?.grade ?? '');
  const [isActive, setIsActive] = useState(performer?.isActive ?? true);
  const isNew = performer === null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={isNew ? t.dictionaries.createTitle : t.dictionaries.editTitle}
        description={t.dictionaries.tabPerformers}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              workshopId,
              fullName: fullName.trim(),
              specialization: specialization.trim(),
              grade: grade.trim(),
              isActive,
            });
          }}
        >
          <Field label={t.dictionaries.workshop} htmlFor="perf-ws" required>
            <Select
              id="perf-ws"
              value={workshopId}
              onChange={(event) => setWorkshopId(event.target.value)}
              required
            >
              {workshops.map((workshop) => (
                <option key={workshop.id} value={workshop.id}>
                  {workshop.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.users.fullName} htmlFor="perf-name" required>
            <Input
              id="perf-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label={t.dictionaries.specialization} htmlFor="perf-spec">
            <Input
              id="perf-spec"
              value={specialization}
              onChange={(event) => setSpecialization(event.target.value)}
              maxLength={100}
            />
          </Field>
          <Field label={t.dictionaries.grade} htmlFor="perf-grade">
            <Input
              id="perf-grade"
              value={grade}
              onChange={(event) => setGrade(event.target.value)}
              maxLength={50}
            />
          </Field>

          {!isNew ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t.dictionaries.active}
            </label>
          ) : null}

          <DialogActions submitting={submitting} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Категории работ
// ---------------------------------------------------------------------------

function CategoriesSection({ showInactive }: { showInactive: boolean }): ReactNode {
  const { can } = useAuth();
  const { showSuccess, showError } = useToast();
  const categories = useAdminWorkCategories();
  const visible = useVisible(categories.data, showInactive);
  const create = useCreateWorkCategory();
  const update = useUpdateWorkCategory();
  const [editing, setEditing] = useState<WorkCategoryAdminItem | 'new' | null>(null);

  if (!can(SETTINGS_MANAGE)) {
    return <EmptyState title={t.errors.forbidden} hint={t.dictionaries.forbidden} />;
  }

  const target = editing !== null && editing !== 'new' ? editing : null;

  return (
    <>
      <DictionarySection
        title={t.dictionaries.tabCategories}
        items={visible}
        isLoading={categories.isLoading}
        error={categories.error}
        emptyHint={t.dictionaries.emptyHint}
        rowKey={(item) => item.id}
        onCreate={() => setEditing('new')}
        renderRow={(item) => (
          <Row
            main={
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-400">{item.sortOrder}</span>
                <span className="font-medium text-slate-900">{item.name}</span>
                <Badge tone="slate">{item.code}</Badge>
                <ActiveBadge isActive={item.isActive} />
              </div>
            }
            onEdit={() => setEditing(item)}
          />
        )}
      />

      {editing !== null ? (
        <CategoryDialog
          category={target}
          submitting={create.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            const mutation = target === null ? create : update;
            mutation.mutate(
              { id: target?.id, input },
              {
                onSuccess: () => {
                  showSuccess(target === null ? t.dictionaries.created : t.dictionaries.updated);
                  setEditing(null);
                },
                onError: (error) => showError(describeApiError(error)),
              },
            );
          }}
        />
      ) : null}
    </>
  );
}

function CategoryDialog({
  category,
  submitting,
  onClose,
  onSubmit,
}: {
  category: WorkCategoryAdminItem | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: WorkCategoryAdminInput) => void;
}): ReactNode {
  const [code, setCode] = useState(category?.code ?? '');
  const [name, setName] = useState(category?.name ?? '');
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? 0));
  const [isActive, setIsActive] = useState(category?.isActive ?? true);
  const isNew = category === null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={isNew ? t.dictionaries.createTitle : t.dictionaries.editTitle}
        description={t.dictionaries.tabCategories}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              code: code.trim().toUpperCase(),
              name: name.trim(),
              sortOrder: Number(sortOrder),
              isActive,
            });
          }}
        >
          <Field
            label={t.dictionaries.code}
            htmlFor="cat-code"
            required
            hint={t.dictionaries.codeHint}
          >
            <Input
              id="cat-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={20}
            />
          </Field>
          <Field label={t.dictionaries.name} htmlFor="cat-name" required>
            <Input
              id="cat-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label={t.dictionaries.sortOrder} htmlFor="cat-sort" hint="Меньше — выше в списке">
            <Input
              id="cat-sort"
              type="number"
              min={0}
              max={999}
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </Field>

          {!isNew ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t.dictionaries.active}
            </label>
          ) : null}

          <DialogActions submitting={submitting} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Типы камней
// ---------------------------------------------------------------------------

function StonesSection({ showInactive }: { showInactive: boolean }): ReactNode {
  const { can } = useAuth();
  const { showSuccess, showError } = useToast();
  const stones = useAdminStoneTypes();
  const visible = useVisible(stones.data, showInactive);
  const create = useCreateStoneType();
  const update = useUpdateStoneType();
  const [editing, setEditing] = useState<StoneTypeAdminItem | 'new' | null>(null);

  if (!can(SETTINGS_MANAGE)) {
    return <EmptyState title={t.errors.forbidden} hint={t.dictionaries.forbidden} />;
  }

  const target = editing !== null && editing !== 'new' ? editing : null;

  return (
    <>
      <DictionarySection
        title={t.dictionaries.tabStones}
        items={visible}
        isLoading={stones.isLoading}
        error={stones.error}
        emptyHint={t.dictionaries.emptyHint}
        rowKey={(item) => item.id}
        onCreate={() => setEditing('new')}
        renderRow={(item) => (
          <Row
            main={
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-900">{item.name}</span>
                <Badge tone="slate">{item.code}</Badge>
                <ActiveBadge isActive={item.isActive} />
                <span className="text-sm text-slate-600">
                  {formatMinor(item.priceMinor)} / {item.unit}
                </span>
              </div>
            }
            onEdit={() => setEditing(item)}
          />
        )}
      />

      {editing !== null ? (
        <StoneDialog
          stone={target}
          submitting={create.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            const mutation = target === null ? create : update;
            mutation.mutate(
              { id: target?.id, input },
              {
                onSuccess: () => {
                  showSuccess(target === null ? t.dictionaries.created : t.dictionaries.updated);
                  setEditing(null);
                },
                onError: (error) => showError(describeApiError(error)),
              },
            );
          }}
        />
      ) : null}
    </>
  );
}

function StoneDialog({
  stone,
  submitting,
  onClose,
  onSubmit,
}: {
  stone: StoneTypeAdminItem | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: StoneTypeAdminInput) => void;
}): ReactNode {
  const [code, setCode] = useState(stone?.code ?? '');
  const [name, setName] = useState(stone?.name ?? '');
  const [unit, setUnit] = useState(stone?.unit ?? 'шт');
  const [price, setPrice] = useState(stone === null ? '' : String(stone.priceMinor / 100));
  const [isActive, setIsActive] = useState(stone?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const isNew = stone === null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={isNew ? t.dictionaries.createTitle : t.dictionaries.editTitle}
        description={t.dictionaries.tabStones}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();

            // Рубли в форме, копейки в API: сервер принимает целое число
            // минорных единиц, и перевод делается здесь, а не на сервере, чтобы
            // администратор вводил привычную сумму.
            const rubles = Number(price.replace(',', '.'));
            if (!Number.isFinite(rubles) || rubles < 0) {
              setError('Укажите цену числом');
              return;
            }
            const minor = Math.round(rubles * 100);
            setError(null);

            onSubmit({
              code: code.trim().toUpperCase(),
              name: name.trim(),
              unit: unit.trim(),
              priceMinor: minor,
              isActive,
            });
          }}
        >
          <Field
            label={t.dictionaries.code}
            htmlFor="stone-code"
            required
            hint={t.dictionaries.codeHint}
          >
            <Input
              id="stone-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={20}
            />
          </Field>
          <Field label={t.dictionaries.name} htmlFor="stone-name" required>
            <Input
              id="stone-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label={t.dictionaries.unit} htmlFor="stone-unit" hint="шт, карат, грамм">
            <Input
              id="stone-unit"
              value={unit}
              onChange={(event) => setUnit(event.target.value)}
              maxLength={20}
            />
          </Field>
          <Field
            label={t.dictionaries.price}
            htmlFor="stone-price"
            required
            error={error ?? undefined}
          >
            <Input
              id="stone-price"
              type="number"
              min={0}
              step="0.01"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              required
            />
          </Field>

          {!isNew ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t.dictionaries.active}
            </label>
          ) : null}

          <DialogActions submitting={submitting} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Кнопки формы — одинаковы во всех диалогах справочника. */
function DialogActions({
  submitting,
  onClose,
}: {
  submitting: boolean;
  onClose: () => void;
}): ReactNode {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
        {t.common.cancel}
      </Button>
      <Button type="submit" loading={submitting}>
        {submitting ? t.common.saving : t.common.save}
      </Button>
    </div>
  );
}
