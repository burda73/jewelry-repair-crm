/**
 * Тесты правил нормативов сроков (ТЗ п. 2.7, ответ A3).
 *
 * Нормативы — настраиваемый справочник: у заказчика утверждённых значений нет,
 * поэтому используются стартовые, которые заказчик меняет через интерфейс
 * (docs/00-decisions.md §6.11). Здесь проверяются правила ВЫБОРА норматива,
 * а не конкретные числа.
 *
 * ЧТО БЫЛО ИСПРАВЛЕНО В ЭТИХ ТЕСТАХ. Прежде здесь была СВОЯ копия
 * `pickNorm`, «повторяющая логику» сервиса, и набор норм с именами
 * `DISPATCH`/`DELIVERY_OUT`/`DELIVERY_IN`/`STORAGE`. Это давало ложное
 * спокойствие: тесты проходили тогда, когда сервис искал норматив по имени
 * СТАТУСА (`QUEUED_FOR_DISPATCH`) и не находил ни одного совпадения, то есть
 * `dueAt` не устанавливался вообще. Копия логики в тесте не защищает от
 * расхождения с оригиналом — она его и создаёт.
 *
 * Теперь вызывается настоящая `pickStageNorm` из домена (её же использует
 * `OrderWorkflowService.loadStageNorm`), а имена этапов берутся из `NORM_STAGE`.
 */

import { describe, expect, it } from 'vitest';
import { ALL_NORM_STAGES, NORM_STAGE, pickStageNorm, type StageNormLike } from './order-status.js';

/** Норматив так, как он хранится в справочнике `StageNorm`. */
type Norm = StageNormLike;

/**
 * Стартовые нормативы заказчика (docs/04-status-workflow.md §3).
 *
 * Значения НЕ хардкодятся в коде приложения — они лишь заполняются при первом
 * развёртывании и далее меняются администратором. Здесь они нужны, чтобы
 * проверить правило выбора на реалистичном наборе.
 */
const NORMS: readonly Norm[] = [
  { stage: NORM_STAGE.APPROVAL, workType: 'ANY', value: 3, unit: 'WORKDAY' },
  { stage: NORM_STAGE.PREPAYMENT, workType: 'ANY', value: 5, unit: 'WORKDAY' },
  { stage: NORM_STAGE.QUEUE, workType: 'ANY', value: 24, unit: 'WORKHOUR' },
  { stage: NORM_STAGE.LOGISTICS_OUT, workType: 'ANY', value: 8, unit: 'WORKHOUR' },
  // Общий норматив производства — для нераспознанной сложности (`ANY`):
  // именно это значение по умолчанию у `Order.complexity`, пока калькуляция
  // не реализована. Без него такой заказ остался бы без срока.
  { stage: NORM_STAGE.PRODUCTION, workType: 'ANY', value: 15, unit: 'WORKDAY' },
  { stage: NORM_STAGE.PRODUCTION, workType: 'SIMPLE', value: 5, unit: 'WORKDAY' },
  { stage: NORM_STAGE.PRODUCTION, workType: 'COMPLEX', value: 15, unit: 'WORKDAY' },
  { stage: NORM_STAGE.LOGISTICS_IN, workType: 'ANY', value: 8, unit: 'WORKHOUR' },
  { stage: NORM_STAGE.PICKUP, workType: 'ANY', value: 30, unit: 'CALENDAR_DAY' },
  { stage: NORM_STAGE.CLAIM, workType: 'ANY', value: 10, unit: 'WORKDAY' },
];

describe('Выбор норматива этапа', () => {
  it('выбирает норматив по конкретному типу работ', () => {
    expect(pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'SIMPLE')?.value).toBe(5);
    expect(pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'COMPLEX')?.value).toBe(15);
  });

  it('для сложного ремонта не подставляет срок простого', () => {
    // Дефект, ради которого правило и существует: при отсутствии учёта
    // сложности для любого ремонта применялся бы один и тот же срок.
    const simple = pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'SIMPLE');
    const complex = pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'COMPLEX');
    expect(simple?.value).not.toBe(complex?.value);
  });

  it('падает обратно на общий норматив ANY, если конкретного нет', () => {
    expect(pickStageNorm(NORMS, NORM_STAGE.APPROVAL, 'SIMPLE')?.value).toBe(3);
    expect(pickStageNorm(NORMS, NORM_STAGE.LOGISTICS_OUT, 'COMPLEX')?.value).toBe(8);
  });

  it('находит норматив этапа хранения в календарных днях', () => {
    expect(pickStageNorm(NORMS, NORM_STAGE.PICKUP, 'ANY')?.unit).toBe('CALENDAR_DAY');
  });

  it('конкретный тип работ приоритетнее общего норматива', () => {
    // У производства есть и общий `ANY` (15), и конкретные (5/15). Для простого
    // ремонта должен применяться именно его норматив, а не общий: иначе общий
    // «съел» бы конкретные, и разница в сложности исчезла бы.
    expect(pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'SIMPLE')?.value).toBe(5);
    expect(pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'COMPLEX')?.value).toBe(15);
  });

  it('нераспознанная сложность получает общий норматив, а не остаётся без срока', () => {
    // `Order.complexity` по умолчанию `ANY` (калькуляция ещё не реализована).
    // Без общего норматива такой заказ не получил бы `dueAt` вообще.
    expect(pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'ANY')?.value).toBe(15);
    expect(pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'UNKNOWN')?.value).toBe(15);
  });

  it('возвращает null, когда для этапа нет ни конкретного, ни общего норматива', () => {
    const withoutClaim = NORMS.filter((n) => n.stage !== NORM_STAGE.CLAIM);
    expect(pickStageNorm(withoutClaim, NORM_STAGE.CLAIM, 'ANY')).toBeNull();
  });

  it('возвращает null для неизвестного этапа', () => {
    expect(pickStageNorm(NORMS, 'NO_SUCH_STAGE', 'ANY')).toBeNull();
  });

  it('НЕ находит норматив по имени статуса', () => {
    // Прямая регрессия на исходный дефект: расчёт передавал статус
    // (`QUEUED_FOR_DISPATCH`), и совпадений было 0 из 13. Если это когда-нибудь
    // снова начнёт «работать», значит справочник снова заполняется статусами.
    for (const status of ['QUEUED_FOR_DISPATCH', 'IN_PRODUCTION', 'READY_FOR_PICKUP']) {
      expect(pickStageNorm(NORMS, status, 'ANY')).toBeNull();
    }
  });

  it('возвращает пустой результат для пустого справочника', () => {
    // Так выглядит состояние «нормативы не заданы»: срок не назначается, и это
    // должно быть видно, а не подменяться значением по умолчанию.
    expect(pickStageNorm([], NORM_STAGE.QUEUE, 'ANY')).toBeNull();
  });
});

describe('Полнота набора нормативов', () => {
  it('набор покрывает каждый этап справочника для нераспознанного типа работ', () => {
    // Этап без общего норматива = заказ с `complexity = 'ANY'` без срока, то
    // есть просрочка по нему не видна (ТЗ п. 2.7). Значение по умолчанию у
    // `Order.complexity` — именно `ANY`, поэтому проверка идёт по нему.
    for (const stage of ALL_NORM_STAGES) {
      expect(pickStageNorm(NORMS, stage, 'ANY'), `нет норматива для этапа ${stage}`).not.toBeNull();
    }
  });

  it('набор покрывает производство для каждой известной сложности', () => {
    for (const workType of ['SIMPLE', 'COMPLEX']) {
      expect(
        pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, workType),
        `нет норматива производства для ${workType}`,
      ).not.toBeNull();
    }
  });

  it('набор не содержит нормативов для чужих этапов', () => {
    // Мёртвая строка: этап, которого нет в домене, расчёт никогда не найдёт.
    for (const norm of NORMS) {
      expect(ALL_NORM_STAGES).toContain(norm.stage);
    }
  });

  it('производство покрыто обоими типами работ', () => {
    // Проверяется и схемой создания версии: иначе для одной из сложностей
    // срок не найдётся и заказ останется без dueAt.
    expect(pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'SIMPLE')).not.toBeNull();
    expect(pickStageNorm(NORMS, NORM_STAGE.PRODUCTION, 'COMPLEX')).not.toBeNull();
  });

  it('единицы измерения — из известного набора', () => {
    for (const norm of NORMS) {
      expect(['WORKHOUR', 'WORKDAY', 'CALENDAR_DAY']).toContain(norm.unit);
    }
  });
});
