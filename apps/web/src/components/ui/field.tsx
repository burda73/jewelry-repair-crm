import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Обёртка поля формы: подпись, сам контрол и текст ошибки.
 *
 * Ошибка выводится с `role="alert"`, чтобы скринридер сообщил о ней
 * сразу после появления, а не только при переходе к полю.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required = false,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
        {required ? (
          <span className="ml-0.5 text-red-600" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint !== undefined && error === undefined ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
      {error !== undefined ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Сообщение об ошибке в блоке формы — для отказов сервера целиком. */
export function FormError({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
      role="alert"
    >
      {children}
    </div>
  );
}
