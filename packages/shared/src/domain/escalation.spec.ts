/**
 * Тесты эскалаций просрочки (задача 2.8, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Просроченный заказ сам о себе не сообщает: приёмщик узнаёт о
 * нём, когда клиент позвонит. Эскалация должна замечать срок и говорить об этом
 * ответственному, а если тот не отреагировал — руководителю.
 *
 * Ошибки здесь тихие и дорогие: ложная тревога учит игнорировать настоящую, а
 * пропущенная просрочка означает, что клиент узнает о задержке раньше цеха.
 * Поэтому проверяются ГРАНИЦЫ порога и то, что повторных уведомлений нет.
 *
 * Время передаётся в правило снаружи: воркер, читающий системные часы внутри,
 * невозможно проверить на границах — а именно там и живут ошибки.
 */

import { describe, expect, it } from 'vitest';
import {
  ESCALATION_LEVEL,
  MANAGER_ESCALATION_HOURS,
  assessEscalation,
  countWorkingHours,
  shouldEscalateAgain,
} from './escalation.js';
import { addWorkingHours, type WorkingCalendar } from '../utils/dates.js';

/** Пустой календарь: рабочие дни определяются по дню недели, выходные — сб/вс. */
const CALENDAR: WorkingCalendar = { overrides: new Map(), defaultHours: 9 };

/** Момент в московском времени (UTC+3). */
const msk = (iso: string): Date => new Date(`${iso}+03:00`);

/** Пятница, 16 сентября 2025 года, 12:00 МСК — середина рабочего дня. */
const FRIDAY_NOON = msk('2025-09-16T12:00:00');

describe('Оценка эскалации (задача 2.8)', () => {
  it('заказ без срока не эскалируется', () => {
    /*
     * `dueAt` не задан — значит, норматив для этапа не найден, и «просрочка»
     * была бы выдумкой. Порождать уведомления из отсутствия данных хуже, чем не
     * порождать их вовсе.
     */
    const state = assessEscalation({ dueAt: null, now: FRIDAY_NOON, calendar: CALENDAR });

    expect(state.isOverdue).toBe(false);
    expect(state.level).toBe(0);
  });

  it('заказ в срок не эскалируется', () => {
    const state = assessEscalation({
      dueAt: new Date(FRIDAY_NOON.getTime() + 3_600_000),
      now: FRIDAY_NOON,
      calendar: CALENDAR,
    });

    expect(state.isOverdue).toBe(false);
    expect(state.level).toBe(0);
  });

  it('ровно в срок заказ ещё не просрочен', () => {
    // Граница включительная: тревога ровно в секунду срока — ложная.
    const state = assessEscalation({ dueAt: FRIDAY_NOON, now: FRIDAY_NOON, calendar: CALENDAR });

    expect(state.isOverdue).toBe(false);
  });

  it('небольшая просрочка — только ответственный', () => {
    // Исполнителю нужно время решить вопрос самому: эскалация руководителю за
    // задержку на час превратилась бы в доносительство.
    const state = assessEscalation({
      dueAt: new Date(FRIDAY_NOON.getTime() - 2 * 3_600_000),
      now: FRIDAY_NOON,
      calendar: CALENDAR,
    });

    expect(state.isOverdue).toBe(true);
    expect(state.level).toBe(ESCALATION_LEVEL.RESPONSIBLE);
    expect(state.needsManager).toBe(false);
  });

  it('просрочка на рабочий день подключает руководителя', () => {
    const dueAt = addWorkingHours(FRIDAY_NOON, 0, CALENDAR);
    const later = addWorkingHours(dueAt, MANAGER_ESCALATION_HOURS, CALENDAR);

    const state = assessEscalation({ dueAt, now: later, calendar: CALENDAR });

    expect(state.needsManager).toBe(true);
    expect(state.level).toBe(ESCALATION_LEVEL.MANAGER);
  });

  it('порог руководителя — ровно один рабочий день', () => {
    // Порог выражен через ту же функцию, что и нормативы: иначе «один рабочий
    // день» в эскалации и в расчёте срока означал бы разное.
    expect(MANAGER_ESCALATION_HOURS).toBe(9);
  });

  it('за час до порога руководитель ещё не подключается', () => {
    /*
     * Проверка ГРАНИЦЫ, а не «примерно»: сдвиг порога на час меняет то, кого
     * побеспокоят, и ошибка здесь не видна глазом.
     */
    const dueAt = FRIDAY_NOON;
    const almost = addWorkingHours(dueAt, MANAGER_ESCALATION_HOURS - 1, CALENDAR);

    const state = assessEscalation({ dueAt, now: almost, calendar: CALENDAR });

    expect(state.needsManager).toBe(false);
    expect(state.level).toBe(ESCALATION_LEVEL.RESPONSIBLE);
  });

  it('уровень не понижается задним числом', () => {
    /*
     * Однажды подключённый руководитель остаётся в курсе. Иначе повторный
     * расчёт дал бы уровень ниже достигнутого, и воркер «забыл бы», что
     * руководителя уже оповестили, — и оповестил бы его заново.
     */
    const state = assessEscalation({
      dueAt: new Date(FRIDAY_NOON.getTime() - 3_600_000),
      now: FRIDAY_NOON,
      calendar: CALENDAR,
      currentLevel: ESCALATION_LEVEL.MANAGER,
    });

    expect(state.level).toBe(ESCALATION_LEVEL.MANAGER);
  });

  it('просрочка считается в рабочих часах, а не в календарных', () => {
    /*
     * «Просрочка больше суток» по календарю означает, что заказ, просроченный в
     * пятницу вечером, эскалируется руководителю в субботу — когда никто не
     * работает и решить ничего нельзя.
     */
    const fridayEvening = msk('2025-09-12T18:00:00');

    /*
     * Между пятницей и воскресеньем проходит ОДИН рабочий час — с 18:00 до
     * 19:00 пятницы. Календарно это больше суток, и «просрочка больше суток»
     * подняла бы руководителя в субботу, когда никто не работает.
     */
    const saturday = assessEscalation({
      dueAt: fridayEvening,
      now: msk('2025-09-13T12:00:00'),
      calendar: CALENDAR,
    });
    const sunday = assessEscalation({
      dueAt: fridayEvening,
      now: msk('2025-09-14T18:00:00'),
      calendar: CALENDAR,
    });

    expect(saturday.overdueWorkingHours).toBeCloseTo(1, 5);
    expect(saturday.needsManager).toBe(false);
    expect(sunday.overdueWorkingHours).toBeCloseTo(1, 5);
    expect(sunday.needsManager).toBe(false);
  });

  it('выходные не приближают эскалацию к руководителю', () => {
    /*
     * Заказ, просроченный в пятницу вечером, не должен эскалироваться
     * руководителю ни в субботу, ни в воскресенье: у ответственного не было
     * возможности отреагировать.
     */
    const fridayEvening = msk('2025-09-12T18:00:00');

    /*
     * За выходные проходит ОДИН рабочий час (18:00–19:00 пятницы). К вечеру
     * понедельника к нему добавляются 8 часов понедельника — итого 9, и только
     * тогда подключается руководитель. Если бы выходные считались календарно,
     * порог был бы пройден уже в субботу.
     */
    const saturday = assessEscalation({
      dueAt: fridayEvening,
      now: msk('2025-09-13T18:00:00'),
      calendar: CALENDAR,
    });
    const mondayMorning = assessEscalation({
      dueAt: fridayEvening,
      now: msk('2025-09-15T11:00:00'),
      calendar: CALENDAR,
    });
    const mondayEvening = assessEscalation({
      dueAt: fridayEvening,
      now: msk('2025-09-15T18:00:00'),
      calendar: CALENDAR,
    });

    expect(saturday.overdueWorkingHours).toBeCloseTo(1, 5);
    expect(saturday.needsManager).toBe(false);
    // К утру понедельника прошло всего 2 рабочих часа — руководителя ещё нет.
    expect(mondayMorning.overdueWorkingHours).toBeCloseTo(2, 5);
    expect(mondayMorning.needsManager).toBe(false);
    // К вечеру понедельника накопились все 9 — порог достигнут.
    expect(mondayEvening.overdueWorkingHours).toBeCloseTo(9, 5);
    expect(mondayEvening.needsManager).toBe(true);
  });
});

describe('Повторные уведомления', () => {
  it('уведомление отправляется только при повышении уровня', () => {
    /*
     * Ежедневное повторение одного и того же сообщения превращает ленту в шум,
     * и настоящее событие в ней теряется.
     */
    const state = assessEscalation({
      dueAt: new Date(FRIDAY_NOON.getTime() - 3_600_000),
      now: FRIDAY_NOON,
      calendar: CALENDAR,
    });

    expect(shouldEscalateAgain(state, 0)).toBe(true);
    expect(shouldEscalateAgain(state, ESCALATION_LEVEL.RESPONSIBLE)).toBe(false);
  });

  it('повышение до руководителя отправляется повторно', () => {
    // Новый адресат — новое событие: руководителя надо оповестить.
    const state = assessEscalation({
      dueAt: FRIDAY_NOON,
      now: addWorkingHours(FRIDAY_NOON, MANAGER_ESCALATION_HOURS + 1, CALENDAR),
      calendar: CALENDAR,
    });

    expect(shouldEscalateAgain(state, ESCALATION_LEVEL.RESPONSIBLE)).toBe(true);
  });

  it('заказ в срок не отправляется повторно', () => {
    const state = assessEscalation({
      dueAt: new Date(FRIDAY_NOON.getTime() + 3_600_000),
      now: FRIDAY_NOON,
      calendar: CALENDAR,
    });

    expect(shouldEscalateAgain(state, 0)).toBe(false);
  });
});

describe('Подсчёт рабочих часов', () => {
  it('внутри одного рабочего дня считает разницу', () => {
    const state = countWorkingHours(
      msk('2025-09-16T12:00:00'),
      msk('2025-09-16T15:00:00'),
      CALENDAR,
    );
    expect(state).toBeCloseTo(3, 5);
  });

  it('не считает часы до открытия и после закрытия', () => {
    // Рабочий день 10:00–19:00: с 8:00 до 11:00 прошёл один рабочий час.
    const state = countWorkingHours(
      msk('2025-09-16T08:00:00'),
      msk('2025-09-16T11:00:00'),
      CALENDAR,
    );
    expect(state).toBeCloseTo(1, 5);
  });

  it('не считает часы в выходной', () => {
    // Суббота: рабочий день не идёт, сколько бы времени ни прошло.
    const state = countWorkingHours(
      msk('2025-09-13T10:00:00'),
      msk('2025-09-13T18:00:00'),
      CALENDAR,
    );
    expect(state).toBe(0);
  });

  it('переносит часы через выходные', () => {
    // 18:00–19:00 пятницы плюс 10:00–11:00 понедельника = 2 рабочих часа.
    const state = countWorkingHours(
      msk('2025-09-12T18:00:00'),
      msk('2025-09-15T11:00:00'),
      CALENDAR,
    );
    expect(state).toBeCloseTo(2, 5);
  });

  it('нулевой и обратный интервал дают ноль', () => {
    const moment = msk('2025-09-16T12:00:00');
    expect(countWorkingHours(moment, moment, CALENDAR)).toBe(0);
    expect(countWorkingHours(moment, msk('2025-09-16T11:00:00'), CALENDAR)).toBe(0);
  });

  it('согласован с addWorkingHours', () => {
    /*
     * САМЫЙ ВАЖНЫЙ ТЕСТ. Рабочие часы считают ДВА независимых места: срок этапа
     * прибавляет `addWorkingHours`, эскалация считает `countWorkingHours`.
     * Расхождение означало бы, что «просрочено на один рабочий день» в сроке и
     * в эскалации — разные величины, и порог срабатывал бы не тогда, когда
     * задумано. Сверка привязывает обе реализации к общему календарю.
     */
    const start = msk('2025-09-16T12:00:00');
    for (const hours of [1, 3, 8, 9, 10, 20, 40]) {
      const reached = addWorkingHours(start, hours, CALENDAR);
      expect(countWorkingHours(start, reached, CALENDAR)).toBeCloseTo(hours, 4);
    }
  });

  it('согласован с addWorkingHours при пересечении выходных', () => {
    // Пятница вечер: срок уходит на следующую неделю, и подсчёт обязан совпасть.
    const start = msk('2025-09-12T17:00:00');
    for (const hours of [1, 2, 5, 9, 12]) {
      const reached = addWorkingHours(start, hours, CALENDAR);
      expect(countWorkingHours(start, reached, CALENDAR)).toBeCloseTo(hours, 4);
    }
  });
});
