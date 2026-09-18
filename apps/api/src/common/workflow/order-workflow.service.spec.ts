/**
 * Тесты расчёта нормативного срока (задача 1.3.4, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Они закрывают дефект, который lived в продакшне и не был
 * виден ни одному тесту: норматив НИКОГДА не находился, поэтому `dueAt` не
 * устанавливался вообще. Причины было три, и каждая проверяется здесь:
 *
 *  1. расчёт искал норматив по имени СТАТУСА (`QUEUED_FOR_DISPATCH`), а
 *     справочник заполнен ЭТАПАМИ (`QUEUE`) — совпадений 0 из 13;
 *  2. существовали ТРИ несогласованных словаря этапов: справочник
 *     (`DISPATCH`/`DELIVERY_OUT`/`DELIVERY_IN`/`STORAGE`), домен
 *     (`QUEUE`/`LOGISTICS_OUT`/`LOGISTICS_IN`/`PICKUP`) и статусы;
 *  3. значением по умолчанию для срока было `order.readyAt` — ДРУГОЕ поле
 *     (дата готовности), поэтому переход без норматива переписывал срок выдачи
 *     датой готовности.
 *
 * Прежний тест (`stage-norms.spec.ts`) этого не ловил, потому что полностью
 * дублировал логику сервиса вместо её вызова: он проверял копию, а не код.
 * Здесь вызывается настоящий `computeDueAt` и настоящий `stageForStatus`.
 *
 * Проверено на живом сервере до исправления: заказ `MSK1-2609-000006` перешёл в
 * `QUEUED_FOR_DISPATCH` (переход с эффектом `SET_DUE_AT`) и остался с
 * `dueAt = NULL`, при заполненном справочнике из 9 нормативов.
 */

import { describe, expect, it } from 'vitest';
import { computeDueAt } from './order-workflow.service';
import {
  ALL_NORM_STAGES,
  ORDER_STATUS,
  STATUS_STAGE,
  NORM_STAGE,
  stageForStatus,
  toDateKey,
  type WorkingCalendar,
} from '@app/shared';
import { ORDER_TRANSITIONS } from '@app/shared';

/** Календарь без исключений: будни рабочие, праздники — по ТК РФ. */
const CALENDAR: WorkingCalendar = { overrides: new Map(), defaultHours: 8 };

/** Сентябрь 2027: 17-е — пятница, 18–19 — выходные, 20 — понедельник. */
const FRIDAY = new Date('2027-09-17T12:00:00Z');

describe('stageForStatus: этап по статусу', () => {
  it('сопоставляет статус с этапом справочника', () => {
    // Именно это сопоставление отсутствовало: в справочник передавался статус.
    expect(stageForStatus(ORDER_STATUS.QUEUED_FOR_DISPATCH)).toBe(NORM_STAGE.QUEUE);
    expect(stageForStatus(ORDER_STATUS.IN_PRODUCTION)).toBe(NORM_STAGE.PRODUCTION);
    expect(stageForStatus(ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION)).toBe(NORM_STAGE.LOGISTICS_OUT);
    expect(stageForStatus(ORDER_STATUS.IN_TRANSIT_TO_STORE)).toBe(NORM_STAGE.LOGISTICS_IN);
    expect(stageForStatus(ORDER_STATUS.AWAITING_APPROVAL)).toBe(NORM_STAGE.APPROVAL);
    expect(stageForStatus(ORDER_STATUS.AWAITING_PREPAYMENT)).toBe(NORM_STAGE.PREPAYMENT);
  });

  it('возвращает null для этапов без норматива срока', () => {
    // `ACCEPTED` — «принят в работу»: срок задаётся следующим этапом, и
    // придумывать ему норматив значило бы обещать клиенту произвольную дату.
    expect(stageForStatus(ORDER_STATUS.ACCEPTED)).toBeNull();
    expect(stageForStatus(ORDER_STATUS.DRAFT)).toBeNull();
  });

  it('не выдаёт этап для закрытых заказов', () => {
    // Закрытый заказ никого не торопит: срок ему не назначается.
    for (const status of [ORDER_STATUS.COMPLETED, ORDER_STATUS.REFUSED, ORDER_STATUS.CANCELLED]) {
      expect(stageForStatus(status)).toBeNull();
    }
  });

  it('КАЖДЫЙ этап справочника достижим хотя бы одним статусом или известен как отдельный процесс', () => {
    // Регрессия на расхождение словарей: если этап есть в NORM_STAGE, но
    // недостижим ни одним статусом, его норматив — мёртвая строка.
    const reachable = new Set(
      Object.values(ORDER_STATUS)
        .map((status) => stageForStatus(status))
        .filter((stage): stage is NonNullable<typeof stage> => stage !== null),
    );
    // CLAIM — рассмотрение рекламации: отдельный процесс (WarrantyClaim), у
    // заказа статуса нет, поэтому проверяется отдельно.
    const standalone = new Set<string>([NORM_STAGE.CLAIM]);

    for (const stage of ALL_NORM_STAGES) {
      const ok = reachable.has(stage as never) || standalone.has(stage);
      expect(ok, `этап ${stage} недостижим: норматив для него никогда не применится`).toBe(true);
    }
  });

  it('КАЖДЫЙ переход с SET_DUE_AT ведёт на этап, у которого есть норматив', () => {
    // Это инвариант, а не пожелание: `SET_DUE_AT` означает «назначить срок»,
    // и если у целевого статуса этапа с нормативом нет, эффект невыполним.
    // Прежде так было у ТРЁХ переходов (3, 5, 7 — все в `ACCEPTED`): они
    // объявляли `SET_DUE_AT`, но этап `INTAKE` норматива не имеет, поэтому
    // срок молча не назначался. Проверено на проде: `dueAt = NULL`.
    const withDue = ORDER_TRANSITIONS.filter((t) => t.effects.includes('SET_DUE_AT'));
    expect(withDue.length).toBeGreaterThan(0);

    for (const transition of withDue) {
      const stage = stageForStatus(transition.to);
      expect(
        stage,
        `переход ${transition.id} в ${transition.to} объявляет SET_DUE_AT, ` +
          'но этапа с нормативом у него нет — срок не будет назначен',
      ).not.toBeNull();
    }
  });

  it('ACCEPTED не объявляет SET_DUE_AT: у этапа INTAKE норматива нет', () => {
    // Отдельная проверка, потому что это была конкретная ошибка: «принят в
    // работу» — ещё не этап с нормируемым сроком, срок назначает следующий
    // переход (в `QUEUED_FOR_DISPATCH`, этап `QUEUE`).
    const intoAccepted = ORDER_TRANSITIONS.filter((t) => t.to === ORDER_STATUS.ACCEPTED);
    expect(intoAccepted.length).toBeGreaterThan(0);
    for (const transition of intoAccepted) {
      expect(transition.effects).not.toContain('SET_DUE_AT');
    }
  });

  it('словарь этапов справочника совпадает с этапами домена', () => {
    // Третий словарь из дефекта: `DISPATCH`, `DELIVERY_OUT`, `DELIVERY_IN`,
    // `STORAGE` существовали только в seed и не совпадали ни с чем.
    const domainStages = new Set<string>(Object.values(STATUS_STAGE));
    for (const stage of ALL_NORM_STAGES) {
      if (stage === NORM_STAGE.CLAIM) continue; // рекламация — не этап заказа
      expect(domainStages.has(stage), `этап ${stage} отсутствует в домене`).toBe(true);
    }
  });
});

describe('computeDueAt: единицы измерения норматива', () => {
  it('WORKDAY прибавляет рабочие дни, пропуская выходные', () => {
    // 3 рабочих дня от пятницы 17.09.2027 → среда 22.09 (18–19 выходные).
    const due = computeDueAt(FRIDAY, { value: 3, unit: 'WORKDAY' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-22');
  });

  it('WORKDAY учитывает праздники ТК РФ', () => {
    // Согласование 3 рабочих дня от 04.11.2026 (праздник) → 09.11.
    const due = computeDueAt(
      new Date('2026-11-03T12:00:00Z'),
      { value: 3, unit: 'WORKDAY' },
      CALENDAR,
    );
    expect(toDateKey(due!)).toBe('2026-11-09');
  });

  it('WORKHOUR считает рабочие ЧАСЫ внутри окна 10:00–19:00 МСК', () => {
    // 12:00 UTC — это 15:00 МСК, то есть до конца рабочего окна остаётся 4 часа.
    // Норматив в 4 часа укладывается в пятницу.
    const due = computeDueAt(FRIDAY, { value: 4, unit: 'WORKHOUR' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-17');
  });

  it('WORKHOUR переносит остаток часов на следующий рабочий день', () => {
    // 5 часов от 15:00 МСК: 4 часа в пятницу, пятый — уже в понедельник.
    // Это и есть смысл «рабочих часов»: остаток дня не растягивает окно, а
    // переносится на следующий рабочий день, а не считается как «весь день».
    const due = computeDueAt(FRIDAY, { value: 5, unit: 'WORKHOUR' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-20');
  });

  it('WORKHOUR переносит срок через выходные', () => {
    // 24 рабочих часа — три полных рабочих дня: пятница (4 ч), понедельник
    // (9 ч), вторник (9 ч) → среда. Курьер не работает в субботу, поэтому
    // срок обязан перешагнуть выходные, а не «досчитать» их как рабочие.
    const due = computeDueAt(FRIDAY, { value: 24, unit: 'WORKHOUR' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-22');
  });

  it('WORKHOUR не считает выходные рабочими часами', () => {
    // 8 часов, начатых в пятницу вечером, заканчиваются в понедельник, а не
    // в субботу: иначе срок обещал бы доставку в нерабочий день.
    const lateFriday = new Date('2027-09-17T16:00:00Z'); // 19:00 МСК — окно закрыто
    const due = computeDueAt(lateFriday, { value: 8, unit: 'WORKHOUR' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-09-20');
  });

  it('CALENDAR_DAY считает календарные дни, включая выходные', () => {
    // Хранение 30 календарных дней — именно календарных: заказ лежит на полке,
    // и выходные цеха его срок не продлевают.
    const due = computeDueAt(FRIDAY, { value: 30, unit: 'CALENDAR_DAY' }, CALENDAR);
    expect(toDateKey(due!)).toBe('2027-10-17');
  });

  it('неизвестная единица не даёт срока вместо «похожего» значения', () => {
    // Молчаливая подстановка дала бы неверное обещание клиенту.
    expect(computeDueAt(FRIDAY, { value: 5, unit: 'FORTNIGHT' }, CALENDAR)).toBeNull();
  });

  it('нулевое значение допустимо и даёт тот же день', () => {
    expect(toDateKey(computeDueAt(FRIDAY, { value: 0, unit: 'WORKDAY' }, CALENDAR)!)).toBe(
      '2027-09-17',
    );
  });
});

describe('Нормативы: значения по умолчанию из docs/04 §3', () => {
  /**
   * Проверка на реальных нормативах заказчика: они не хардкодятся в коде
   * (docs/00-decisions.md §6.11), но их значения должны давать осмысленные
   * сроки. Здесь проверяется не «правильность цифр», а то, что каждая единица
   * измерения даёт результат и срок не попадает на выходной.
   */
  const defaults = [
    { stage: NORM_STAGE.APPROVAL, value: 3, unit: 'WORKDAY' },
    { stage: NORM_STAGE.PREPAYMENT, value: 5, unit: 'WORKDAY' },
    { stage: NORM_STAGE.QUEUE, value: 24, unit: 'WORKHOUR' },
    { stage: NORM_STAGE.LOGISTICS_OUT, value: 8, unit: 'WORKHOUR' },
    { stage: NORM_STAGE.PRODUCTION, value: 5, unit: 'WORKDAY' },
    { stage: NORM_STAGE.LOGISTICS_IN, value: 8, unit: 'WORKHOUR' },
    { stage: NORM_STAGE.PICKUP, value: 30, unit: 'CALENDAR_DAY' },
    { stage: NORM_STAGE.CLAIM, value: 10, unit: 'WORKDAY' },
  ];

  it('каждый норматив даёт срок', () => {
    for (const norm of defaults) {
      const due = computeDueAt(FRIDAY, norm, CALENDAR);
      expect(
        due,
        `норматив ${norm.stage} (${norm.value} ${norm.unit}) не дал срока`,
      ).not.toBeNull();
    }
  });

  it('все этапы справочника покрыты значениями по умолчанию', () => {
    // Если у этапа нет норматива, заказ на этом этапе останется без срока —
    // то есть просрочку по нему система не увидит.
    const covered = new Set(defaults.map((n) => n.stage));
    for (const stage of ALL_NORM_STAGES) {
      expect(covered.has(stage), `для этапа ${stage} нет норматива по умолчанию`).toBe(true);
    }
  });

  it('сроки в рабочих днях не попадают на выходные', () => {
    for (const norm of defaults.filter((n) => n.unit === 'WORKDAY')) {
      const due = computeDueAt(FRIDAY, norm, CALENDAR)!;
      const day = due.getUTCDay();
      expect(day === 0 || day === 6, `${norm.stage}: срок попал на выходной`).toBe(false);
    }
  });
});
