/**
 * Тесты срока действия версии прейскуранта.
 *
 * Здесь охраняются два сценария, из-за которых администратор не мог изменить
 * прейскурант:
 *
 *  * сравнение дат по исходным строкам ISO объявляло бы любое открытие
 *    карточки изменением, потому что сервер отдаёт дату со временем;
 *  * очистка даты окончания обязана отправлять `null` («бессрочно»), а не
 *    пропускаться — иначе срок действия невозможно было бы снять.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPriceListPeriodInput,
  dateInputToIso,
  describePriceListPeriodError,
  isoToDateInput,
  type PriceListPeriodFields,
} from './price-list-period';

/** Действующая версия: сервер отдаёт дату со временем, а не только день. */
const ORIGINAL: PriceListPeriodFields = {
  effectiveFrom: '2026-09-16T17:05:08.846Z',
  effectiveTo: null,
};

describe('isoToDateInput', () => {
  it('оставляет только день в UTC', () => {
    // Местное время сдвинуло бы дату на день назад для UTC+3, и администратор
    // увидел бы в поле не тот день, который хранится.
    expect(isoToDateInput('2026-09-16T17:05:08.846Z')).toBe('2026-09-16');
  });

  it('возвращает пустую строку для null', () => {
    expect(isoToDateInput(null)).toBe('');
  });

  it('возвращает пустую строку для мусора, а не «Invalid Date» в поле', () => {
    expect(isoToDateInput('не дата')).toBe('');
  });
});

describe('dateInputToIso', () => {
  it('трактует день как полночь UTC', () => {
    expect(dateInputToIso('2026-09-16')).toBe('2026-09-16T00:00:00.000Z');
  });

  it('не сдвигает день при обратном преобразовании', () => {
    // Прямое и обратное преобразование обязаны сходиться, иначе поле «поехало бы»
    // при каждом открытии карточки.
    expect(isoToDateInput(dateInputToIso('2026-01-01'))).toBe('2026-01-01');
    expect(isoToDateInput(dateInputToIso('2026-12-31'))).toBe('2026-12-31');
  });
});

describe('buildPriceListPeriodInput', () => {
  it('возвращает null, когда администратор ничего не изменил', () => {
    const draft: PriceListPeriodFields = { effectiveFrom: '2026-09-16', effectiveTo: null };

    // Сравнение по исходной строке объявило бы здесь изменение: сервер отдал
    // «2026-09-16T17:05:08.846Z», поле — «2026-09-16».
    expect(buildPriceListPeriodInput(ORIGINAL, draft)).toBeNull();
  });

  it('замечает смену даты начала', () => {
    const draft = { effectiveFrom: '2026-10-01', effectiveTo: null };

    expect(buildPriceListPeriodInput(ORIGINAL, draft)).toEqual({
      effectiveFrom: '2026-10-01T00:00:00.000Z',
    });
  });

  it('замечает установку даты окончания', () => {
    const draft = { effectiveFrom: '2026-09-16', effectiveTo: '2026-12-31' };

    expect(buildPriceListPeriodInput(ORIGINAL, draft)).toEqual({
      effectiveTo: '2026-12-31T00:00:00.000Z',
    });
  });

  it('отправляет null при снятии даты окончания', () => {
    const original = { ...ORIGINAL, effectiveTo: '2026-12-31T00:00:00.000Z' };
    const draft = { effectiveFrom: '2026-09-16', effectiveTo: null };

    // Пропуск поля оставил бы срок действия прежним, а интерфейс отчитался бы
    // об успехе — администратор не понял бы, почему версия всё ещё ограничена.
    expect(buildPriceListPeriodInput(original, draft)).toEqual({ effectiveTo: null });
  });

  it('замечает обе даты сразу', () => {
    const original = { ...ORIGINAL, effectiveTo: '2026-12-31T00:00:00.000Z' };
    const draft = { effectiveFrom: '2026-10-01', effectiveTo: '2027-01-31' };

    expect(buildPriceListPeriodInput(original, draft)).toEqual({
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: '2027-01-31T00:00:00.000Z',
    });
  });

  it('не считает изменением ту же дату окончания', () => {
    const original = { ...ORIGINAL, effectiveTo: '2026-12-31T15:30:00.000Z' };
    const draft = { effectiveFrom: '2026-09-16', effectiveTo: '2026-12-31' };

    expect(buildPriceListPeriodInput(original, draft)).toBeNull();
  });
});

describe('describePriceListPeriodError', () => {
  it('не находит ошибок в корректном периоде', () => {
    expect(
      describePriceListPeriodError({ effectiveFrom: '2026-09-16', effectiveTo: '2026-12-31' }),
    ).toBeNull();
  });

  it('требует дату начала', () => {
    expect(describePriceListPeriodError({ effectiveFrom: '', effectiveTo: null })).toBe(
      'Укажите дату начала действия',
    );
  });

  it('отклоняет окончание раньше начала', () => {
    expect(
      describePriceListPeriodError({ effectiveFrom: '2026-12-31', effectiveTo: '2026-09-16' }),
    ).toBe('Дата окончания должна быть позже даты начала');
  });

  it('отклоняет окончание, совпадающее с началом', () => {
    // Сервер требует строгого «позже»; нулевой период не имеет смысла.
    expect(
      describePriceListPeriodError({ effectiveFrom: '2026-09-16', effectiveTo: '2026-09-16' }),
    ).toBe('Дата окончания должна быть позже даты начала');
  });

  it('разрешает бессрочную версию', () => {
    expect(
      describePriceListPeriodError({ effectiveFrom: '2026-09-16', effectiveTo: null }),
    ).toBeNull();
  });
});
