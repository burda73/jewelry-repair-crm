import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { STATUS_COLORS, type OrderStatus } from '@app/shared';

/**
 * Тона бейджа.
 *
 * ## Почему их стало больше
 *
 * Заказчик сообщил, что в списке заказов разные статусы выглядят одинаково.
 * Причина: 18 статусов делили 9 тонов, причём ВСЯ производственная группа
 * (`IN_PRODUCTION`, `ACCEPTED_BY_WORKSHOP`, `IN_WORK`, `WORK_COMPLETED`,
 * `REWORK`) была одного цвета — то есть по бейджу нельзя было понять, где
 * находится изделие, а это единственный сигнал, который читается не по тексту.
 *
 * Тона подобраны так, чтобы каждый статус отличался от остальных, но ЦВЕТ
 * ОСТАЛСЯ ОСМЫСЛЕННЫМ:
 *  * `sky`/`blue`/`indigo` — приём и согласование (мяч у нас);
 *  * `amber`/`orange`/`yellow` — ждём клиента или оплату;
 *  * `slate`/`gray`/`zinc`/`stone` — заказ ещё не в работе;
 *  * `violet`/`purple`/`fuchsia`/`pink` — логистика между магазином и цехом;
 *  * `teal`/`cyan` — производство;
 *  * `lime`/`green`/`emerald` — готово к выдаче и выдано (успех);
 *  * `rose`/`red` — отказы и отмена (неуспех).
 *
 * Соседние по смыслу статусы различаются оттенком ВНУТРИ группы, а не группой
 * целиком: «Готовы к выдаче» и «Выдан» оба зелёные, но разные, — сотрудник
 * видит и «успех», и конкретный шаг.
 */
type Tone =
  | 'gray'
  | 'amber'
  | 'blue'
  | 'violet'
  | 'cyan'
  | 'green'
  | 'orange'
  | 'emerald'
  | 'red'
  | 'slate'
  | 'sky'
  | 'indigo'
  | 'yellow'
  | 'zinc'
  | 'stone'
  | 'purple'
  | 'fuchsia'
  | 'pink'
  | 'teal'
  | 'lime'
  | 'rose';

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
  sky: 'bg-sky-100 text-sky-800 ring-sky-200',
  indigo: 'bg-indigo-100 text-indigo-800 ring-indigo-200',
  yellow: 'bg-yellow-100 text-yellow-900 ring-yellow-200',
  zinc: 'bg-zinc-100 text-zinc-800 ring-zinc-200',
  stone: 'bg-stone-100 text-stone-800 ring-stone-200',
  purple: 'bg-purple-100 text-purple-800 ring-purple-200',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200',
  pink: 'bg-pink-100 text-pink-800 ring-pink-200',
  teal: 'bg-teal-100 text-teal-900 ring-teal-200',
  lime: 'bg-lime-100 text-lime-900 ring-lime-200',
  rose: 'bg-rose-100 text-rose-800 ring-rose-200',
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
