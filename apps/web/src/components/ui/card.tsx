import type { HTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn('rounded-xl border border-slate-200 bg-white shadow-sm', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div className={cn('border-b border-slate-100 px-4 py-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>): ReactNode {
  return <h2 className={cn('text-base font-semibold text-slate-900', className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div className={cn('p-4', className)} {...props} />;
}

/**
 * Плитка показателя на дашборде: крупное число и подпись под ним.
 *
 * `href` — плитка ведёт в список заказов с этим показателем. Это НАСТОЯЩАЯ
 * ссылка (`<Link>`), а не `div` с `onClick`: по ней работает средняя кнопка
 * мыши и открытие в новой вкладке, её видит клавиатура и скринридер, и её можно
 * скопировать. `onClick` такой возможности не даёт.
 *
 * `onClick` оставлен для плиток-кнопок без адреса (обновить, раскрыть):
 * смешивать оба на одной плитке нельзя — вложенная ссылка внутри элемента с
 * обработчиком клика ломает и навигацию, и доступность.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  href,
  onClick,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  href?: string;
  onClick?: () => void;
}): ReactNode {
  const tones = {
    default: 'text-slate-900',
    warning: 'text-amber-600',
    danger: 'text-red-600',
    success: 'text-emerald-600',
  } as const;

  const interactive = href !== undefined || onClick !== undefined;

  const content = (
    <>
      <p className="text-sm text-slate-500">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</p>
      {hint !== undefined ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </>
  );

  const className = cn(
    'block rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm',
    interactive && 'transition-shadow hover:shadow-md',
    href !== undefined && 'hover:border-blue-300',
  );

  if (href !== undefined) {
    return (
      <Link href={href} className={className}>
        {content}
      </Link>
    );
  }

  if (onClick !== undefined) {
    return (
      <button type="button" className={cn(className, 'w-full')} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}

/** Состояние «данных нет» с пояснением — вместо пустого экрана. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <p className="text-base font-medium text-slate-700">{title}</p>
      {hint !== undefined ? <p className="mt-1 text-sm text-slate-500">{hint}</p> : null}
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
