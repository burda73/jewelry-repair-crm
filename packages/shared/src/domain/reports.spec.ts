/**
 * Тесты расчётных функций отчётов (задача 5.1, ТЗ п. 2.11).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Отчёт показывает руководителю средние сроки, долю в норме и
 * «хвост» проблемных заказов. Ошибка в этих числах не выглядит как ошибка: цифра
 * правдоподобна, и по ней принимают решение — нанимать ювелира или нет. Поэтому
 * проверяются именно границы:
 *
 *  * перцентиль совпадает с `percentile_cont` PostgreSQL, иначе отчёт разошёлся
 *    бы с запросом, написанным позже в SQL;
 *  * пустая выборка даёт `null`, а не ноль: «в норме 0 %» и «данных нет» —
 *    разные выводы, и первый подтолкнул бы к разбору несуществующей проблемы;
 *  * значения без норматива не попадают в «долю в норме»: иначе показатель
 *    улучшался бы за счёт этапов, для которых норматива просто нет.
 */

import { describe, expect, it } from 'vitest';
import { ROLE, permissionsFor } from './roles.js';
import {
  ALL_REPORT_NAMES,
  ANY_REPORT_PERMISSIONS,
  REPORT_COLUMN_TYPE,
  REPORT_NAME,
  REPORT_PERMISSION,
  permissionForReport,
  average,
  inNormShare,
  minutesToHours,
  percentile,
  round,
} from './reports.js';

describe('Перцентиль', () => {
  it('медиана нечётной выборки — средний элемент', () => {
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
  });

  it('медиана чётной выборки — полусумма соседних', () => {
    // Совпадает с `percentile_cont(0.5)`: интерполяция между 2 и 4.
    expect(percentile([1, 2, 4, 8], 0.5)).toBe(3);
  });

  it('девяностый перцентиль показывает «хвост»', () => {
    /*
     * Ради этого он и нужен: среднее по десяти заказам не покажет, что один
     * заказ «висел» год. Здесь 9 значений по 1 и одно 100: среднее уходит к 10,
     * а p90 остаётся у 1 — то есть «хвост» не размазывается на всех.
     */
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 100];
    expect(percentile(values, 0.9)).toBeCloseTo(10.9, 5);
  });

  it('нулевой и сотый перцентиль — крайние значения', () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 1)).toBe(9);
  });

  it('не мутирует входной массив', () => {
    // Порядок значений нужен вызывающему коду: сортировка «на месте» испортила
    // бы выборку, из которой считаются другие показатели.
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it('пустая выборка даёт null, а не ноль', () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it('одно значение возвращается как есть при любой доле', () => {
    expect(percentile([7], 0)).toBe(7);
    expect(percentile([7], 1)).toBe(7);
  });

  it('некорректная доля даёт null', () => {
    // `p = 1.5` или `NaN` — ошибка вызова, и молча вернуть число значило бы
    // показать руководителю бессмысленный показатель.
    expect(percentile([1, 2, 3], 1.5)).toBeNull();
    expect(percentile([1, 2, 3], -0.1)).toBeNull();
    expect(percentile([1, 2, 3], Number.NaN)).toBeNull();
  });

  it('некорректная доля даёт null и на выборке из одного значения', () => {
    /*
     * Отдельная проверка, потому что здесь ошибка НЕ видна: для выборки из
     * нескольких значений неверная доля выходит за границы массива, и результат
     * случайно получается `null`. Но у выборки из одного значения крайние ветки
     * возвращают единственный элемент, и без явной проверки `p = 1.5` вернул бы
     * ЧИСЛО — правдоподобное и неверное. Именно так ошибка вызова и осталась бы
     * незамеченной.
     */
    expect(percentile([7], 1.5)).toBeNull();
    expect(percentile([7], Number.NaN)).toBeNull();
  });

  it('совпадает с percentile_cont на последовательности', () => {
    /*
     * Ручной расчёт линейной интерполяции PostgreSQL для выборки 1..5:
     *   p25 → позиция 1.0 → 2
     *   p50 → позиция 2.0 → 3
     *   p75 → позиция 3.0 → 4
     */
    const values = [1, 2, 3, 4, 5];
    expect(percentile(values, 0.25)).toBe(2);
    expect(percentile(values, 0.5)).toBe(3);
    expect(percentile(values, 0.75)).toBe(4);
  });
});

describe('Среднее', () => {
  it('считает среднее арифметическое', () => {
    expect(average([2, 4, 6])).toBe(4);
  });

  it('пустая выборка даёт null', () => {
    // «Средний срок 0 ч» — это утверждение, которого данные не подтверждают.
    expect(average([])).toBeNull();
  });

  it('работает с дробными значениями', () => {
    expect(average([0.5, 1.5])).toBe(1);
  });
});

describe('Доля в норме', () => {
  it('считает долю значений в пределах норматива', () => {
    const share = inNormShare([
      { durationHours: 5, normHours: 8 },
      { durationHours: 10, normHours: 8 },
      { durationHours: 8, normHours: 8 },
      { durationHours: 20, normHours: 8 },
    ]);
    // 5 и 8 — в норме, 10 и 20 — нет. Ровно на границе считается «в норме»:
    // уложиться в норматив значит не превысить его.
    expect(share).toBe(0.5);
  });

  it('значения без норматива не участвуют в расчёте', () => {
    /*
     * Иначе показатель улучшался бы за счёт этапов, для которых норматива нет:
     * добавив в выборку много строк без нормы, можно «поднять» долю в норме,
     * ничего не улучшив.
     */
    const share = inNormShare([
      { durationHours: 100, normHours: 8 },
      { durationHours: 1, normHours: null },
      { durationHours: 1, normHours: null },
    ]);
    expect(share).toBe(0);
  });

  it('если нормативов нет ни у кого, доли нет', () => {
    expect(inNormShare([{ durationHours: 1, normHours: null }])).toBeNull();
  });

  it('пустая выборка даёт null', () => {
    expect(inNormShare([])).toBeNull();
  });
});

describe('Округление', () => {
  it('убирает артефакты двоичной арифметики', () => {
    // 0.1 + 0.2 в отчёте выглядело бы как дефект расчёта.
    expect(round(0.1 + 0.2)).toBe(0.3);
  });

  it('сохраняет null', () => {
    // `null` означает «нет данных»; превратить его в 0 значило бы показать ноль.
    expect(round(null)).toBeNull();
  });

  it('округляет до заданного числа знаков', () => {
    expect(round(62.4449, 2)).toBe(62.44);
    expect(round(62.4451, 2)).toBe(62.45);
    expect(round(62.4, 0)).toBe(62);
  });

  it('отбрасывает бесконечность и NaN', () => {
    expect(round(Number.POSITIVE_INFINITY)).toBeNull();
    expect(round(Number.NaN)).toBeNull();
  });
});

describe('Перевод минут в часы', () => {
  it('переводит минуты в часы', () => {
    expect(minutesToHours(90)).toBe(1.5);
  });

  it('сохраняет null', () => {
    expect(minutesToHours(null)).toBeNull();
  });

  it('ноль остаётся нулём', () => {
    // Здесь ноль — настоящее значение: этап пройден мгновенно.
    expect(minutesToHours(0)).toBe(0);
  });
});

describe('Реестр отчётов', () => {
  it('содержит все пять отчётов ТЗ п. 2.11', () => {
    expect(ALL_REPORT_NAMES).toHaveLength(5);
    // Имена совпадают с контрактом docs/07 §12.
    expect([...ALL_REPORT_NAMES].sort()).toEqual([
      'deadlines',
      'overdue',
      'prepayments',
      'production-load',
      'revenue',
    ]);
  });

  it('имена уникальны', () => {
    // Дубль имени означал бы, что один отчёт перекрывает другой в маршруте.
    expect(new Set(ALL_REPORT_NAMES).size).toBe(ALL_REPORT_NAMES.length);
  });

  it('типы колонок описаны в одном словаре', () => {
    // Клиент и выгрузка разбирают тип колонки; новая строка без обработки
    // означала бы, что значение показывается сырым.
    expect(Object.values(REPORT_COLUMN_TYPE)).toEqual([
      'string',
      'number',
      'money',
      'duration',
      'percent',
      'date',
    ]);
    expect(REPORT_NAME.STAGE_DURATIONS).toBe('deadlines');
    expect(REPORT_NAME.WORKSHOP_LOAD).toBe('production-load');
  });
});

describe('Права на отчёты (задача 5.6)', () => {
  it('каждый отчёт имеет право', () => {
    // Отчёт без права был бы доступен всем, у кого есть хоть какое-то право на
    // отчёты, — то есть выручка открылась бы руководителю производства.
    for (const name of ALL_REPORT_NAMES) {
      expect(typeof permissionForReport(name)).toBe('string');
      expect(permissionForReport(name).length).toBeGreaterThan(0);
    }
  });

  it('операционные и денежные отчёты требуют разных прав', () => {
    /*
     * Разделение обязательно: сроки и просрочки нужны руководителю производства,
     * выручка и предоплаты — кассиру и бухгалтеру. Одного общего права «читать
     * отчёты» не хватает.
     */
    expect(permissionForReport(REPORT_NAME.OVERDUE)).toBe('report:operational');
    expect(permissionForReport(REPORT_NAME.STAGE_DURATIONS)).toBe('report:operational');
    expect(permissionForReport(REPORT_NAME.WORKSHOP_LOAD)).toBe('report:operational');
    expect(permissionForReport(REPORT_NAME.REVENUE)).toBe('report:revenue');
    expect(permissionForReport(REPORT_NAME.PREPAYMENTS)).toBe('report:revenue');
  });

  it('кассир получает выручку, но не загрузку цеха', () => {
    /*
     * Дефект, найденный при сверке матрицы прав с docs/07 §12: маршрут требовал
     * только `report:operational`, и кассир, у которого есть `report:revenue` и
     * `report:export`, не мог открыть выручку вовсе — право было, доступа не
     * было.
     */
    const cashier = permissionsFor([ROLE.CASHIER]);
    expect(cashier.has(permissionForReport(REPORT_NAME.REVENUE))).toBe(true);
    expect(cashier.has(permissionForReport(REPORT_NAME.OVERDUE))).toBe(false);
  });

  it('руководитель производства видит операционные отчёты, но не выручку', () => {
    // Обратная сторона того же разделения: цех не должен видеть деньги клиентов.
    const manager = permissionsFor([ROLE.PRODUCTION_MANAGER]);
    expect(manager.has(permissionForReport(REPORT_NAME.OVERDUE))).toBe(true);
    expect(manager.has(permissionForReport(REPORT_NAME.REVENUE))).toBe(false);
  });

  it('руководитель и бухгалтер видят оба вида отчётов', () => {
    for (const role of [ROLE.MANAGER, ROLE.CHIEF_ACCOUNTANT]) {
      const permissions = permissionsFor([role]);
      expect(permissions.has(permissionForReport(REPORT_NAME.OVERDUE))).toBe(true);
      expect(permissions.has(permissionForReport(REPORT_NAME.REVENUE))).toBe(true);
      expect(permissions.has(permissionForReport(REPORT_NAME.REVENUE))).toBe(true);
    }
  });

  it('набор «любое право на отчёт» покрывает все отчёты', () => {
    // Маршрут пускает по любому из этих прав, и право каждого отчёта обязано
    // входить в набор — иначе отчёт недостижим ни для кого.
    for (const name of ALL_REPORT_NAMES) {
      expect(ANY_REPORT_PERMISSIONS).toContain(permissionForReport(name));
    }
    expect(new Set(ANY_REPORT_PERMISSIONS).size).toBe(ANY_REPORT_PERMISSIONS.length);
  });

  it('незнакомое имя отчёта не открывает операционный отчёт', () => {
    /*
     * Право по умолчанию не должно быть самым широким: иначе опечатка в имени
     * открыла бы операционный отчёт тому, у кого есть только право на выручку.
     */
    expect(permissionForReport('нет-такого')).toBe('report:revenue');
    expect(permissionForReport('нет-такого')).not.toBe('report:operational');
  });

  it('реестр прав покрывает все отчёты', () => {
    // Пропущенный отчёт в реестре прав означал бы, что он проверяется правом по
    // умолчанию, а не своим.
    expect(Object.keys(REPORT_PERMISSION).sort()).toEqual([...ALL_REPORT_NAMES].sort());
  });
});
