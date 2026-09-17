'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, LogOut, User } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS, type RoleCode } from '@app/shared';
import { t } from '@/lib/i18n';

/**
 * Меню пользователя: имя, роль и выход.
 *
 * Реализовано на нативном `<details>`/`<summary>`: браузер сам даёт
 * открытие, закрытие по Escape и корректную работу с клавиатуры —
 * без дополнительной библиотеки и без риска потерять доступность.
 */
export function NavUserMenu(): ReactNode {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Закрытие по клику вне меню.
  useEffect(() => {
    if (!open) return;

    function handleClick(event: MouseEvent): void {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (user === null) return null;

  const roleLabel = ROLE_LABELS[user.primaryRole as RoleCode] ?? user.primaryRole;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-100"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
          {user.fullName.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-sm font-medium text-slate-800">
            {user.fullName}
          </span>
          <span className="block truncate text-xs text-slate-500">{roleLabel}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="absolute right-0 z-40 mt-1 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
          role="menu"
        >
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="truncate text-sm font-medium text-slate-800">{user.fullName}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
            <p className="mt-1 text-xs text-slate-400">{roleLabel}</p>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              router.push('/profile');
            }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <User className="h-4 w-4" aria-hidden="true" />
            {t.nav.profile}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t.nav.logout}
          </button>
        </div>
      ) : null}
    </div>
  );
}
