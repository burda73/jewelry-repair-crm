import {
  formatDate as sharedFormatDate,
  formatDateTime as sharedFormatDateTime,
  formatPhone as sharedFormatPhone,
  toMajor,
} from '@app/shared';

/**
 * Форматирование для интерфейса.
 *
 * Обёртки над `@app/shared` нужны потому, что из JSON даты приходят
 * строками, а общие функции принимают `Date`. Без обёрток каждый вызов
 * в компонентах писал бы `new Date(...)`, и легко было бы забыть про
 * `null` — тогда на экране появлялось бы «Invalid Date».
 */

/** Дата `дд.мм.гггг` или прочерк, если значения нет. */
export function formatDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return sharedFormatDate(date);
}

/** Дата и время `дд.мм.гггг чч:мм`. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return sharedFormatDateTime(date);
}

/**
 * Сумма из минорных единиц без копеек: `12 500 ₽` — для списков и дашборда.
 *
 * Не используем `formatMoneyShort` из `@app/shared`: он сокращает до
 * «12,5 тыс. ₽», и в списке заказов точную сумму было бы не прочитать.
 */
export function formatMinor(minor: number | null | undefined, currency = 'RUB'): string {
  if (minor === null || minor === undefined) return '—';
  const major = minor / 100;
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(major);
  return `${formatted} ${currency === 'RUB' ? '₽' : currency}`;
}

/** Сумма с копейками — для платежей и печатных форм, где точность обязательна. */
export function formatMinorExact(minor: number | null | undefined, currency = 'RUB'): string {
  if (minor === null || minor === undefined) return '—';
  const major = toMajor(minor);
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(major);
  return `${formatted} ${currency === 'RUB' ? '₽' : currency}`;
}

/** Телефон в читаемом виде `+7 916 123-45-67`. */
export function formatPhoneValue(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return sharedFormatPhone(value) ?? value;
}

/**
 * Разница в календарных днях между сроком и текущим моментом.
 * Положительное значение — дней осталось, отрицательное — просрочено.
 */
export function daysUntil(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const startOfDay = (d: Date): number =>
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const diffMs = startOfDay(date) - startOfDay(new Date());
  return Math.round(diffMs / 86_400_000);
}

/**
 * Склонение существительного после числа: 1 день, 2 дня, 5 дней.
 * Русские формы не выводятся из числа формулой — нужен список форм.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}
