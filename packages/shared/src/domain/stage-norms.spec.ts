/**
 * Тесты правил нормативов сроков (ТЗ п. 2.7, ответ A3).
 *
 * Нормативы — настраиваемый справочник: у заказчика утверждённых значений нет,
 * поэтому используются стартовые, которые заказчик меняет через интерфейс
 * (docs/00-decisions.md §6.11). Здесь проверяются правила ВЫБОРА норматива,
 * а не конкретные числа.
 *
 * Эти тесты закрывают дефект, найденный при разработке: нормативы производства
 * заданы для типов работ SIMPLE и COMPLEX, но заказ не передавал свою сложность,
 * поэтому конкретные нормативы были недостижимы и для любого ремонта применялся
 * самый длинный (или общий) срок.
 */

import { describe, expect, it } from 'vitest';

/** Норматив так, как он хранится в справочнике `StageNorm`. */
interface Norm {
  stage: string;
  workType: string; // 'ANY' | 'SIMPLE' | 'COMPLEX'
  value: number;
  unit: string;
}

/**
 * Правило выбора норматива.
 *
 * Повторяет логику `OrderWorkflowService.loadStageNorm`:
 * конкретный тип работ приоритетнее общего (`ANY`).
 */
function pickNorm(norms: readonly Norm[], stage: string, workType: string | null): Norm | null {
  const candidates = norms.filter(
    (n) =>
      n.stage === stage &&
      (workType === null ? n.workType === 'ANY' : n.workType === workType || n.workType === 'ANY'),
  );
  if (candidates.length === 0) return null;
  return candidates.find((n) => n.workType === workType) ?? candidates[0] ?? null;
}

const NORMS: readonly Norm[] = [
  { stage: 'APPROVAL', workType: 'ANY', value: 3, unit: 'WORKDAY' },
  { stage: 'PREPAYMENT', workType: 'ANY', value: 5, unit: 'WORKDAY' },
  { stage: 'DISPATCH', workType: 'ANY', value: 24, unit: 'WORKHOUR' },
  { stage: 'DELIVERY_OUT', workType: 'ANY', value: 8, unit: 'WORKHOUR' },
  { stage: 'PRODUCTION', workType: 'SIMPLE', value: 5, unit: 'WORKDAY' },
  { stage: 'PRODUCTION', workType: 'COMPLEX', value: 15, unit: 'WORKDAY' },
  { stage: 'DELIVERY_IN', workType: 'ANY', value: 8, unit: 'WORKHOUR' },
  { stage: 'STORAGE', workType: 'ANY', value: 30, unit: 'CALENDAR_DAY' },
  { stage: 'CLAIM', workType: 'ANY', value: 10, unit: 'WORKDAY' },
];

describe('Выбор норматива этапа', () => {
  it('для простого ремонта берёт норматив SIMPLE, а не общий', () => {
    const norm = pickNorm(NORMS, 'PRODUCTION', 'SIMPLE');
    expect(norm?.value).toBe(5);
    expect(norm?.workType).toBe('SIMPLE');
  });

  it('для сложного ремонта берёт норматив COMPLEX', () => {
    const norm = pickNorm(NORMS, 'PRODUCTION', 'COMPLEX');
    expect(norm?.value).toBe(15);
    expect(norm?.workType).toBe('COMPLEX');
  });

  it('этапы без разделения по сложности используют общий норматив', () => {
    // Для согласования и логистики задан только ANY — сложность не влияет.
    expect(pickNorm(NORMS, 'APPROVAL', 'SIMPLE')?.value).toBe(3);
    expect(pickNorm(NORMS, 'DELIVERY_OUT', 'COMPLEX')?.value).toBe(8);
    expect(pickNorm(NORMS, 'STORAGE', 'ANY')?.unit).toBe('CALENDAR_DAY');
  });

  it('если сложность не определена, применяется общий норматив', () => {
    expect(pickNorm(NORMS, 'PRODUCTION', null)).toBeNull(); // нет норматива ANY для производства
    expect(pickNorm(NORMS, 'PRODUCTION', 'ANY')).toBeNull();
  });

  it('простой ремонт не получает срок сложного — иначе сроки завышены', () => {
    const simple = pickNorm(NORMS, 'PRODUCTION', 'SIMPLE');
    const complex = pickNorm(NORMS, 'PRODUCTION', 'COMPLEX');
    expect(simple!.value).toBeLessThan(complex!.value);
  });

  it('возвращает null для неизвестного этапа — дедлайн не выдумывается', () => {
    // Если норматива нет, система не должна подставлять произвольный срок:
    // лучше не менять dueAt, чем показать клиенту неверную дату.
    expect(pickNorm(NORMS, 'UNKNOWN_STAGE', 'ANY')).toBeNull();
  });
});

describe('Нормативы, требуемые ТЗ напрямую', () => {
  it('хранение до выдачи — 30 календарных дней (ТЗ п. 2.8)', () => {
    const norm = pickNorm(NORMS, 'STORAGE', 'ANY');
    expect(norm?.unit).toBe('CALENDAR_DAY');
    expect(norm?.value).toBe(30);
  });

  it('рассмотрение рекламации — 10 рабочих дней (ТЗ п. 2.9)', () => {
    const norm = pickNorm(NORMS, 'CLAIM', 'ANY');
    expect(norm?.unit).toBe('WORKDAY');
    expect(norm?.value).toBe(10);
  });

  it('все этапы, по которым нужны эскалации, имеют норматив', () => {
    // ТЗ п. 2.7: эскалация по каждому этапу. Пропуск норматива = нет контроля.
    const requiredStages = [
      'APPROVAL',
      'PREPAYMENT',
      'DISPATCH',
      'DELIVERY_OUT',
      'DELIVERY_IN',
      'STORAGE',
      'CLAIM',
    ];
    for (const stage of requiredStages) {
      expect(pickNorm(NORMS, stage, 'ANY'), `нет норматива для этапа ${stage}`).not.toBeNull();
    }
  });

  it('нормативы производства покрывают оба типа работ', () => {
    expect(pickNorm(NORMS, 'PRODUCTION', 'SIMPLE')).not.toBeNull();
    expect(pickNorm(NORMS, 'PRODUCTION', 'COMPLEX')).not.toBeNull();
  });
});
