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

  it('срок по умолчанию приходит параметром, а не жёсткой шестёркой', () => {
    /*
     * `WARRANTY_MONTHS_DEFAULT` объявлена в схеме окружения с самого начала, но
     * в коде стояла жёсткая «6»: изменение переменной не меняло ничего. Тот же
     * класс дефекта, что «Дефект 41», 50, 51 и 52.
     */
    const completed = new Date('2025-01-15T12:00:00Z');
    expect(toDateKey(computeWarrantyUntil(completed, [], 12))).toBe('2026-01-15');
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

describe('Рабочие часы: точный сдвиг (дефект 31)', () => {
  const calendar: WorkingCalendar = { overrides: new Map(), defaultHours: 9 };
  const msk = (iso: string): Date => new Date(`${iso}+03:00`);
  const localTime = (date: Date): string =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Moscow',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(date);

  it('«плюс один рабочий час» сдвигает время на час', () => {
    /*
     * ДЕФЕКТ 31. Прежняя версия засчитывала час ДО сдвига, поэтому
     * `addWorkingHours(t, 1)` возвращала сам `t` — сдвига не было вовсе. Каждый
     * норматив в рабочих часах истекал на час раньше, и заказ становился
     * «просроченным» до наступления срока.
     */
    const from = msk('2025-09-16T12:00:00');
    expect(localTime(addWorkingHours(from, 1, calendar))).toBe('2025-09-16 13:00');
  });

  it('норматив в 8 рабочих часов не истекает на час раньше', () => {
    // Отправка в 12:00 вторника при норме 8 часов даёт 11:00 среды, не 10:00:
    // рабочий день кончается в 19:00, до него проходит 7 часов, восьмой — утром.
    const from = msk('2025-09-16T12:00:00');
    expect(localTime(addWorkingHours(from, 8, calendar))).toBe('2025-09-17 11:00');
  });

  it('сдвиг на 9 часов переносит на следующий рабочий день', () => {
    const from = msk('2025-09-16T12:00:00');
    expect(localTime(addWorkingHours(from, 9, calendar))).toBe('2025-09-17 12:00');
  });

  it('часы не начисляются вне рабочего окна', () => {
    /*
     * 20:00 — после закрытия: до 10:00 следующего дня время идёт, но не
     * засчитывается. Отработанный час — это интервал 10:00–11:00, поэтому
     * результат 11:00, а не 10:00: сотрудник начинает в 10:00 и заканчивает
     * через час.
     */
    const from = msk('2025-09-16T20:00:00');
    expect(localTime(addWorkingHours(from, 1, calendar))).toBe('2025-09-17 11:00');
  });

  it('норматив упирается ровно в конец рабочего дня', () => {
    /*
     * От 15:00 до закрытия (19:00) остаётся ровно 4 рабочих часа: интервалы
     * 15–16, 16–17, 17–18 и 18–19. Норматив в 4 часа обязан истечь в 19:00, а не
     * перенестись на следующий день: иначе последний час рабочего дня «терялся»
     * бы, и сроки сдвигались бы на сутки.
     */
    const from = msk('2025-09-16T15:00:00');
    expect(localTime(addWorkingHours(from, 4, calendar))).toBe('2025-09-16 19:00');
    // Пятый час уже не помещается в окно и уходит на следующий день.
    expect(localTime(addWorkingHours(from, 5, calendar))).toBe('2025-09-17 11:00');
  });

  it('выходной пропускается', () => {
    // Пятница 18:00 + 2 часа = понедельник 11:00: один час в пятницу, один в пн.
    const from = msk('2025-09-12T18:00:00');
    expect(localTime(addWorkingHours(from, 2, calendar))).toBe('2025-09-15 11:00');
  });

  it('нулевой и отрицательный сдвиг возвращают исходный момент', () => {
    const from = msk('2025-09-16T12:00:00');
    expect(addWorkingHours(from, 0, calendar).getTime()).toBe(from.getTime());
    expect(addWorkingHours(from, -5, calendar).getTime()).toBe(from.getTime());
  });
});
