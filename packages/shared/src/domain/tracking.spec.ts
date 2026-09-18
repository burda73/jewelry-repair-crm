/**
 * Тесты оценки партии «в пути» (задача 2.6).
 *
 * ЧТО ЗАЩИЩАЮТ ЭТИ ПРАВИЛА. Партия уехала, и до приёмки о ней ничего не
 * известно: логист не видит, какая машина не доехала, а получатель не знает,
 * когда ждать. Изделия клиентов при этом «в пути» сколько угодно долго.
 *
 * ПОЧЕМУ ПРОВЕРЯЮТСЯ ГРАНИЦЫ, А НЕ «ПРОСТО ПРОСРОЧЕНО». Флаг «просрочено»
 * загорается сразу и перестаёт различать «опаздывает на 20 минут» и «пропала
 * сутки назад». Уровни должны переключаться на границах норматива, и сдвиг
 * границы меняет приоритет в интерфейсе — поэтому границы проверяются точно.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSIT_NORM_HOURS,
  TRANSIT_LEVEL,
  assessTransit,
  formatHours,
  isOrderInTransit,
} from './tracking.js';

const NOW = new Date('2025-09-16T12:00:00Z');

/** Момент отправки, отстоящий от `NOW` на указанное число часов. */
const sentHoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

describe('Оценка партии в пути (задача 2.6)', () => {
  it('партия без отправки не считается просроченной', () => {
    // Иначе каждая созданная партия сразу попадала бы в тревоги.
    const state = assessTransit({ dispatchedAt: null, now: NOW });

    expect(state.elapsedHours).toBeNull();
    expect(state.isOverdue).toBe(false);
    expect(state.level).toBe(TRANSIT_LEVEL.ON_TIME);
    expect(state.message).toContain('не отправлена');
  });

  it('партия в пределах норматива — в норме', () => {
    const state = assessTransit({ dispatchedAt: sentHoursAgo(3), now: NOW, normHours: 8 });

    expect(state.level).toBe(TRANSIT_LEVEL.ON_TIME);
    expect(state.isOverdue).toBe(false);
    expect(state.elapsedHours).toBeCloseTo(3, 5);
  });

  it('ровно на границе норматива партия ещё в норме', () => {
    /*
     * Граница включительная: «уложились в норматив» не должно считаться
     * опозданием, иначе тревога поднималась бы на ровном месте.
     */
    const state = assessTransit({ dispatchedAt: sentHoursAgo(8), now: NOW, normHours: 8 });

    expect(state.level).toBe(TRANSIT_LEVEL.ON_TIME);
    expect(state.isOverdue).toBe(false);
  });

  it('превышение норматива — «задерживается»', () => {
    const state = assessTransit({ dispatchedAt: sentHoursAgo(9), now: NOW, normHours: 8 });

    expect(state.level).toBe(TRANSIT_LEVEL.LATE);
    expect(state.isOverdue).toBe(true);
    expect(state.message).toContain('задерживается');
  });

  it('двукратное превышение — «тревога»', () => {
    /*
     * Различие уровней принципиально: «опаздывает на час» и «пропала сутки
     * назад» требуют разных действий, а один флаг «просрочено» их уравнивает.
     */
    const state = assessTransit({ dispatchedAt: sentHoursAgo(16), now: NOW, normHours: 8 });

    expect(state.level).toBe(TRANSIT_LEVEL.OVERDUE);
    expect(state.isOverdue).toBe(true);
    expect(state.message).toContain('не подтверждена');
  });

  it('ровно на двукратной границе — уже «тревога»', () => {
    // Граница переключения уровня проверяется точно: сдвиг меняет приоритет
    // партии в списке.
    const state = assessTransit({ dispatchedAt: sentHoursAgo(16), now: NOW, normHours: 8 });

    expect(state.level).toBe(TRANSIT_LEVEL.OVERDUE);
  });

  it('норматив из настройки применяется', () => {
    // Междугородний рейс и городской имеют разную норму: без этого «в пути 6
    // часов» ничего не значит.
    const state = assessTransit({ dispatchedAt: sentHoursAgo(6), now: NOW, normHours: 48 });

    expect(state.level).toBe(TRANSIT_LEVEL.ON_TIME);
    expect(state.normHours).toBe(48);
  });

  it('нулевой норматив заменяется значением по умолчанию', () => {
    /*
     * Деление на ноль дало бы `Infinity`, и партия навсегда осталась бы «в
     * норме» — тревога не сработала бы никогда. Значение приходит из настройки,
     * которую заполняет человек.
     */
    const state = assessTransit({ dispatchedAt: sentHoursAgo(100), now: NOW, normHours: 0 });

    expect(state.normHours).toBe(DEFAULT_TRANSIT_NORM_HOURS);
    expect(state.isOverdue).toBe(true);
  });

  it('отрицательный норматив и NaN заменяются значением по умолчанию', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const state = assessTransit({ dispatchedAt: sentHoursAgo(100), now: NOW, normHours: bad });
      expect(state.normHours).toBe(DEFAULT_TRANSIT_NORM_HOURS);
    }
  });

  it('будущая отметка отправки не даёт отрицательного времени', () => {
    // Сбитые часы или ручная правка: «в пути −3 часа» бессмысленно.
    const state = assessTransit({
      dispatchedAt: new Date(NOW.getTime() + 3 * 3_600_000),
      now: NOW,
    });

    expect(state.elapsedHours).toBe(0);
    expect(state.level).toBe(TRANSIT_LEVEL.ON_TIME);
  });

  it('долгая задержка выражается в сутках', () => {
    // «В пути 74 ч» приходится пересчитывать в уме.
    const state = assessTransit({ dispatchedAt: sentHoursAgo(74), now: NOW, normHours: 8 });

    expect(state.message).toContain('3 сут 2 ч');
  });
});

describe('Формат часов', () => {
  it('до суток — целые часы', () => {
    expect(formatHours(0)).toBe('0 ч');
    expect(formatHours(5.9)).toBe('5 ч');
    expect(formatHours(23.9)).toBe('23 ч');
  });

  it('от суток — дни и часы', () => {
    expect(formatHours(24)).toBe('1 сут');
    expect(formatHours(25)).toBe('1 сут 1 ч');
    expect(formatHours(48)).toBe('2 сут');
    expect(formatHours(74)).toBe('3 сут 2 ч');
  });
});

describe('Заказ в пути', () => {
  it('распознаёт оба направления перевозки', () => {
    // У «в пути» два статуса: в цех и из цеха. Проверка только одного оставила
    // бы половину заказов вне отслеживания.
    expect(isOrderInTransit('IN_TRANSIT_TO_PRODUCTION')).toBe(true);
    expect(isOrderInTransit('IN_TRANSIT_TO_STORE')).toBe(true);
  });

  it('не считает «в пути» другие статусы', () => {
    // `IN_PRODUCTION` и `READY_FOR_PICKUP` означают, что изделие уже на месте.
    for (const status of ['IN_PRODUCTION', 'READY_FOR_PICKUP', 'QUEUED_FOR_DISPATCH', 'DRAFT']) {
      expect(isOrderInTransit(status)).toBe(false);
    }
  });
});
