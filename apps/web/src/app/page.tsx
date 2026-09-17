import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

/**
 * Корень приложения.
 *
 * Отдаёт управление дашборду: если пользователь не вошёл, каркас `(app)`
 * перенаправит его на страницу входа. Отдельной «стартовой» страницы нет —
 * сотрудник открывает систему, чтобы работать с заказами.
 */
export default function RootPage(): ReactNode {
  redirect('/dashboard');
}
