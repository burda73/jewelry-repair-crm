/**
 * Части даты в рабочем часовом поясе (Москва).
 *
 * ПОЧЕМУ НЕ `getUTCFullYear()`/`getUTCDate()`. Номера документов содержат дату
 * (`MSK1-2509-…`, `П-250916-…`, `АПП-25-…`), и эта дата — рабочая дата точки, а
 * вся система считает рабочий день по Москве (`toDateKey` в utils/dates.ts).
 * UTC же отстаёт на 3 часа, поэтому документ, оформленный 1 октября в 01:00 МСК,
 * получал номер за 30 сентября, а заказ, принятый 1 января ночью, попадал в
 * декабрьский счётчик. Ошибка не косметическая: по номеру ищут документ, а
 * отчётность группирует заказы по месяцу из номера.
 */
const DOCUMENT_TIME_ZONE = 'Europe/Moscow';

/**
 * Год, месяц (1–12) и день в московском времени.
 *
 * Экспортируется, потому что нужен не только построителям номеров: счётчик
 * заказов в API формирует область видимости по году, и брать год из UTC там
 * означало бы ту же ошибку на границе года, что и в самом номере.
 */
export function documentDateParts(date: Date): { year: number; month: number; day: number } {
  // `sv-SE` даёт формат ГГГГ-ММ-ДД, который разбирается без догадок о локали.
  const formatted = new Intl.DateTimeFormat('sv-SE', {
    timeZone: DOCUMENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

  const [year, month, day] = formatted.split('-').map((part) => Number(part));
  return { year: year!, month: month!, day: day! };
}

/**
 * Номера и машиночитаемые коды (ответ A4, docs/00-decisions.md §6.12 и §6.14).
 *
 * Формат номера заказа: `{КОД_МАГАЗИНА}-{ГГ}{ММ}-{6 цифр}`, например `MSK1-2509-000142`.
 * Действующего формата у заказчика нет, поэтому формат выбирается нами и обоснован:
 *  * префикс магазина — видно точку приёма;
 *  * год и месяц — удобно для сортировки и разговора по телефону;
 *  * шесть цифр — запас, переполнение невозможно;
 *  * только ASCII и дефис — безопасно для QR-кода, URL и поиска.
 */

/** Схема URI в QR-коде: отличает наше содержимое от случайного ввода. */
export const QR_URI_SCHEME = 'repair';
export const QR_ORDER_PREFIX = `${QR_URI_SCHEME}://order/`;

/** Регулярное выражение допустимого номера заказа. */
const ORDER_NO_PATTERN = /^[A-Z0-9]{2,10}-\d{4}-\d{6}$/;

/** Проверить, что строка является корректным номером заказа нашего формата. */
export function isValidOrderNo(value: string): boolean {
  return ORDER_NO_PATTERN.test(value.trim().toUpperCase());
}

/**
 * Сформировать номер заказа.
 *
 * @param storeCode  код магазина, например `MSK1`
 * @param date       дата приёма (по ней берётся ГГММ)
 * @param sequence   порядковый номер в месяце (счётчик из БД)
 */
export function buildOrderNo(storeCode: string, date: Date, sequence: number): string {
  const parts = documentDateParts(date);
  const year = String(parts.year).slice(2);
  const month = String(parts.month).padStart(2, '0');
  const normalizedCode = storeCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (normalizedCode.length === 0) {
    throw new RangeError('Код магазина не может быть пустым');
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`Порядковый номер должен быть положительным целым, получено ${sequence}`);
  }
  return `${normalizedCode}-${year}${month}-${String(sequence).padStart(6, '0')}`;
}

/** Область счётчика номеров: уникальна для магазина и месяца. */
export function orderCounterScope(storeCode: string, date: Date): string {
  const parts = documentDateParts(date);
  return `ORDER:${storeCode.trim().toUpperCase()}:${parts.year}${String(parts.month).padStart(
    2,
    '0',
  )}`;
}

/**
 * Содержимое QR-кода квитанции.
 *
 * Умышленно НЕ включает сумму, телефон или другие данные: QR печатается на бумаге,
 * которая остаётся у клиента, и не должен раскрывать персональные данные —
 * достаточно ссылки на заказ.
 */
export function buildOrderQrPayload(orderNo: string): string {
  if (!isValidOrderNo(orderNo)) {
    throw new RangeError(`Некорректный номер заказа для QR-кода: ${orderNo}`);
  }
  return `${QR_ORDER_PREFIX}${orderNo.trim().toUpperCase()}`;
}

/**
 * Разобрать то, что ввёл сканер (или пользователь), и извлечь номер заказа.
 *
 * Сканер USB работает в режиме эмуляции клавиатуры и «печатает» содержимое
 * QR-кода в активное поле. Приложение должно принять и полный URI
 * (`repair://order/MSK1-2509-000142`), и просто номер, и строку с пробелами
 * или переводами строк, которые иногда добавляет сканер.
 *
 * @returns номер заказа в верхнем регистре или null, если распознать не удалось
 */
export function parseOrderNoFromScan(input: string): string | null {
  // Сканер может добавить перевод строки, табуляцию или пробелы.
  let value = input.trim().replace(/\s+/g, '');
  if (value.length === 0) return null;

  // Полный URI из QR-кода.
  if (value.toLowerCase().startsWith(QR_ORDER_PREFIX)) {
    value = value.slice(QR_ORDER_PREFIX.length);
  } else if (value.toLowerCase().startsWith(`${QR_URI_SCHEME}://`)) {
    // Иной наш URI — берём последний сегмент пути.
    const segments = value.split('/');
    value = segments[segments.length - 1] ?? '';
  }

  const upper = value.toUpperCase();
  return isValidOrderNo(upper) ? upper : null;
}

/**
 * Привести ввод сканера к тому, что понимает поиск.
 *
 * Сканер USB «печатает» содержимое QR-кода в активное поле и завершает ввод
 * переводом строки. В отличие от `parseOrderNoFromScan`, который отвечает на
 * вопрос «это номер заказа?», здесь нужно вернуть ГОДНЫЙ ПОИСКОВЫЙ ЗАПРОС:
 * приёмщик сканирует квитанцию, но может ввести и телефон, и фамилию.
 *
 * Поэтому порядок такой:
 *  1. если ввод распознан как номер заказа (в том числе внутри `repair://order/…`)
 *     — возвращаем номер;
 *  2. иначе возвращаем ввод как есть, убрав переводы строк и лишние пробелы,
 *     чтобы поиск по телефону или фамилии не сломался.
 *
 * Без этого шага отсканированный QR давал бы НОЛЬ результатов в любом поле,
 * кроме глобального поиска: в API уходила строка `repair://order/MSK1-…`,
 * по которой заказов нет (дефект, найденный на экране приёма оплаты).
 */
export function normalizeScanInput(raw: string): string {
  const orderNo = parseOrderNoFromScan(raw);
  if (orderNo !== null) return orderNo;
  // Не номер заказа — обычный поиск: убираем перевод строки сканера и
  // схлопываем пробелы, но не меняем сам запрос.
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Номер партии: `П-{ГГ}{ММ}{ДД}-{3 цифры}`.
 */
export function buildBatchNo(date: Date, sequence: number): string {
  const { year, month, day } = documentDateParts(date);
  const ymd = `${String(year).slice(2)}${String(month).padStart(2, '0')}${String(day).padStart(
    2,
    '0',
  )}`;
  return `П-${ymd}-${String(sequence).padStart(3, '0')}`;
}

/** Номер акта приёма-передачи: `АПП-{ГГ}-{6 цифр}`. */
export function buildBatchActNo(date: Date, sequence: number): string {
  return `АПП-${String(documentDateParts(date).year).slice(2)}-${String(sequence).padStart(6, '0')}`;
}

/** Номер акта отказа: `АО-{ГГ}-{6 цифр}`. */
export function buildRefusalActNo(date: Date, sequence: number): string {
  return `АО-${String(documentDateParts(date).year).slice(2)}-${String(sequence).padStart(6, '0')}`;
}

/** Номер рекламации: `РЕК-{ГГ}-{5 цифр}`. */
export function buildClaimNo(date: Date, sequence: number): string {
  return `РЕК-${String(documentDateParts(date).year).slice(2)}-${String(sequence).padStart(5, '0')}`;
}
