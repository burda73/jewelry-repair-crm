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
  const year = String(date.getUTCFullYear()).slice(2);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const normalizedCode = storeCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
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
  return `ORDER:${storeCode.trim().toUpperCase()}:${date.getUTCFullYear()}${String(
    date.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
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
  const ymd = `${String(date.getUTCFullYear()).slice(2)}${String(date.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}${String(date.getUTCDate()).padStart(2, '0')}`;
  return `П-${ymd}-${String(sequence).padStart(3, '0')}`;
}

/** Номер акта приёма-передачи: `АПП-{ГГ}-{6 цифр}`. */
export function buildBatchActNo(date: Date, sequence: number): string {
  return `АПП-${String(date.getUTCFullYear()).slice(2)}-${String(sequence).padStart(6, '0')}`;
}

/** Номер акта отказа: `АО-{ГГ}-{6 цифр}`. */
export function buildRefusalActNo(date: Date, sequence: number): string {
  return `АО-${String(date.getUTCFullYear()).slice(2)}-${String(sequence).padStart(6, '0')}`;
}

/** Номер рекламации: `РЕК-{ГГ}-{5 цифр}`. */
export function buildClaimNo(date: Date, sequence: number): string {
  return `РЕК-${String(date.getUTCFullYear()).slice(2)}-${String(sequence).padStart(5, '0')}`;
}