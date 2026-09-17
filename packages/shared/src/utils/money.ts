/**
 * Работа с денежными суммами.
 *
 * ПРАВИЛО: все суммы хранятся и передаются как ЦЕЛЫЕ ЧИСЛА в минорных единицах (копейки).
 * Float для денег запрещён — см. docs/03-data-model.md §1.
 */

/** Денежная сумма в минорных единицах (копейки). */
export type Minor = number;

const MINOR_PER_UNIT = 100;

/** Проверка, что значение — корректная сумма в минорных единицах. */
export function isValidMinor(value: unknown): value is Minor {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= Number.MIN_SAFE_INTEGER &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

/**
 * Преобразовать рубли (число или строку) в копейки.
 * Округление — «половина вверх», погрешность Decimal(10,2) не накапливается.
 */
export function toMinor(amount: number | string): Minor {
  const numeric = typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount;
  if (!Number.isFinite(numeric)) {
    throw new RangeError(`Некорректная сумма: ${String(amount)}`);
  }
  return Math.round(numeric * MINOR_PER_UNIT);
}

/** Преобразовать копейки в рубли (число с двумя знаками). */
export function toMajor(minor: Minor): number {
  assertMinor(minor, 'toMajor');
  return minor / MINOR_PER_UNIT;
}

function assertMinor(value: number, fn: string): void {
  // Проверяем булевым условием, а не предикатом isValidMinor: тип `Minor` —
  // это `number`, поэтому предикат `value is Minor` не сужает тип, и в ветке
  // ошибки `value` становился `never` — сообщение об ошибке перестало бы
  // компилироваться и потеряло информацию о фактическом значении.
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${fn}: сумма должна быть целым числом копеек, получено ${String(value)}`);
  }
}

/** Сложение сумм с защитой от переполнения. */
export function sumMinor(...amounts: readonly Minor[]): Minor {
  let total = 0;
  for (const amount of amounts) {
    assertMinor(amount, 'sumMinor');
    total += amount;
  }
  assertMinor(total, 'sumMinor: результат');
  return total;
}

/** Умножение суммы на количество (дробное количество допускается, результат округляется). */
export function multiplyMinor(amount: Minor, quantity: number): Minor {
  assertMinor(amount, 'multiplyMinor');
  if (!Number.isFinite(quantity)) {
    throw new RangeError(`Некорректное количество: ${quantity}`);
  }
  return Math.round(amount * quantity);
}

/**
 * Итог заказа: работы + камни − скидка.
 * Соответствует docs/03-data-model.md §3.2.
 */
export function calcOrderTotal(params: {
  worksTotalMinor: Minor;
  stonesTotalMinor: Minor;
  discountMinor?: Minor;
}): Minor {
  const discount = params.discountMinor ?? 0;
  const total = sumMinor(params.worksTotalMinor, params.stonesTotalMinor) - discount;
  return Math.max(0, total);
}

/** Сколько осталось доплатить до полной оплаты (не меньше нуля). */
export function remainingToPay(totalMinor: Minor, paidMinor: Minor): Minor {
  return Math.max(0, totalMinor - paidMinor);
}

/**
 * Скидка, при которой итог заказа равен заданному.
 *
 * Обратная функция к `calcOrderTotal`: `calcOrderTotal({works, stones, discount})`
 * вернёт `targetTotalMinor`. Именно поэтому корректировка итога обязана
 * пользоваться ею, а не присваивать итог напрямую: инвариант
 * `итог = работы + камни − скидка` (docs/03-data-model.md §3.2) тогда
 * выполняется по построению, при любом знаке разницы.
 *
 * Возвращаемое значение бывает отрицательным — это надбавка (см.
 * `describeDiscount`). Обнулять его нельзя: при надбавке инвариант сломается,
 * и ночная сверка итогов с платежами даст расхождение.
 */
export function discountForTotal(params: {
  worksTotalMinor: Minor;
  stonesTotalMinor: Minor;
  targetTotalMinor: Minor;
}): Minor {
  return sumMinor(params.worksTotalMinor, params.stonesTotalMinor) - params.targetTotalMinor;
}

/**
 * Как показать отличие суммы строк от итога заказа.
 *
 * `discountMinor` — это `работы + камни − итог`, поэтому он может быть
 * отрицательным: согласованная с клиентом сумма бывает БОЛЬШЕ суммы строк
 * (надбавка за срочность или сложность). В этом случае в интерфейсе нужна
 * строка «Надбавка» с плюсом, а не «Скидка» с минусом — иначе сотрудник
 * увидел бы отрицательную скидку, а итог выглядел бы необъяснимо большим.
 *
 * Функция общая для сервера и интерфейса: обе стороны обязаны трактовать
 * знак одинаково, иначе карточка покажет «скидку», которой нет.
 */
export function describeDiscount(discountMinor: Minor): {
  kind: 'NONE' | 'DISCOUNT' | 'SURCHARGE';
  /** Сумма без знака — знак задаёт `kind`. */
  amountMinor: Minor;
  label: string;
} {
  assertMinor(discountMinor, 'describeDiscount');

  if (discountMinor > 0) {
    return { kind: 'DISCOUNT', amountMinor: discountMinor, label: 'Скидка' };
  }
  if (discountMinor < 0) {
    return { kind: 'SURCHARGE', amountMinor: -discountMinor, label: 'Надбавка' };
  }
  return { kind: 'NONE', amountMinor: 0, label: '' };
}

/** Условие выдачи: заказ оплачен полностью (ТЗ п. 2.8). */
export function isPaidInFull(totalMinor: Minor, paidMinor: Minor): boolean {
  return paidMinor >= totalMinor;
}

/** Условие старта работ: предоплата внесена в достаточном объёме (ТЗ п. 2.5). */
export function isPrepaymentSatisfied(
  paidMinor: Minor,
  requiredMinor: Minor,
): boolean {
  if (requiredMinor <= 0) return true;
  return paidMinor >= requiredMinor;
}

/**
 * Форматирование суммы для отображения: «12 500,00 ₽».
 * Неразрывный пробел как разделитель разрядов (docs/10-nfr-security.md §8).
 */
export function formatMoney(minor: Minor, currency = 'RUB'): string {
  assertMinor(minor, 'formatMoney');
  const major = minor / MINOR_PER_UNIT;
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(major);
  const symbol = currency === 'RUB' ? '₽' : currency;
  return `${formatted.replace(/\u00A0/g, '\u00A0')} ${symbol}`;
}

/** Форматирование без копеек — для крупных показателей на дашборде. */
export function formatMoneyShort(minor: Minor, currency = 'RUB'): string {
  assertMinor(minor, 'formatMoneyShort');
  const major = minor / MINOR_PER_UNIT;
  const symbol = currency === 'RUB' ? '₽' : currency;
  if (Math.abs(major) >= 1_000_000) {
    return `${(major / 1_000_000).toFixed(1).replace('.', ',')} млн ${symbol}`;
  }
  if (Math.abs(major) >= 1_000) {
    return `${(major / 1_000).toFixed(1).replace('.', ',')} тыс. ${symbol}`;
  }
  return `${Math.round(major)} ${symbol}`;
}

/** Разбор введённой пользователем суммы («12 500,50», «12500.5») в копейки. */
export function parseMoneyInput(input: string): Minor | null {
  const cleaned = input.replace(/\s|\u00A0/g, '').replace(',', '.');
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * MINOR_PER_UNIT);
}