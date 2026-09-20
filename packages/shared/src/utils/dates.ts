/**
 * Работа с датами и сроками.
 *
 * Ключевое правило: «рабочие дни» считаются по производственному календарю,
 * а не как «календарные минус выходные». Это важно для ТЗ п. 2.9 (10 рабочих дней
 * на рекламацию) и нормативов этапов (ТЗ п. 2.7).
 */

import { isStateHoliday } from '../domain/working-calendar.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Границы рабочего дня по местному времени.
 *
 * Вынесены константами, потому что их используют ДВА независимых расчёта:
 * прибавление рабочих часов (срок этапа) и подсчёт рабочих часов просрочки
 * (эскалация). При разных границах «просрочено на один рабочий день» означало
 * бы одно в сроке и другое в эскалации, и объяснить разницу было бы нечем.
 */
export const WORK_DAY_START_HOUR = 10;
export const WORK_DAY_END_HOUR = 19;

/** Производственный календарь: набор нерабочих дат (праздники, переносы). */
export interface CalendarDay {
  /** Дата в формате YYYY-MM-DD (локальная дата магазина). */
  date: string;
  isWorkday: boolean;
  /** Рабочих часов в этот день (0 для выходного). */
  hours: number;
}

export interface WorkingCalendar {
  /** Карта «YYYY-MM-DD → рабочий ли день». Если даты нет — считается по дню недели. */
  overrides: ReadonlyMap<string, { isWorkday: boolean; hours?: number }>;
  /** Часов в обычный рабочий день. */
  defaultHours: number;
}

/** Дата в формате YYYY-MM-DD в указанной таймзоне. */
export function toDateKey(date: Date, timeZone = 'Europe/Moscow'): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Является ли день рабочим.
 *
 * Порядок проверок важен и определяет, что может администратор:
 *   1. исключение из базы — сильнее всего, поэтому праздник можно объявить
 *      рабочим (например, магазин работает в новогодние каникулы);
 *   2. государственный праздник РФ — встроен в код, чтобы срок не попал на
 *      нерабочий день даже там, где календарь в базе не заполнен;
 *   3. день недели — суббота и воскресенье нерабочие.
 */
export function isWorkday(
  date: Date,
  calendar: WorkingCalendar,
  timeZone = 'Europe/Moscow',
): boolean {
  const key = toDateKey(date, timeZone);
  const override = calendar.overrides.get(key);
  if (override !== undefined) return override.isWorkday;
  // Праздник важнее дня недели: 1 января может быть четвергом, но он нерабочий.
  if (isStateHoliday(key)) return false;
  const dayOfWeek = weekday(date, timeZone);
  return dayOfWeek !== 0 && dayOfWeek !== 6; // 0 = воскресенье, 6 = суббота
}

/** День недели в таймзоне: 0 = воскресенье. */
export function weekday(date: Date, timeZone = 'Europe/Moscow'): number {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[formatted] ?? 0;
}

/**
 * Прибавить РАБОЧИЕ дни к дате. Используется для нормативов этапов
 * и срока рассмотрения рекламации (ТЗ п. 2.9).
 */
export function addWorkingDays(
  from: Date,
  days: number,
  calendar: WorkingCalendar,
  timeZone = 'Europe/Moscow',
): Date {
  if (days === 0) return new Date(from.getTime());
  const direction = days > 0 ? 1 : -1;
  let remaining = Math.abs(days);
  const result = new Date(from.getTime());
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + direction);
    if (isWorkday(result, calendar, timeZone)) {
      remaining -= 1;
    }
  }
  return result;
}

/** Прибавить рабочие ЧАСЫ (для коротких этапов логистики, ТЗ п. 2.7). */
export function addWorkingHours(
  from: Date,
  hours: number,
  calendar: WorkingCalendar,
  timeZone = 'Europe/Moscow',
): Date {
  if (hours <= 0) return new Date(from.getTime());
  let remaining = hours;
  const result = new Date(from.getTime());
  let guard = 0;
  while (remaining > 0 && guard < 366 * 24) {
    guard += 1;

    /*
     * Засчитывается ИНТЕРВАЛ, начинающийся в текущем моменте: если он попадает
     * в рабочее окно, час отработан, и время сдвигается к его концу. Поэтому
     * проверка идёт ДО сдвига, а выход из цикла — ПОСЛЕ него.
     *
     * Прежняя версия выходила из цикла ДО сдвига, поэтому «плюс один рабочий
     * час» от 12:00 возвращала 12:00 (сдвига не было), а норматив в 4 часа от
     * 15:00 истекал в 18:00 вместо 19:00 — то есть на час раньше срока. Заказ
     * становился «просроченным» до его наступления. См. дефект 31 в
     * docs/15-known-issues.md.
     */
    if (isWorkday(result, calendar, timeZone)) {
      // Считаем рабочий день по границам WORK_DAY_START_HOUR..WORK_DAY_END_HOUR.
      const localHour = Number(
        new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(
          result,
        ),
      );
      if (localHour >= WORK_DAY_START_HOUR && localHour < WORK_DAY_END_HOUR) {
        remaining -= 1;
      }
    }

    result.setTime(result.getTime() + HOUR_MS);
  }
  return result;
}

/** Прибавить календарные дни (для срока ответственного хранения, ТЗ п. 2.8). */
export function addCalendarDays(from: Date, days: number): Date {
  const result = new Date(from.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** Прибавить месяцы — для расчёта срока гарантии (ТЗ п. 2.9). */
export function addMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Количество РАБОЧИХ дней, прошедших между датами (для отчётов по срокам
 * и порога эскалации «более 1 рабочего дня», ТЗ п. 2.7).
 *
 * Считаются только целые сутки, укладывающиеся в интервал: частичный день
 * в конце интервала не засчитывается. Иначе просрочка в несколько часов
 * внутри одного дня ошибочно давала бы «1 рабочий день».
 */
export function workingDaysBetween(
  from: Date,
  to: Date,
  calendar: WorkingCalendar,
  timeZone = 'Europe/Moscow',
): number {
  if (to <= from) return 0;
  let count = 0;
  const cursor = new Date(from.getTime());
  for (;;) {
    const next = new Date(cursor.getTime());
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.getTime() > to.getTime()) break;
    cursor.setTime(next.getTime());
    if (isWorkday(cursor, calendar, timeZone)) count += 1;
  }
  return count;
}

/**
 * Расчёт срока гарантии по видам работ (ТЗ п. 2.9).
 *
 * Берётся МАКСИМУМ по видам работ: если в заказе была и закрепка (3 месяца), и
 * обычный ремонт (6 месяцев), гарантия на изделие — шесть месяцев. Меньшее
 * значение лишило бы клиента гарантии на часть работ, за которые он заплатил.
 *
 * `defaultMonths` подставляется, когда у работ срок не задан. Значение приходит
 * из настройки `WARRANTY_MONTHS_DEFAULT`; прежняя жёсткая «6» превращала
 * изменение переменной в ничто — тот же класс дефекта, что «Дефект 41» и далее.
 *
 * Второй бизнес-параметр, `WARRANTY_MONTHS_SETTING` (3 месяца для закрепки),
 * задаёт срок НОВЫХ позиций прейскуранта и применяется при их создании, а не
 * здесь: у позиции срок хранится, и пересчитывать его задним числом нельзя —
 * иначе гарантия по уже принятым заказам изменилась бы в момент правки настройки.
 */
export function computeWarrantyUntil(
  completedAt: Date,
  workWarrantyMonths: readonly number[],
  defaultMonths = 6,
): Date {
  const months = workWarrantyMonths.length > 0 ? Math.max(...workWarrantyMonths) : defaultMonths;
  return addMonths(completedAt, months);
}

/** Просрочен ли заказ относительно норматива. */
export function isOverdue(dueAt: Date | null | undefined, now = new Date()): boolean {
  return dueAt != null && dueAt.getTime() < now.getTime();
}

/** Просрочка более одного РАБОЧЕГО дня — основание для эскалации руководителю (ТЗ п. 2.7). */
export function isOverdueForManager(
  dueAt: Date | null | undefined,
  now: Date,
  calendar: WorkingCalendar,
  timeZone = 'Europe/Moscow',
): boolean {
  if (dueAt == null || !isOverdue(dueAt, now)) return false;
  return workingDaysBetween(dueAt, now, calendar, timeZone) >= 1;
}

/** Человекочитаемая длительность: «3 д 4 ч», «45 мин». */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} мин`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = Math.round(minutes % 60);
  if (hours < 24) {
    return restMinutes > 0 ? `${hours} ч ${restMinutes} мин` : `${hours} ч`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} д ${restHours} ч` : `${days} д`;
}

/** Формат даты для интерфейса: дд.мм.гггг (docs/10-nfr-security.md §8). */
export function formatDate(date: Date | null | undefined, timeZone = 'Europe/Moscow'): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/** Формат даты и времени: дд.мм.гггг ЧЧ:ММ. */
export function formatDateTime(date: Date | null | undefined, timeZone = 'Europe/Moscow'): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Нормализация телефона в E.164. Используется для поиска клиента и
 * сопоставления звонков IP-АТС с заказами (ТЗ п. 2.4).
 */
export function normalizePhone(input: string, defaultCountryCode = '7'): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 10) {
    return `+${defaultCountryCode}${digits}`;
  }
  if (input.trim().startsWith('+')) {
    return `+${digits}`;
  }
  return null;
}

/**
 * Подсказка при вводе телефона: что именно сохранится.
 *
 * ## Зачем это нужно
 *
 * Нормализация телефона УЖЕ принимает номер без кода страны: `normalizePhone`
 * добавляет `+7` сам, а `+7` и `8` в начале приводит к одному виду. Но в
 * интерфейсе этого не видно: человек вводит `9333319392` и не знает, сохранится
 * ли номер правильно, — а placeholder `+7 916 123-45-67` намекает, что код
 * страны вводить обязательно.
 *
 * Функция возвращает готовую строку для предпросмотра под полем: «сохранится
 * как +7 933 331-93-92». Она ЧИСТАЯ и не зависит от React, поэтому проверяется
 * тестами: веб-тесты не рендерят компоненты, и правило, спрятанное в разметке,
 * осталось бы без проверки.
 *
 * Возвращает `null`, если номер ещё не полный: показывать предпросмотр
 * недописанного номера значило бы обещать то, чего не будет.
 */
export function phoneInputHint(input: string, defaultCountryCode = '7'): string | null {
  /*
   * Отдельной проверки длины здесь НЕТ, и это осознанно. `normalizePhone`
   * возвращает `null` для всего, что не сводится к полному номеру: и для
   * недописанного, и для лишних цифр. Своя проверка `digits.length !== 11` была
   * бы недостижимой — она не срабатывала бы никогда, но выглядела бы как защита
   * и мешала бы заметить, если `normalizePhone` однажды начнёт принимать
   * неполные номера.
   */
  const normalized = normalizePhone(input, defaultCountryCode);
  if (normalized === null) return null;

  return `Сохранится как ${formatPhone(normalized)}`;
}

/** Отображение телефона: «+7 916 123-45-67». */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('7')) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
  }
  return e164;
}
