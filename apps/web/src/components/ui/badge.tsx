import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { STATUS_COLORS, type OrderStatus } from '@app/shared';

type Tone =
  'gray' | 'amber' | 'blue' | 'violet' | 'cyan' | 'green' | 'orange' | 'emerald' | 'red' | 'slate';

/**
 * Классы бейджа по тону.
 *
 * Список статических строк, а не склейка вида `bg-${tone}-100`:
 * Tailwind собирает классы статически и динамически составленное имя
 * не попадёт в итоговый CSS — бейджи остались бы без фона.
 */
const TONES: Record<Tone, string> = {
  gray: 'bg-gray-100 text-gray-800 ring-gray-200',
  amber: 'bg-amber-100 text-amber-900 ring-amber-200',
  blue: 'bg-blue-100 text-blue-800 ring-blue-200',
  violet: 'bg-violet-100 text-violet-800 ring-violet-200',
  cyan: 'bg-cyan-100 text-cyan-900 ring-cyan-200',
  green: 'bg-green-100 text-green-800 ring-green-200',
  orange: 'bg-orange-100 text-orange-900 ring-orange-200',
  emerald: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  red: 'bg-red-100 text-red-800 ring-red-200',
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
};

export interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  /** Точка-индикатор слева — для статусов в списках. */
  dot?: boolean;
}

export function Badge({ tone = 'slate', children, className, dot = false }: BadgeProps): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1',
        'text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/**
 * Бейдж статуса заказа. Цвет берётся из единого словаря `STATUS_COLORS`
 * в `@app/shared` — так бейдж в списке и в карточке заказа совпадают
 * (docs/08-ui-ux.md §6).
 */
export function StatusBadge({
  status,
  label,
  className,
}: {
  status: OrderStatus;
  label: string;
  className?: string;
}): ReactNode {
  /*
   * Приведение типа здесь БОЛЬШЕ НЕ НУЖНО, и это не мелочь. Раньше
   * `STATUS_COLORS` был `Record<OrderStatus, string>`, и без `as Tone` этот
   * вызов не собирался — но приведение заодно гасило и опечатку в тоне:
   * `'gren'` проходило как валидный `string`, превращалось в `Tone` и давало
   * серый бейдж без единого признака ошибки.
   *
   * Теперь `STATUS_COLORS` типизирован как `Record<OrderStatus, StatusTone>`, а
   * набор тонов компонента ему соответствует, поэтому линтер
   * (`no-unnecessary-type-assertion`) прямо говорит, что приведение ничего не
   * меняет. Расхождение словарей ловит
   * `packages/shared/src/domain/status-colors-sync.spec.ts`.
   */
  const tone = STATUS_COLORS[status] ?? 'slate';
  return (
    <Badge tone={tone} className={className} dot>
      {label}
    </Badge>
  );
}
