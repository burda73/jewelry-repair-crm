import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const BASE =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 ' +
  'placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-100';

/**
 * Поле ввода. Минимальная высота 44 px — область нажатия для пальца
 * (docs/08-ui-ux.md §6). `aria-invalid` выставляется вызывающим кодом
 * при ошибке валидации, чтобы скринридер сообщил о проблеме.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(BASE, 'min-h-[44px]', props['aria-invalid'] === true && 'border-red-500', className)}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(BASE, 'min-h-[88px] resize-y', props['aria-invalid'] === true && 'border-red-500', className)}
        {...props}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn(BASE, 'min-h-[44px]', className)} {...props}>
        {children}
      </select>
    );
  },
);
