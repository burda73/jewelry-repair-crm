/**
 * Тесты домена рекламаций (этап 6, ТЗ п. 2.9).
 *
 * ЧТО ЗДЕСЬ ОХРАНЯЕТСЯ. Срок рассмотрения рекламации — это обязательство перед
 * потребителем, а не удобство: просроченная рекламация означает нарушение срока
 * по закону. Поэтому проверяются именно те правила, ошибка в которых приводит к
 * незамеченному нарушению:
 *
 *  * срок считается в РАБОЧИХ днях: 10 календарных дней почти всегда попадают
 *    на выходные, и срок истекал бы в день, когда никто не работает;
 *  * предупреждение о сроке наступает ДО его истечения — иначе о рекламации
 *    узнают, когда она уже просрочена;
 *  * закрытая и отклонённая рекламация не считается просроченной, иначе список
 *    просроченных превратился бы в архив и перестал быть списком задач;
 *  * одобрение без способа возмещения и отказ без причины запрещены: иначе
 *    непонятно, что делать по рекламации, а клиент не знает причину отказа;
 *  * терминальные статусы не переоткрываются: иначе срок 10 дней обходится
 *    закрытием и повторным открытием рекламации.
 */

import { describe, expect, it } from 'vitest';
import type { WorkingCalendar } from '../utils/dates.js';
import { buildClaimNo } from './order-number.js';
import {
  CLAIM_REVIEW_WORKING_DAYS,
  CLAIM_STATUS,
  CLAIM_TRANSITION_DENIED,
  canTransitionClaim,
  claimTransitionDenial,
  claimWorkingDaysLeft,
  computeClaimDueAt,
  computeClaimWarningAt,
  isClaimOverdue,
  isClaimResolved,
  isClaimTerminal,
  needsClaimWarning,
} from './claims.js';

const CALENDAR: WorkingCalendar = { overrides: new Map(), defaultHours: 9 };

/** Момент в московском времени (UTC+3). */
const msk = (iso: string): Date => new Date(`${iso}+03:00`);

/** Понедельник, 15 сентября 2025 года, 12:00 МСК — середина рабочего дня. */
const MONDAY_NOON = msk('2025-09-15T12:00:00');

describe('Срок рассмотрения рекламации', () => {
  it('считает 10 РАБОЧИХ дней, а не календарных', () => {
    // От понедельника 10 рабочих дней — это понедельник через две недели.
    // Десять КАЛЕНДАРНЫХ дней дали бы 25 сентября (четверг), то есть срок
    // истёк бы на 4 дня раньше, чем предусмотрено.
    const due = computeClaimDueAt(MONDAY_NOON, CALENDAR);

    expect(due.toISOString().slice(0, 10)).toBe('2025-09-29');
  });

  it('пропускает выходные при расчёте срока', () => {
    // Пятница + 10 рабочих дней = пятница через две недели, а не среда.
    const friday = msk('2025-09-19T12:00:00');
    const due = computeClaimDueAt(friday, CALENDAR);

    expect(due.toISOString().slice(0, 10)).toBe('2025-10-03');
  });

  it('учитывает исключения календаря: перенос рабочего дня', () => {
    // Суббота объявлена рабочей — срок сокращается на день.
    const calendar: WorkingCalendar = {
      overrides: new Map([['2025-09-20', { isWorkday: true }]]),
      defaultHours: 9,
    };
    const due = computeClaimDueAt(MONDAY_NOON, calendar);

    expect(due.toISOString().slice(0, 10)).toBe('2025-09-26');
  });

  it('срок всегда позже даты открытия', () => {
    const due = computeClaimDueAt(MONDAY_NOON, CALENDAR);

    expect(due.getTime()).toBeGreaterThan(MONDAY_NOON.getTime());
  });

  it('десять рабочих дней — это ровно срок из ТЗ', () => {
    // Константа вынесена в домен, и её изменение обязано быть замечено: иначе
    // срок можно случайно сократить или продлить, не заметив этого.
    expect(CLAIM_REVIEW_WORKING_DAYS).toBe(10);
  });
});

describe('Предупреждение о сроке', () => {
  it('наступает за 3 рабочих дня до срока', () => {
    const due = computeClaimDueAt(MONDAY_NOON, CALENDAR);
    const warningAt = computeClaimWarningAt(due, CALENDAR);

    expect(warningAt.toISOString().slice(0, 10)).toBe('2025-09-24');
    expect(warningAt.getTime()).toBeLessThan(due.getTime());
  });

  it('не срабатывает сразу после открытия рекламации', () => {
    const due = computeClaimDueAt(MONDAY_NOON, CALENDAR);

    // Если предупреждать сразу, оно перестанет быть предупреждением.
    expect(needsClaimWarning(CLAIM_STATUS.OPENED, due, CALENDAR, MONDAY_NOON)).toBe(false);
  });

  it('срабатывает, когда до срока осталось меньше трёх рабочих дней', () => {
    const due = computeClaimDueAt(MONDAY_NOON, CALENDAR);
    const justBefore = msk('2025-09-26T12:00:00');

    expect(needsClaimWarning(CLAIM_STATUS.IN_REVIEW, due, CALENDAR, justBefore)).toBe(true);
  });

  it('срабатывает и после истечения срока', () => {
    const due = computeClaimDueAt(MONDAY_NOON, CALENDAR);
    const after = msk('2025-10-01T12:00:00');

    expect(needsClaimWarning(CLAIM_STATUS.IN_REVIEW, due, CALENDAR, after)).toBe(true);
  });

  it('молчит по закрытой рекламации, даже если срок давно прошёл', () => {
    const due = computeClaimDueAt(MONDAY_NOON, CALENDAR);
    const muchLater = msk('2026-01-01T12:00:00');

    // Закрытая рекламация — это история, а не задача.
    expect(needsClaimWarning(CLAIM_STATUS.CLOSED, due, CALENDAR, muchLater)).toBe(false);
  });
});

describe('Просрочка рекламации', () => {
  it('просрочена, когда срок истёк и решения нет', () => {
    const due = msk('2025-09-20T12:00:00');

    expect(isClaimOverdue(CLAIM_STATUS.IN_REVIEW, due, msk('2025-09-21T12:00:00'))).toBe(true);
  });

  it('не просрочена до наступления срока', () => {
    const due = msk('2025-09-20T12:00:00');

    expect(isClaimOverdue(CLAIM_STATUS.OPENED, due, msk('2025-09-19T12:00:00'))).toBe(false);
  });

  it('закрытая рекламация не бывает просроченной', () => {
    const due = msk('2025-09-20T12:00:00');

    // Иначе закрытые рекламации копились бы в списке просроченных навсегда.
    expect(isClaimOverdue(CLAIM_STATUS.CLOSED, due, msk('2026-01-01T12:00:00'))).toBe(false);
  });

  it('отклонённая рекламация не бывает просроченной', () => {
    const due = msk('2025-09-20T12:00:00');

    // Решение принято: рассмотрение состоялось, пусть и отказом.
    expect(isClaimOverdue(CLAIM_STATUS.REJECTED, due, msk('2026-01-01T12:00:00'))).toBe(false);
  });
});

describe('Остаток рабочих дней', () => {
  it('считает рабочие дни, а не календарные', () => {
    const due = computeClaimDueAt(MONDAY_NOON, CALENDAR);

    // От понедельника 15.09 до срока 29.09 — ровно 10 рабочих дней.
    expect(claimWorkingDaysLeft(due, CALENDAR, MONDAY_NOON)).toBe(10);
  });

  it('возвращает отрицательное значение при просрочке', () => {
    const due = msk('2025-09-19T12:00:00');
    const now = msk('2025-09-23T12:00:00');

    // Пятница → вторник: два рабочих дня просрочки (пн, вт).
    expect(claimWorkingDaysLeft(due, CALENDAR, now)).toBeLessThan(0);
  });

  it('не считает выходные остатком срока', () => {
    // Пятница → понедельник: один рабочий день, хотя календарно три.
    const due = msk('2025-09-22T12:00:00');
    const now = msk('2025-09-19T12:00:00');

    expect(claimWorkingDaysLeft(due, CALENDAR, now)).toBe(1);
  });
});

describe('Переходы статусов', () => {
  it('разрешает открытую взять в работу, одобрить или отклонить', () => {
    expect(canTransitionClaim(CLAIM_STATUS.OPENED, CLAIM_STATUS.IN_REVIEW)).toBe(true);
    expect(canTransitionClaim(CLAIM_STATUS.OPENED, CLAIM_STATUS.APPROVED)).toBe(true);
    expect(canTransitionClaim(CLAIM_STATUS.OPENED, CLAIM_STATUS.REJECTED)).toBe(true);
  });

  it('запрещает закрыть рекламацию, не зафиксировав исход', () => {
    // Из «открыта» сразу в «закрыта» — непонятно, что именно сделали.
    expect(canTransitionClaim(CLAIM_STATUS.OPENED, CLAIM_STATUS.CLOSED)).toBe(false);
  });

  it('запрещает закрыть одобренную рекламацию, минуя урегулирование', () => {
    // Одобрение подтверждает гарантийный случай, но не говорит, чем он
    // урегулирован; без этого отчёт не ответил бы, сколько вернули денег.
    expect(canTransitionClaim(CLAIM_STATUS.APPROVED, CLAIM_STATUS.CLOSED)).toBe(false);
    expect(canTransitionClaim(CLAIM_STATUS.APPROVED, CLAIM_STATUS.RESOLVED_REPAIR)).toBe(true);
    expect(canTransitionClaim(CLAIM_STATUS.APPROVED, CLAIM_STATUS.RESOLVED_REFUND)).toBe(true);
  });

  it('разрешает закрыть урегулированную рекламацию', () => {
    expect(canTransitionClaim(CLAIM_STATUS.RESOLVED_REPAIR, CLAIM_STATUS.CLOSED)).toBe(true);
    expect(canTransitionClaim(CLAIM_STATUS.RESOLVED_REFUND, CLAIM_STATUS.CLOSED)).toBe(true);
  });

  it('запрещает переоткрыть закрытую рекламацию', () => {
    // Иначе срок 10 дней обходится закрытием и открытием заново.
    expect(canTransitionClaim(CLAIM_STATUS.CLOSED, CLAIM_STATUS.IN_REVIEW)).toBe(false);
    expect(isClaimTerminal(CLAIM_STATUS.CLOSED)).toBe(true);
  });

  it('запрещает переоткрыть отклонённую рекламацию', () => {
    expect(canTransitionClaim(CLAIM_STATUS.REJECTED, CLAIM_STATUS.APPROVED)).toBe(false);
    expect(isClaimTerminal(CLAIM_STATUS.REJECTED)).toBe(true);
  });

  it('считает урегулированную нетерминальной: её нужно ещё закрыть', () => {
    expect(isClaimTerminal(CLAIM_STATUS.RESOLVED_REPAIR)).toBe(false);
  });

  it('требует причину при отказе', () => {
    const denial = claimTransitionDenial(CLAIM_STATUS.IN_REVIEW, CLAIM_STATUS.REJECTED, {});

    expect(denial).toBe(CLAIM_TRANSITION_DENIED.NO_REASON);
  });

  it('не принимает причину из одних пробелов', () => {
    const denial = claimTransitionDenial(CLAIM_STATUS.IN_REVIEW, CLAIM_STATUS.REJECTED, {
      rejectionReason: '   ',
    });

    // Пробел — это отсутствие причины, а не причина.
    expect(denial).toBe(CLAIM_TRANSITION_DENIED.NO_REASON);
  });

  it('пропускает отказ с причиной', () => {
    const denial = claimTransitionDenial(CLAIM_STATUS.IN_REVIEW, CLAIM_STATUS.REJECTED, {
      rejectionReason: 'Следы механического воздействия, не гарантийный случай',
    });

    expect(denial).toBeNull();
  });

  it('не требует причины для одобрения', () => {
    expect(claimTransitionDenial(CLAIM_STATUS.IN_REVIEW, CLAIM_STATUS.APPROVED, {})).toBeNull();
  });

  it('отклоняет недопустимый переход до проверки требований', () => {
    // Из закрытой в одобренную: сначала терминальность, а не «нет причины».
    const denial = claimTransitionDenial(CLAIM_STATUS.CLOSED, CLAIM_STATUS.APPROVED, {});

    expect(denial).toBe(CLAIM_TRANSITION_DENIED.TERMINAL);
  });

  it('сообщает о недопустимом переходе отдельным кодом', () => {
    const denial = claimTransitionDenial(CLAIM_STATUS.OPENED, CLAIM_STATUS.CLOSED, {});

    expect(denial).toBe(CLAIM_TRANSITION_DENIED.ILLEGAL);
  });
});

describe('Урегулирование рекламации', () => {
  it('считает урегулированием ремонт и возврат', () => {
    expect(isClaimResolved(CLAIM_STATUS.RESOLVED_REPAIR)).toBe(true);
    expect(isClaimResolved(CLAIM_STATUS.RESOLVED_REFUND)).toBe(true);
  });

  it('не считает урегулированием закрытие без исхода', () => {
    // «Закрыта» не говорит, чем закончилось дело.
    expect(isClaimResolved(CLAIM_STATUS.CLOSED)).toBe(false);
  });

  it('не считает урегулированием отказ', () => {
    expect(isClaimResolved(CLAIM_STATUS.REJECTED)).toBe(false);
  });

  it('не считает урегулированием одобрение без исполнения', () => {
    // Случай признан гарантийным, но работа ещё не сделана.
    expect(isClaimResolved(CLAIM_STATUS.APPROVED)).toBe(false);
  });
});

describe('Номер рекламации', () => {
  it('строит номер в формате РЕК-ГГ-00001', () => {
    // Номер берётся из общего модуля нумерации (`order-number.ts`), а не
    // дублируется здесь: иначе рекламации получили бы два разных формата в
    // зависимости от того, какой код вызвал построение.
    expect(buildClaimNo(new Date('2026-01-01T00:00:00Z'), 1)).toBe('РЕК-26-00001');
  });

  it('не обрезает номер больше пяти цифр', () => {
    // Обрезка сделалала бы номера неуникальными.
    expect(buildClaimNo(new Date('2026-01-01T00:00:00Z'), 123456)).toBe('РЕК-26-123456');
  });
});
