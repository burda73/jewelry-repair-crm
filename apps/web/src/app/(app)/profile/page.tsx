'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ROLE_LABELS, type RoleCode, PERMISSION } from '@app/shared';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

/**
 * Профиль: кто вошёл, с какими ролями и правами.
 *
 * Список прав показывается намеренно: это инструмент диагностики, когда
 * сотрудник не видит нужную кнопку. Он видит, какого права не хватает,
 * и обращается к администратору с конкретным запросом, а не с «не работает».
 */
export default function ProfilePage(): ReactNode {
  const { user, logout } = useAuth();

  if (user === null) return null;

  const permissionLabels: Record<string, string> = {
    'order:create': 'Создание заказов',
    'order:read': 'Просмотр заказов',
    'order:update': 'Изменение заказов',
    'order:transition': 'Перевод статусов',
    'order:cancel': 'Отмена заказов',
    'order:search:global': 'Глобальный поиск',
    'payment:create': 'Приём оплаты',
    'payment:read': 'Просмотр платежей',
    'payment:reverse': 'Сторно платежей',
    'report:operational': 'Операционная отчётность',
    'report:revenue': 'Отчётность по выручке',
    'user:manage': 'Управление пользователями',
    'audit:read': 'Журнал действий',
  };

  const knownPermissions = Object.values(PERMISSION).filter((permission) =>
    permissionLabels[permission] !== undefined,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">{t.nav.profile}</h1>

      <div className="card space-y-3">
        <div>
          <p className="text-sm text-slate-500">ФИО</p>
          <p className="text-base font-medium text-slate-900">{user.fullName}</p>
        </div>
        <div>
          <p className="text-sm text-slate-500">E-mail</p>
          <p className="text-base text-slate-900">{user.email}</p>
        </div>
        <div>
          <p className="text-sm text-slate-500">Роли</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {user.roles.map((role) => (
              <span
                key={role}
                className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700"
              >
                {ROLE_LABELS[role as RoleCode] ?? role}
              </span>
            ))}
          </div>
        </div>
        <div>
          <p className="text-sm text-slate-500">Область видимости</p>
          <p className="text-base text-slate-900">{user.scope}</p>
        </div>
      </div>

      <div className="card">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Права доступа</h2>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {knownPermissions.map((permission) => {
            const granted = user.permissions.includes(permission);
            return (
              <li
                key={permission}
                className={`flex items-center gap-2 text-sm ${
                  granted ? 'text-slate-700' : 'text-slate-400'
                }`}
              >
                <span aria-hidden="true">{granted ? '✓' : '—'}</span>
                <span className={granted ? '' : 'line-through'}>
                  {permissionLabels[permission]}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex gap-2">
        <Link href="/dashboard">
          <Button variant="secondary">{t.common.back}</Button>
        </Link>
        <Button variant="danger" onClick={() => void logout()}>
          {t.nav.logout}
        </Button>
      </div>
    </div>
  );
}
