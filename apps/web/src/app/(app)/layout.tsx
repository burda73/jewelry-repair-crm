'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { NavUserMenu } from '@/components/app/nav-user-menu';
import { GlobalSearch } from '@/components/app/global-search';

interface NavItem {
  href: string;
  label: string;
  /**
   * Права, при наличии ЛЮБОГО из которых пункт показывается.
   *
   * Массив, а не одно право, потому что разделы администрирования устроены
   * по-разному: «Справочники» открыты администратору (`settings:manage`) и
   * менеджеру производства (`performer:manage`) — по матрице прав
   * (docs/02-domain-and-roles.md §4) исполнителей ведёт именно он. Одиночное
   * право не позволило бы выразить это без второго пункта меню.
   */
  permissions?: string[];
}

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: t.nav.dashboard },
  { href: '/orders', label: t.nav.orders, permissions: ['order:read'] },
  // Пункт виден только администратору: право `user:manage` есть только у ADMIN
  // (packages/shared/src/domain/roles.ts). Остальные роли не должны видеть
  // административный раздел даже как неактивную ссылку.
  { href: '/users', label: t.nav.users, permissions: ['user:manage'] },
  {
    href: '/dictionaries',
    label: t.nav.dictionaries,
    permissions: ['settings:manage', 'performer:manage'],
  },
  // Календарь виден только администратору: он определяет сроки всех заказов,
  // поэтому право здесь `settings:manage` без второго варианта.
  { href: '/calendar', label: t.nav.calendar, permissions: ['settings:manage'] },
];

/**
 * Каркас авторизованной части приложения.
 *
 * Защита маршрутов выполняется здесь, на клиенте: токены лежат в httpOnly-cookie,
 * доступных скрипту, поэтому проверка «вошёл ли пользователь» — это запрос
 * `/auth/me`, который делает `AuthProvider`. Пока ответ не получен, показываем
 * индикатор, а не содержимое: иначе защищённый экран успел бы отрисоваться
 * до выяснения прав.
 *
 * Это не ослабление безопасности: сервер проверяет права на каждом запросе
 * (`JwtAuthGuard` + `RolesGuard`), и клиентская проверка нужна только для
 * удобства — чтобы не показывать интерфейс, который всё равно получит 401.
 */
export default function AppLayout({ children }: { children: ReactNode }): ReactNode {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && user === null) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading || user === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-label={t.common.loading} />
      </div>
    );
  }

  const visibleItems = NAV_ITEMS.filter(
    (item) =>
      item.permissions === undefined ||
      item.permissions.some((permission) => user.permissions.includes(permission)),
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <Link href="/dashboard" className="shrink-0 text-base font-bold text-slate-900">
            {t.app.shortTitle}
          </Link>

          <nav className="hidden items-center gap-1 sm:flex" aria-label="Основная навигация">
            {visibleItems.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    active ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100',
                  )}
                  aria-current={active ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <GlobalSearch />
            <NavUserMenu />
          </div>
        </div>

        {/* Мобильная навигация: те же пункты, крупные области нажатия. */}
        <nav
          className="flex items-center gap-1 overflow-x-auto border-t border-slate-100 px-2 py-1 sm:hidden"
          aria-label="Основная навигация"
        >
          {visibleItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium',
                  active ? 'bg-blue-50 text-blue-700' : 'text-slate-600',
                )}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
