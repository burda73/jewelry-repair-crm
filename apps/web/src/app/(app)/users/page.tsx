'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { KeyRound, Loader2, Plus, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useAssignRole,
  useCreateUser,
  useResetUserPassword,
  useRevokeRole,
  useRolesCatalog,
  useStores,
  useUpdateUser,
  useUser,
  useUsers,
  userKeys,
} from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { describeApiError } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, EmptyState } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, FormError } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { t } from '@/lib/i18n';
import type { UserFilters, UserListItem } from '@/lib/api-types';
import { generatePassword } from '@app/shared';
import {
  buildUserUpdateInput,
  describeUserDraftError,
  isPasswordReady,
  passwordPolicyViolations,
  shouldExplainPassword,
  userEditDraft,
  type UserEditDraft,
} from '@/lib/user-edit';

/** Право, без которого экран недоступен (совпадает с серверным `user:manage`). */
const USER_MANAGE = 'user:manage';

/** Роли, которым нужен магазин: без него область видимости не построить. */
const ROLES_NEEDING_STORE = ['RECEIVER', 'CASHIER'];

/**
 * Управление сотрудниками: учётные записи, роли и доступ к магазинам
 * (задача 1.2.4, docs/07-api-spec.md §13).
 *
 * Экран доступен только при праве `user:manage`, которое по матрице ролей есть
 * у ADMIN. Это проверка для удобства: сервер независимо отклоняет запросы без
 * права (`403`), и клиентская проверка нужна лишь чтобы не показывать
 * административный интерфейс тем, кому он всё равно недоступен.
 *
 * Пароль сотрудника показывается администратору один раз — в момент задания.
 * Дальше его негде посмотреть: сервер хранит только хеш Argon2id и не отдаёт
 * его ни в одном ответе. Поэтому после создания пароль показывается в
 * отдельной плашке с просьбой передать его лично.
 */
export default function UsersPage(): ReactNode {
  const { can, user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();

  const [filters, setFilters] = useState<UserFilters>({});
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Отбор с задержкой не нужен: список сотрудников мал (десятки записей), и
  // лишняя сложность с debounce здесь только мешала бы.
  const activeFilters = useMemo<UserFilters>(
    () => ({ ...filters, ...(search.trim() === '' ? {} : { q: search.trim() }) }),
    [filters, search],
  );

  const users = useUsers(activeFilters);
  const catalog = useRolesCatalog();
  const updateUser = useUpdateUser();
  const resetPassword = useResetUserPassword();

  if (!can(USER_MANAGE)) {
    return <EmptyState title={t.errors.forbidden} hint={t.users.forbidden} />;
  }

  /** Включить или отключить сотрудника: отключение завершает его сессии. */
  const toggleActive = (user: UserListItem): void => {
    if (user.isActive && user.id === currentUser?.id) {
      // Ту же проверку делает сервер; здесь она даёт понятное объяснение
      // вместо отказа после запроса.
      showError(t.users.selfDisable);
      return;
    }
    if (user.isActive && !window.confirm(t.users.disableConfirm)) return;

    updateUser.mutate(
      { id: user.id, input: { isActive: !user.isActive } },
      {
        onSuccess: () => showSuccess(t.users.updated),
        // Ответ сервера информативнее общей формулировки: он объясняет, что
        // именно не так (например, `LAST_ROLE` при снятии роли).
        onError: (error) => showError(describeApiError(error)),
      },
    );
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t.users.title}</h1>
          <p className="text-sm text-slate-500">{t.users.subtitle}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {t.users.create}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t.users.search}
          aria-label={t.users.search}
          className="max-w-xs"
        />
        <Select
          aria-label={t.users.filterActive}
          value={filters.isActive ?? ''}
          onChange={(event) =>
            setFilters((prev) => ({
              ...prev,
              isActive: event.target.value === '' ? undefined : event.target.value,
            }))
          }
          className="max-w-xs"
        >
          <option value="">{t.users.filterActive}</option>
          <option value="true">{t.users.filterActiveOnly}</option>
          <option value="false">{t.users.filterInactiveOnly}</option>
        </Select>
        <Select
          aria-label={t.users.role}
          value={filters.role ?? ''}
          onChange={(event) =>
            setFilters((prev) => ({
              ...prev,
              role: event.target.value === '' ? undefined : event.target.value,
            }))
          }
          className="max-w-xs"
        >
          <option value="">{t.users.filterActive}</option>
          {(catalog.data?.roles ?? []).map((role) => (
            <option key={role.code} value={role.code}>
              {role.label}
            </option>
          ))}
        </Select>
      </div>

      {users.isLoading ? (
        <p className="py-8 text-center text-sm text-slate-500">
          <Loader2 className="inline h-4 w-4 animate-spin" aria-hidden="true" /> {t.common.loading}
        </p>
      ) : users.isError ? (
        <FormError>{t.users.loadError}</FormError>
      ) : (users.data ?? []).length === 0 ? (
        <Card>
          <EmptyState title={t.users.empty} hint={t.users.emptyHint} />
        </Card>
      ) : (
        <ul className="space-y-2">
          {(users.data ?? []).map((user) => (
            <li key={user.id}>
              <Card>
                <CardBody className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{user.fullName}</span>
                      <Badge tone={user.isActive ? 'green' : 'slate'} dot>
                        {user.isActive ? t.users.active : t.users.inactive}
                      </Badge>
                      {user.mustChangePassword ? (
                        <Badge tone="amber">{t.users.mustChange}</Badge>
                      ) : null}
                      {user.lockedUntil !== null ? (
                        <Badge tone="red">{t.users.locked}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{user.email}</p>
                    <p className="mt-1 flex flex-wrap gap-1">
                      {user.roles.length === 0 ? (
                        <span className="text-xs text-red-600">{t.users.noRoles}</span>
                      ) : (
                        user.roles.map((role) => (
                          <Badge key={role.id} tone="blue">
                            {role.roleLabel}
                            {role.storeName === null ? '' : ` · ${role.storeName}`}
                          </Badge>
                        ))
                      )}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {t.users.lastLogin}:{' '}
                      {user.lastLoginAt === null ? t.users.never : formatDate(user.lastLoginAt)} ·{' '}
                      {t.users.sessions}: {user.activeSessions}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="secondary" onClick={() => setSelectedId(user.id)}>
                      {t.common.edit}
                    </Button>
                    <Button
                      variant={user.isActive ? 'danger' : 'secondary'}
                      onClick={() => toggleActive(user)}
                      disabled={updateUser.isPending}
                    >
                      {user.isActive ? t.users.disabled : t.users.enabled}
                    </Button>
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {createOpen ? (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void queryClient.invalidateQueries({ queryKey: userKeys.all });
          }}
        />
      ) : null}

      {selectedId !== null ? (
        <UserDetailDialog
          userId={selectedId}
          onClose={() => setSelectedId(null)}
          onResetPassword={(id, newPassword) =>
            resetPassword.mutate(
              { id, newPassword },
              {
                onSuccess: () => {
                  showSuccess(t.users.resetDone);
                  void queryClient.invalidateQueries({ queryKey: userKeys.all });
                },
                onError: (error) => showError(describeApiError(error)),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

/**
 * Диалог создания сотрудника.
 *
 * Пароль генерируется на клиенте и показывается один раз: сервер хранит только
 * хеш, поэтому «посмотреть потом» его нельзя. Кнопка копирования избавляет от
 * перепечатывания пароля вручную — иначе администратор выбирал бы простой
 * пароль, который легко набрать.
 */
function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): ReactNode {
  // Здесь только `showSuccess`: ошибки создания показываются в самой форме
  // (`setError`), рядом с полями, — всплывающее уведомление уводило бы
  // внимание от того поля, которое нужно исправить.
  const { showSuccess } = useToast();
  const catalog = useRolesCatalog();
  const stores = useStores();
  const createUser = useCreateUser();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [role, setRole] = useState('');
  const [storeId, setStoreId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);

  const needsStore = ROLES_NEEDING_STORE.includes(role);

  const submit = (): void => {
    setError(null);

    if (role === '') {
      setError(t.users.role);
      return;
    }
    // Роль с привязкой к магазину без магазина бессмысленна: сервер отклонит
    // запрос, но объяснить это до отправки понятнее.
    if (needsStore && storeId === '') {
      setError(t.users.storeRequired);
      return;
    }

    createUser.mutate(
      {
        email: email.trim(),
        fullName: fullName.trim(),
        ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
        password,
        roles: [{ role, ...(storeId === '' ? {} : { storeId }) }],
        storeIds: storeId === '' ? [] : [storeId],
      },
      {
        onSuccess: () => {
          onCreated();
          // Показываем пароль вместо закрытия: после закрытия его негде взять.
          setCreatedPassword(password);
          showSuccess(t.users.created);
        },
        onError: (err) => setError(describeApiError(err)),
      },
    );
  };

  if (createdPassword !== null) {
    return (
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent title={t.users.created}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">{t.users.passwordHint}</p>
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-xs font-medium text-amber-900">{t.users.password}</p>
              <p className="mt-1 font-mono text-sm break-all text-amber-900">{createdPassword}</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={onClose}>{t.common.close}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent title={t.users.createTitle}>
        <div className="space-y-3">
          <Field label={t.users.fullName} htmlFor="nu-name" required>
            <Input
              id="nu-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label={t.users.email} htmlFor="nu-email" required>
            <Input
              id="nu-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label={t.users.phone} htmlFor="nu-phone">
            <Input
              id="nu-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label={t.users.password} htmlFor="nu-pass" hint={t.users.passwordHint} required>
            <div className="flex gap-2">
              <Input
                id="nu-pass"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
              <Button variant="secondary" onClick={() => setPassword(generatePassword())}>
                {t.common.refresh}
              </Button>
            </div>
          </Field>
          <Field label={t.users.role} htmlFor="nu-role" required>
            <Select id="nu-role" value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="">—</option>
              {(catalog.data?.roles ?? []).map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t.users.store}
            htmlFor="nu-store"
            required={needsStore}
            hint={needsStore ? undefined : t.users.storeRequired}
          >
            <Select
              id="nu-store"
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
            >
              <option value="">—</option>
              {(stores.data ?? []).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.code} · {store.name}
                </option>
              ))}
            </Select>
          </Field>

          {role !== '' ? (
            <p className="text-xs text-slate-500">
              {t.users.permissions}:{' '}
              {(catalog.data?.roles ?? [])
                .find((entry) => entry.code === role)
                ?.permissions.slice(0, 6)
                .join(', ') ?? ''}
            </p>
          ) : null}

          {error !== null ? <FormError>{error}</FormError> : null}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button onClick={submit} disabled={createUser.isPending}>
              {createUser.isPending ? t.common.saving : t.users.create}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Карточка сотрудника: роли, магазины, сброс пароля.
 *
 * Роли показываются с магазином, потому что одна и та же роль может быть
 * назначена в нескольких магазинах, и снимать нужно конкретное назначение.
 */
function UserDetailDialog({
  userId,
  onClose,
  onResetPassword,
}: {
  userId: string;
  onClose: () => void;
  onResetPassword: (id: string, newPassword: string) => void;
}): ReactNode {
  const { showSuccess, showError } = useToast();
  const { data: user, isLoading } = useUser(userId);
  const catalog = useRolesCatalog();
  const stores = useStores();
  const assignRole = useAssignRole();
  const revokeRole = useRevokeRole();
  const updateUser = useUpdateUser();

  const [newRole, setNewRole] = useState('');
  const [newRoleStore, setNewRoleStore] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [draft, setDraft] = useState<UserEditDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const needsStore = ROLES_NEEDING_STORE.includes(newRole);

  /**
   * Исходные значения полей карточки.
   *
   * Черновик инициализируется по ним один раз и дальше живёт своей жизнью:
   * если бы поля читались прямо из `user`, очередной ответ сервера затирал бы
   * уже введённый текст.
   */
  const original =
    user === undefined
      ? null
      : {
          fullName: user.fullName,
          email: user.email,
          phone: user.phone,
          isActive: user.isActive,
          storeIds: user.stores.map((store) => store.id),
        };

  const value = draft ?? (original === null ? null : userEditDraft(original));
  const changed =
    original !== null && value !== null && buildUserUpdateInput(original, value) !== null;

  const handleResetPassword = (): void => {
    if (!isPasswordReady(newPassword)) {
      showError(t.users.passwordPolicy);
      return;
    }
    onResetPassword(userId, newPassword);
    setNewPassword('');
  };

  const handleSave = (): void => {
    if (original === null || value === null) return;
    setFormError(null);

    const draftError = describeUserDraftError(value);
    if (draftError !== null) {
      setFormError(draftError);
      return;
    }

    const payload = buildUserUpdateInput(original, value);
    if (payload === null) {
      // Изменений нет: закрываем карточку без запроса. Пустой `PATCH` вернул бы
      // `200`, но записал бы в журнал аудита правку, которой не было.
      onClose();
      return;
    }

    updateUser.mutate(
      { id: userId, input: payload },
      {
        onSuccess: () => {
          showSuccess(t.users.updated);
          onClose();
        },
        onError: (error) => setFormError(describeApiError(error)),
      },
    );
  };

  const handleAssign = (): void => {
    if (newRole === '') return;
    if (needsStore && newRoleStore === '') {
      showError(t.users.storeRequired);
      return;
    }
    assignRole.mutate(
      {
        id: userId,
        role: newRole,
        ...(newRoleStore === '' ? {} : { storeId: newRoleStore }),
      },
      {
        onSuccess: () => {
          showSuccess(t.users.roleAssigned);
          setNewRole('');
          setNewRoleStore('');
        },
        onError: (error) => showError(describeApiError(error)),
      },
    );
  };

  const handleRevoke = (roleId: string, label: string): void => {
    if (!window.confirm(t.users.revokeConfirm.replace('{role}', label))) return;
    revokeRole.mutate(
      { id: userId, roleId },
      {
        onSuccess: () => showSuccess(t.users.roleRevoked),
        onError: (error) => showError(describeApiError(error)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent title={user?.fullName ?? t.common.loading}>
        {isLoading || user === undefined || original === null || value === null ? (
          <p className="py-6 text-center text-sm text-slate-500">
            <Loader2 className="inline h-4 w-4 animate-spin" aria-hidden="true" />{' '}
            {t.common.loading}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3">
              <Field label={t.users.fullName} htmlFor="ud-name" required>
                <Input
                  id="ud-name"
                  value={value.fullName}
                  onChange={(event) => setDraft({ ...value, fullName: event.target.value })}
                  disabled={updateUser.isPending}
                  maxLength={200}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t.users.email} htmlFor="ud-email" required>
                  <Input
                    id="ud-email"
                    type="email"
                    value={value.email}
                    onChange={(event) => setDraft({ ...value, email: event.target.value })}
                    disabled={updateUser.isPending}
                    autoComplete="off"
                  />
                </Field>
                <Field label={t.users.phone} htmlFor="ud-phone" hint={t.users.phoneHint}>
                  <Input
                    id="ud-phone"
                    value={value.phone}
                    onChange={(event) => setDraft({ ...value, phone: event.target.value })}
                    disabled={updateUser.isPending}
                    maxLength={25}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={value.isActive}
                  onChange={(event) => setDraft({ ...value, isActive: event.target.checked })}
                  disabled={updateUser.isPending}
                  className="h-4 w-4 rounded border-slate-300"
                />
                {t.users.active}
              </label>
              <p className="text-xs text-slate-500">
                {t.users.lastLogin}:{' '}
                {user.lastLoginAt === null ? t.users.never : formatDate(user.lastLoginAt)} ·{' '}
                {t.users.sessions}: {user.activeSessions}
              </p>
            </div>

            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">{t.users.roles}</p>
              {user.roles.length === 0 ? (
                <p className="text-xs text-red-600">{t.users.noRoles}</p>
              ) : (
                <ul className="space-y-1">
                  {user.roles.map((role) => (
                    <li
                      key={role.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <span className="text-sm">
                        <span className="font-medium">{role.roleLabel}</span>
                        {role.storeName === null ? null : (
                          <span className="text-slate-500"> · {role.storeName}</span>
                        )}
                        <span className="block text-xs text-slate-500">{role.scopeLabel}</span>
                      </span>
                      <Button
                        variant="ghost"
                        onClick={() => handleRevoke(role.id, role.roleLabel)}
                        disabled={revokeRole.isPending}
                        aria-label={`${t.users.revoke}: ${role.roleLabel}`}
                      >
                        <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                        {t.users.revoke}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-sm font-medium text-slate-700">{t.users.addRole}</p>
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label={t.users.role}
                  value={newRole}
                  onChange={(event) => setNewRole(event.target.value)}
                  className="max-w-xs"
                >
                  <option value="">—</option>
                  {(catalog.data?.roles ?? [])
                    // Уже назначенные роли в списке не нужны: повторное
                    // назначение сервер отклонит как `ROLE_ALREADY_ASSIGNED`.
                    .filter((entry) => !user.roles.some((existing) => existing.role === entry.code))
                    .map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {entry.label}
                      </option>
                    ))}
                </Select>
                <Select
                  aria-label={t.users.store}
                  value={newRoleStore}
                  onChange={(event) => setNewRoleStore(event.target.value)}
                  className="max-w-xs"
                >
                  <option value="">—</option>
                  {(stores.data ?? []).map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.code} · {store.name}
                    </option>
                  ))}
                </Select>
                <Button onClick={handleAssign} disabled={assignRole.isPending || newRole === ''}>
                  {t.users.addRole}
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                {t.users.resetPassword}
              </p>
              <p className="mb-2 text-xs text-slate-500">{t.users.resetHint}</p>
              <div className="flex flex-wrap items-start gap-2">
                <div className="space-y-1">
                  <Input
                    type="text"
                    aria-label={t.users.password}
                    placeholder={t.users.password}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    className="max-w-xs"
                    autoComplete="new-password"
                  />
                  {/* Причина неактивности называется явно: кнопка без объяснения
                      читается как отсутствующая возможность. */}
                  {shouldExplainPassword(newPassword) ? (
                    <p className="text-xs text-amber-700">
                      {t.users.passwordPolicy}:{' '}
                      {passwordPolicyViolations(newPassword)
                        .map((code) => t.users.passwordRules[code])
                        .join(', ')}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">{t.users.passwordHint}</p>
                  )}
                </div>
                <Button
                  variant="secondary"
                  onClick={() => setNewPassword(generatePassword())}
                  disabled={updateUser.isPending}
                >
                  {t.common.refresh}
                </Button>
                <Button
                  variant="danger"
                  disabled={!isPasswordReady(newPassword) || updateUser.isPending}
                  onClick={handleResetPassword}
                >
                  {t.users.resetPassword}
                </Button>
              </div>
            </div>

            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                {t.users.permissions}
              </p>
              {user.permissions.length === 0 ? (
                <p className="text-xs text-slate-500">{t.users.noPermissions}</p>
              ) : (
                <p className="flex flex-wrap gap-1">
                  {user.permissions.map((permission) => (
                    <Badge key={permission} tone="slate">
                      {permission}
                    </Badge>
                  ))}
                </p>
              )}
            </div>

            {formError !== null ? <FormError>{formError}</FormError> : null}

            {/*
              Отключение учётной записи раньше было отдельной кнопкой с
              немедленным действием. Теперь это флажок «Активна» выше: два
              способа сделать одно и то же различались бы только тем, что один
              из них срабатывает до нажатия «Сохранить».
            */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <p className="text-xs text-slate-500">
                {changed ? t.users.unsavedHint : t.users.noChangesHint}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" onClick={onClose} disabled={updateUser.isPending}>
                  {t.common.cancel}
                </Button>
                <Button onClick={handleSave} loading={updateUser.isPending} disabled={!changed}>
                  {updateUser.isPending ? t.common.saving : t.common.save}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
