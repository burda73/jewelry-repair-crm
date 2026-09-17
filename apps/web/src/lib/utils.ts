import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Объединение CSS-классов с разрешением конфликтов Tailwind.
 *
 * `clsx` собирает классы по условию, `twMerge` убирает конфликтующие:
 * например, переданный извне `px-8` победит базовый `px-4`, а не проиграет
 * ему из-за порядка в таблице стилей. Без этого переопределение размеров
 * кнопок и отступов работало бы непредсказуемо.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
