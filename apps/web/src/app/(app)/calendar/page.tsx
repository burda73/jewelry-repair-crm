'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { CalendarOff, Loader2, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useCalendarSummary,
  useCreateCalendarDay,
  useDeleteCalendarDay,
  useUpdateCalendarDay,
  useWorkingCalendar,
} from '@/lib/queries';
import { describeApiError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, EmptyState } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, FormError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { t } from '@/lib/i18n';
import { formatDate } from '@/lib/format';
import type { CalendarDayInput, CalendarDayItem } from '@/lib/api-types';

/** Право администратора: календарь определяет сроки всех заказов. */
const SETTINGS_MANAGE = 'settings:manage';

/**
 * Экран «Рабочий календарь» (задача 1.3.3, ТЗ п. 2.7 и 2.9).
 *
 * Главное отличие от экрана справочников, и оно определяет всю разметку: здесь
 * НЕТ списка дней. Таблица хранит только исключения — праздник, объявленный
 * рабочим, перенос, особые часы. Обычные рабочие дни и государственные
 * праздники РФ система знает сама.
 *
 * Это не оптимизация, а исправление: раньше календарь заполнялся строкой на
 * каждый день, среди этих строк праздники среди недели были помечены рабочими,
 * и срок «5 рабочих дней от 25 декабря» попадал на 1 января. Поэтому экран
 * показывает период, праздники в нём и список исключений — а не «сетку месяца»
 * с флажками на каждый день, которая снова подталкивала бы к зеркальным записям.
 */
export default function CalendarPage(): ReactNode {
  const { can } = useAuth();
  const { showSuccess, showError } = useToast();

  // По умолчанию — текущий год. Период обязателен: календарь за 10 лет — это
  // тысячи строк, и запрос «весь календарь» не имеет смысла.
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => `${today.getUTCFullYear()}-01-01`);
  const [to, setTo] = useState(() => `${today.getUTCFullYear()}-12-31`);

  const [editing, setEditing] = useState<CalendarDayItem | 'new' | null>(null);

  const canManage = can(SETTINGS_MANAGE);

  const list = useWorkingCalendar(from, to);
  const summary = useCalendarSummary(from, to);
  const createDay = useCreateCalendarDay();
  const updateDay = useUpdateCalendarDay();
  const deleteDay = useDeleteCalendarDay();

  const invalidPeriod = from > to;

  if (!canManage) {
    return <EmptyState title={t.errors.forbidden} hint={t.calendar.forbidden} />;
  }

  const days = list.data?.days ?? [];
  const holidays = list.data?.holidays ?? [];
  // Записи, которые ничего не меняют, — наследие прежнего заполнения. Их видно
  // отдельно, потому что именно они перекрывали праздники.
  const redundant = days.filter((day) => day.redundant);
  const meaningful = days.filter((day) => !day.redundant);

  const handleSave = (input: CalendarDayInput): void => {
    const done = {
      onSuccess: () => {
        setEditing(null);
        showSuccess(t.calendar.title);
      },
      onError: (error: unknown) => showError(describeApiError(error)),
    };
    if (editing === 'new') createDay.mutate({ input }, done);
    else if (editing !== null) updateDay.mutate({ id: editing.id, input }, done);
  };

  const handleRemove = (day: CalendarDayItem): void => {
    if (!window.confirm(t.calendar.removeConfirm)) return;
    deleteDay.mutate(
      { id: day.id },
      {
        onSuccess: () => showSuccess(t.calendar.title),
        onError: (error) => showError(describeApiError(error)),
      },
    );
  };

  const saving = createDay.isPending || updateDay.isPending;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t.calendar.title}</h1>
        <p className="text-sm text-slate-500">{t.calendar.subtitle}</p>
      </div>

      {/* Пояснение вынесено наверх: без него администратор ищет «сетку месяца»
          и снова создаёт по строке на каждый день. */}
      <Card>
        <CardBody className="text-sm text-slate-600">{t.calendar.holidaysBanner}</CardBody>
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-slate-600">
            <span className="mb-1 block">{t.calendar.from}</span>
            <Input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              aria-label={t.calendar.from}
            />
          </label>
          <label className="text-sm text-slate-600">
            <span className="mb-1 block">{t.calendar.to}</span>
            <Input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              aria-label={t.calendar.to}
            />
          </label>
        </div>

        <Button type="button" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" aria-hidden />
          {t.calendar.addDay}
        </Button>
      </div>

      {invalidPeriod ? (
        <FormError>{t.calendar.periodRequired}</FormError>
      ) : (
        <>
          {/* Сводка: администратору важно видеть, что праздники уже учтены,
              иначе он будет заводить записи, которые не нужны. */}
          {summary.data && summary.data.length > 0 ? (
            <Card>
              <CardBody>
                <h2 className="mb-2 text-sm font-semibold text-slate-700">
                  {t.calendar.summaryTitle}
                </h2>
                <div className="flex flex-wrap gap-2">
                  {summary.data.map((row) => (
                    <span
                      key={row.month}
                      className="rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-600"
                    >
                      {row.month}: {t.calendar.workdays} {row.workdays} · {t.calendar.holidaysCount}{' '}
                      {row.holidays}
                    </span>
                  ))}
                </div>
              </CardBody>
            </Card>
          ) : null}

          {list.isLoading ? (
            <div className="flex items-center justify-center py-10 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            </div>
          ) : list.isError ? (
            <FormError>{describeApiError(list.error)}</FormError>
          ) : (
            <div className="space-y-4">
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-slate-700">
                  {t.calendar.addTitle} · {meaningful.length}
                </h2>
                {meaningful.length === 0 ? (
                  <EmptyState title={t.calendar.empty} hint={t.calendar.guide} />
                ) : (
                  meaningful.map((day) => (
                    <DayRow
                      key={day.id}
                      day={day}
                      onEdit={() => setEditing(day)}
                      onRemove={() => handleRemove(day)}
                      removing={deleteDay.isPending}
                    />
                  ))
                )}
              </section>

              {/* Исторические зеркальные записи — отдельным блоком с объяснением,
                  чтобы администратор понимал, что это, и мог снять. */}
              {redundant.length > 0 ? (
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold text-amber-700">
                    {t.calendar.redundant} · {redundant.length}
                  </h2>
                  <p className="text-xs text-amber-700">{t.calendar.redundantWarning}</p>
                  {redundant.map((day) => (
                    <DayRow
                      key={day.id}
                      day={day}
                      onEdit={() => setEditing(day)}
                      onRemove={() => handleRemove(day)}
                      removing={deleteDay.isPending}
                    />
                  ))}
                </section>
              ) : null}

              {/* Праздники периода: показываем, чтобы администратор видел, что
                  они уже учтены и отмечать их не нужно. */}
              {holidays.length > 0 ? (
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold text-slate-700">
                    {t.calendar.holiday} · {holidays.length}
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {holidays.map((date) => (
                      <span
                        key={date}
                        className="rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-700"
                      >
                        {formatDate(new Date(`${date}T00:00:00Z`))}
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </>
      )}

      {editing !== null ? (
        <DayDialog
          day={editing === 'new' ? null : editing}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      ) : null}
    </div>
  );
}

/** Строка исключения: дата, признак, часы, примечание. */
function DayRow({
  day,
  onEdit,
  onRemove,
  removing,
}: {
  day: CalendarDayItem;
  onEdit: () => void;
  onRemove: () => void;
  removing: boolean;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium text-slate-900">
          {formatDate(new Date(`${day.date}T00:00:00Z`))}
        </span>
        <Badge tone={day.isWorkday ? 'green' : 'red'} dot>
          {day.isWorkday ? t.calendar.workdayLabel : t.calendar.dayOffLabel}
        </Badge>
        {day.isHoliday ? <Badge tone="red">{t.calendar.holiday}</Badge> : null}
        {day.hours > 0 ? (
          <span className="text-xs text-slate-500">
            {t.calendar.hours}: {day.hours}
          </span>
        ) : null}
        {day.note ? <span className="text-xs text-slate-500">{day.note}</span> : null}
      </div>

      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
          {t.common.edit}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={removing}
          aria-label={t.calendar.remove}
        >
          <Trash2 className="h-4 w-4 text-rose-600" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/**
 * Диалог отметки дня.
 *
 * Часы показываются только для рабочего дня: «выходной 8 часов» — состояние,
 * которого не должно существовать, и сервер его отклоняет. Прятать поле —
 * понятнее, чем показывать и объяснять запрет.
 */
function DayDialog({
  day,
  saving,
  onClose,
  onSave,
}: {
  day: CalendarDayItem | null;
  saving: boolean;
  onClose: () => void;
  onSave: (input: CalendarDayInput) => void;
}): ReactNode {
  const [date, setDate] = useState(day?.date ?? '');
  const [isWorkday, setIsWorkday] = useState(day?.isWorkday ?? true);
  const [hours, setHours] = useState(String(day?.hours ?? 8));
  const [note, setNote] = useState(day?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    setError(null);
    const parsedHours = Number(hours);
    if (isWorkday && (!Number.isInteger(parsedHours) || parsedHours < 1 || parsedHours > 24)) {
      setError(t.calendar.hoursInvalid);
      return;
    }
    const input: CalendarDayInput = {
      date,
      isWorkday,
      hours: isWorkday ? parsedHours : 0,
      note: note.trim() === '' ? null : note.trim(),
    };
    // При изменении дату не отправляем, если она не менялась: сервер трактует
    // присутствие `date` как перенос записи и проверяет конфликт с другой датой.
    if (day !== null && day.date === date) delete input.date;
    onSave(input);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent title={day === null ? t.calendar.addTitle : t.calendar.editTitle}>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {error ? <FormError>{error}</FormError> : null}

          <Field
            label={t.calendar.date}
            htmlFor="calendar-date"
            required
            hint={t.calendar.dateHint}
          >
            <Input
              id="calendar-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </Field>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={isWorkday}
              onChange={(event) => {
                setIsWorkday(event.target.checked);
                // Часы подставляются по смыслу: «рабочий день 0 часов» и
                // «выходной 8 часов» — состояния, которых быть не должно.
                setHours(event.target.checked ? '8' : '0');
              }}
              className="h-4 w-4 rounded border-slate-300"
            />
            {t.calendar.isWorkday}
          </label>

          {isWorkday ? (
            <Field label={t.calendar.hours} htmlFor="calendar-hours">
              <Input
                id="calendar-hours"
                type="number"
                min={1}
                max={24}
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
            </Field>
          ) : null}

          <Field label={t.calendar.note} htmlFor="calendar-note" hint={t.calendar.noteHint}>
            <Input
              id="calendar-note"
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
              placeholder="перенос с 4 ноября"
            />
          </Field>

          <p className="flex items-start gap-1 text-xs text-slate-500">
            <CalendarOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t.calendar.guide}
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={saving} disabled={date === ''}>
              {saving ? t.common.saving : t.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
