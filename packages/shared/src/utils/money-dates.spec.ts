/**
 * Тесты денежных расчётов и работы с датами.
 * Проверяют ключевые бизнес-правила ТЗ: предоплата (п. 2.5), выдача (п. 2.8),
 * гарантия и рекламация (п. 2.9).
 */

import { describe, expect, it } from 'vitest';
import {
  toMinor,
  toMajor,
  sumMinor,
  multiplyMinor,
  calcOrderTotal,
  discountForTotal,
  describeDiscount,
  remainingToPay,
  isPaidInFull,
  isPrepaymentSatisfied,
  formatMoney,
  parseMoneyInput,
} from './money.js';
import {
  addWorkingDays,
  addCalendarDays,
  addWorkingHours,
  workingDaysBetween,
  computeWarrantyUntil,
  isOverdue,
  isOverdueForManager,
  normalizePhone,
  formatPhone,
  formatDuration,
  toDateKey,
  type WorkingCalendar,
} from './dates.js';

/**
 * Календарь без исключений.
 *
 * ВНИМАНИЕ: это не «без праздников». Государственные праздники РФ встроены в
 * код (domain/working-calendar.ts) и действуют всегда, поэтому новогодние даты
 * здесь больше не годятся для проверки «пропуска выходных»: 1–8 января нерабочие
 * независимо от содержимого календаря. Для проверки выходных взят сентябрь.
 */
const plainCalendar: WorkingCalendar = { overrides: new Map(), defaultHours: 8 };

/**
 * Календарь с исключениями администратора.
 *
 * 1 января объявлено нерабочим (совпадает со встроенным праздником), а
 * 4 января — рабочим: так проверяется, что исключение из базы сильнее
 * встроенного списка. 8 сентября 2025 (понедельник) объявлено выходным —
 * эту дату нельзя получить правилом «сб/вс», поэтому она доказывает, что
 * учитывается именно календарь из базы, а не только день недели.
 */
const holidayCalendar: WorkingCalendar = {
  overrides: new Map([
    ['2025-01-01', { isWorkday: false }],
    ['2025-01-04', { isWorkday: true }],
    ['2025-09-08', { isWorkday: false }],
  ]),
  defaultHours: 8,
};

describe('Деньги: преобразования', () => {
  it('рубли → копейки', () => {
    expect(toMinor(125)).toBe(12500);
    expect(toMinor('125.50')).toBe(12550);
    expect(toMinor('125,50')).toBe(12550);
  });

  it('округляет дробные копейки корректно', () => {
    expect(toMinor(0.005)).toBe(1);
    expect(toMinor(0.004)).toBe(0);
  });

  it('отклоняет некорректную сумму', () => {
    expect(() => toMinor('abc')).toThrow(RangeError);
    expect(() => toMinor(Number.NaN)).toThrow(RangeError);
  });

  it('копейки → рубли', () => {
    expect(toMajor(12550)).toBe(125.5);
  });

  it('отклоняет дробные копейки при обратном преобразовании', () => {
    expect(() => toMajor(125.5)).toThrow(RangeError);
  });
});

describe('Деньги: арифметика', () => {
  it('суммирует без потери точности там, где Float ошибается', () => {
    // 0.1 + 0.2 в float даёт 0.30000000000000004
    expect(sumMinor(10, 20)).toBe(30);
    expect(sumMinor()).toBe(0);
  });

  it('умножает на дробное количество с округлением', () => {
    expect(multiplyMinor(1000, 2)).toBe(2000);
    expect(multiplyMinor(1000, 1.5)).toBe(1500);
    expect(multiplyMinor(333, 3)).toBe(999);
  });
});

describe('Деньги: бизнес-правила заказа', () => {
  it('итог заказа = работы + камни − скидка', () => {
    expect(
      calcOrderTotal({ worksTotalMinor: 100000, stonesTotalMinor: 25000, discountMinor: 5000 }),
    ).toBe(120000);
  });

  it('итог не может быть отрицательным', () => {
    expect(
      calcOrderTotal({ worksTotalMinor: 1000, stonesTotalMinor: 0, discountMinor: 5000 }),
    ).toBe(0);
  });

  it('остаток к оплате не отрицателен при переплате', () => {
    expect(remainingToPay(100000, 120000)).toBe(0);
    expect(remainingToPay(100000, 40000)).toBe(60000);
  });

  it('ТЗ п. 2.8: выдача возможна только при полной оплате', () => {
    expect(isPaidInFull(100000, 100000)).toBe(true);
    expect(isPaidInFull(100000, 100001)).toBe(true); // переплата
    expect(isPaidInFull(100000, 99999)).toBe(false);
  });

  it('ТЗ п. 2.5: предоплата достаточна только при покрытии требуемой суммы', () => {
    expect(isPrepaymentSatisfied(30000, 30000)).toBe(true);
    expect(isPrepaymentSatisfied(29999, 30000)).toBe(false);
  });

  it('ТЗ п. 2.5: если предоплата не требуется — работы не блокируются', () => {
    expect(isPrepaymentSatisfied(0, 0)).toBe(true);
  });
});

/*
 * Скидка и надбавка.
 *
 * Дефект, ради которого эти тесты написаны: корректировка итога «вверх»
 * (надбавка за срочность) обнуляла скидку и присваивала итог напрямую.
 * Инвариант `итог = работы + камни − скидка` (docs/03-data-model.md §3.2)
 * после этого нарушался, и ночная сверка итогов с платежами дала бы
 * расхождение. Проверяем не «функция вернула число», а что инвариант
 * выполняется при любом знаке разницы.
 */
describe('Деньги: скидка и надбавка', () => {
  it('скидка делает итог равным заданному (уменьшение)', () => {
    const works = 45_000;
    const discount = discountForTotal({
      worksTotalMinor: works,
      stonesTotalMinor: 0,
      targetTotalMinor: 30_000,
    });
    expect(discount).toBe(15_000);
    expect(
      calcOrderTotal({ worksTotalMinor: works, stonesTotalMinor: 0, discountMinor: discount }),
    ).toBe(30_000);
  });

  it('надбавка даёт ОТРИЦАТЕЛЬНУЮ скидку, а не ноль', () => {
    // Было: скидка обнулялась, итог присваивался — инвариант ломался.
    const discount = discountForTotal({
      worksTotalMinor: 45_000,
      stonesTotalMinor: 0,
      targetTotalMinor: 60_000,
    });
    expect(discount).toBe(-15_000);
    expect(
      calcOrderTotal({ worksTotalMinor: 45_000, stonesTotalMinor: 0, discountMinor: discount }),
    ).toBe(60_000);
  });

  it('инвариант итога выполняется для любого знака разницы', () => {
    const works = 45_000;
    const stones = 5_000;
    for (const target of [0, 1, 30_000, 50_000, 60_000, 120_000]) {
      const discount = discountForTotal({
        worksTotalMinor: works,
        stonesTotalMinor: stones,
        targetTotalMinor: target,
      });
      // calcOrderTotal не опускается ниже нуля, поэтому цель 0 и 1 дают 0.
      const expected = Math.max(0, target);
      expect(
        calcOrderTotal({
          worksTotalMinor: works,
          stonesTotalMinor: stones,
          discountMinor: discount,
        }),
      ).toBe(expected);
    }
  });

  it('скидка, надбавка и их отсутствие различаются', () => {
    expect(describeDiscount(15_000)).toEqual({
      kind: 'DISCOUNT',
      amountMinor: 15_000,
      label: 'Скидка',
    });
    expect(describeDiscount(-15_000)).toEqual({
      kind: 'SURCHARGE',
      amountMinor: 15_000,
      label: 'Надбавка',
    });
    expect(describeDiscount(0)).toEqual({ kind: 'NONE', amountMinor: 0, label: '' });
  });

  it('сумма без знака: знак задаёт kind, а не значение', () => {
    // Интерфейс подставляет «−» для DISCOUNT и «+» для SURCHARGE,
    // поэтому amountMinor обязан быть неотрицательным.
    expect(describeDiscount(-1).amountMinor).toBe(1);
    expect(describeDiscount(1).amountMinor).toBe(1);
  });
});

describe('Деньги: форматирование', () => {
  it('форматирует сумму в рублях с копейками', () => {
    const formatted = formatMoney(1250000);
    expect(formatted).toContain('12');
    expect(formatted).toContain('500,00');
    expect(formatted).toContain('₽');
  });

  it('разбирает пользовательский ввод в копейки', () => {
    expect(parseMoneyInput('12 500,50')).toBe(1250050);
    expect(parseMoneyInput('12500.5')).toBe(1250050);
    expect(parseMoneyInput('')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
  });

  it('разбор и форматирование взаимно обратны', () => {
    const minor = parseMoneyInput('1 234,56');
    expect(minor).toBe(123456);
    expect(formatMoney(minor!)).toContain('1');
  });
});

describe('Даты: рабочие дни (ТЗ п. 2.7, 2.9)', () => {
  it('прибавляет рабочие дни, пропуская выходные', () => {
    // Пятница 2025-09-05 + 1 рабочий день = понедельник 2025-09-08.
    // (Раньше здесь была пятница 03.01.2025, но теперь 1–8 января — встроенные
    // новогодние каникулы, поэтому дата для проверки ВЫХОДНЫХ взята в сентябре.)
    const friday = new Date('2025-09-05T10:00:00Z');
    expect(toDateKey(addWorkingDays(friday, 1, plainCalendar))).toBe('2025-09-08');
  });

  it('учитывает праздники производственного календаря из базы', () => {
    // Пятница 2025-09-05 + 1 рабочий день: 8 сентября объявлено выходным
    // исключением администратора, значит следующий рабочий день — 9 сентября.
    const friday = new Date('2025-09-05T10:00:00Z');
    expect(toDateKey(addWorkingDays(friday, 1, holidayCalendar))).toBe('2025-09-09');
  });

  it('учитывает перенесённый рабочий день (суббота рабочая)', () => {
    // Суббота 2025-01-04 объявлена рабочей: пятница 03.01 + 1 = суббота 04.01
    const friday = new Date('2025-01-03T10:00:00Z');
    expect(toDateKey(addWorkingDays(friday, 1, holidayCalendar))).toBe('2025-01-04');
  });

  it('ТЗ п. 2.9: 10 рабочих дней на рекламацию — считает верно', () => {
    // Понедельник 2025-09-01 + 10 рабочих дней = понедельник 2025-09-15
    const monday = new Date('2025-09-01T09:00:00Z');
    expect(toDateKey(addWorkingDays(monday, 10, plainCalendar))).toBe('2025-09-15');
  });

  it('ноль рабочих дней не сдвигает дату', () => {
    const date = new Date('2025-09-01T09:00:00Z');
    expect(addWorkingDays(date, 0, plainCalendar).getTime()).toBe(date.getTime());
  });

  it('прибавляет календарные дни (30 дней хранения, ТЗ п. 2.8)', () => {
    const date = new Date('2025-09-01T09:00:00Z');
    expect(toDateKey(addCalendarDays(date, 30))).toBe('2025-10-01');
  });

  it('считает рабочие дни между датами', () => {
    const from = new Date('2025-09-01T09:00:00Z'); // пн
    const to = new Date('2025-09-08T09:00:00Z'); // следующий пн
    expect(workingDaysBetween(from, to, plainCalendar)).toBe(5);
  });

  it('рабочие часы сдвигают внутри рабочего окна', () => {
    const date = new Date('2025-09-01T10:00:00Z');
    const result = addWorkingHours(date, 2, plainCalendar);
    expect(result.getTime()).toBeGreaterThan(date.getTime());
  });
});

describe('Даты: гарантия (ТЗ п. 2.9)', () => {
  it('берёт максимальный срок гарантии из работ: закрепка 3 мес. не отменяет 6 мес.', () => {
    const completed = new Date('2025-01-15T12:00:00Z');
    const until = computeWarrantyUntil(completed, [6, 3]);
    expect(toDateKey(until)).toBe('2025-07-15');
  });

  it('если все работы короткие — 3 месяца (закрепка)', () => {
    const completed = new Date('2025-01-15T12:00:00Z');
    const until = computeWarrantyUntil(completed, [3, 3]);
    expect(toDateKey(until)).toBe('2025-04-15');
  });

  it('по умолчанию 6 месяцев, если работ нет', () => {
    const completed = new Date('2025-01-15T12:00:00Z');
    expect(toDateKey(computeWarrantyUntil(completed, []))).toBe('2025-07-15');
  });
});

describe('Даты: просрочки и эскалации (ТЗ п. 2.7)', () => {
  it('определяет просрочку', () => {
    const now = new Date('2025-09-10T12:00:00Z');
    expect(isOverdue(new Date('2025-09-09T12:00:00Z'), now)).toBe(true);
    expect(isOverdue(new Date('2025-09-11T12:00:00Z'), now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });

  it('эскалация руководителю только при просрочке более рабочего дня', () => {
    const dueAt = new Date('2025-09-08T10:00:00Z'); // понедельник
    // В тот же день просрочки ещё нет по норме «более 1 рабочего дня»
    expect(isOverdueForManager(dueAt, new Date('2025-09-08T18:00:00Z'), plainCalendar)).toBe(false);
    // Через день — есть
    expect(isOverdueForManager(dueAt, new Date('2025-09-09T18:00:00Z'), plainCalendar)).toBe(true);
  });

  it('не эскалирует, если срок не наступил', () => {
    const dueAt = new Date('2025-12-31T10:00:00Z');
    expect(isOverdueForManager(dueAt, new Date('2025-09-08T10:00:00Z'), plainCalendar)).toBe(false);
  });
});

describe('Телефоны (для поиска и сопоставления звонков, ТЗ п. 2.4)', () => {
  it('нормализует российские номера в E.164', () => {
    expect(normalizePhone('8 916 123-45-67')).toBe('+79161234567');
    expect(normalizePhone('+7 (916) 123-45-67')).toBe('+79161234567');
    expect(normalizePhone('79161234567')).toBe('+79161234567');
    expect(normalizePhone('9161234567')).toBe('+79161234567');
  });

  it('возвращает null для мусора', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
  });

  it('разные форматы одного номера дают одинаковый результат', () => {
    const variants = ['8 916 123 45 67', '+79161234567', '(916) 123-4567', '7916 1234567'];
    const normalized = variants.map((v) => normalizePhone(v));
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('+79161234567');
  });

  it('форматирует телефон для отображения', () => {
    expect(formatPhone('+79161234567')).toBe('+7 916 123-45-67');
    expect(formatPhone(null)).toBe('—');
  });
});

describe('Форматирование длительности', () => {
  it('минуты, часы, дни', () => {
    expect(formatDuration(45)).toBe('45 мин');
    expect(formatDuration(60)).toBe('1 ч');
    expect(formatDuration(150)).toBe('2 ч 30 мин');
    expect(formatDuration(60 * 25)).toBe('1 д 1 ч');
  });
});
