/**
 * Тесты состава главного экрана (задача 5.8, docs/06 §6.5).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Дашборд — единственный экран, который видят ВСЕ роли, и он
 * собирается из блоков разных отчётов. Ошибка здесь не ломает ничего видимого:
 * блок просто оказывается доступен не тому. Кассир увидел бы загрузку цеха,
 * приёмщик — выручку сети. Поэтому проверяется не «блоки есть», а соответствие
 * блоков матрице прав `ROLE_PERMISSIONS`, причём по всем восьми ролям сразу:
 * так расхождение обнаружится при добавлении роли, а не на живом человеке.
 */

import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_BLOCKS,
  DASHBOARD_BLOCK,
  DASHBOARD_UNIT,
  hasAnyDashboardBlock,
  visibleDashboardBlocks,
  type DashboardBlockCode,
} from './dashboard.js';
import { PERMISSION, ROLE, ROLE_PERMISSIONS, type RoleCode } from './roles.js';

const ALL_ROLES = Object.keys(ROLE_PERMISSIONS) as RoleCode[];
const codes = (blocks: readonly { code: DashboardBlockCode }[]) => blocks.map((b) => b.code);

describe('Состав блоков главного экрана (задача 5.8)', () => {
  it('содержит все блоки из docs/06 §6.5', () => {
    // Спецификация перечисляет семь чисел. Пропущенный блок — это не «меньше
    // данных», а вопрос руководителя «а где выручка?».
    expect(codes(DASHBOARD_BLOCKS).sort()).toEqual(
      [
        DASHBOARD_BLOCK.IN_WORK,
        DASHBOARD_BLOCK.OVERDUE,
        DASHBOARD_BLOCK.REVENUE_MONTH,
        DASHBOARD_BLOCK.PREPAYMENTS_IN_WORK,
        DASHBOARD_BLOCK.AVG_REPAIR,
        DASHBOARD_BLOCK.WORKSHOP_LOAD,
        DASHBOARD_BLOCK.OPEN_CLAIMS,
      ].sort(),
    );
  });

  it('коды блоков уникальны', () => {
    // Дубликат означал бы, что интерфейс отрисует одну карточку дважды или
    // перепутает переходы по клику.
    const list = codes(DASHBOARD_BLOCKS);
    expect(new Set(list).size).toBe(list.length);
  });

  it('каждый блок кликабелен и ведёт на свой путь', () => {
    // Требование docs/06 §6.5: «каждый блок кликабелен и ведёт в соответствующий
    // отчёт или список». Блок без пути — тупик для пользователя.
    for (const block of DASHBOARD_BLOCKS) {
      expect(block.href, `блок ${block.code}`).toMatch(/^\//);
    }
  });

  it('пути блоков не совпадают', () => {
    // Два блока, ведущие в одно место, означают, что один из них — копия.
    const hrefs = DASHBOARD_BLOCKS.map((b) => b.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('у каждого блока есть право и единица измерения', () => {
    for (const block of DASHBOARD_BLOCKS) {
      expect(Object.values(PERMISSION), `право блока ${block.code}`).toContain(block.permission);
      expect(Object.values(DASHBOARD_UNIT)).toContain(block.unit);
    }
  });

  it('денежные блоки измеряются в деньгах, счётчики — в штуках', () => {
    // Единица говорит интерфейсу, как показать значение: «₽» или «шт.». Ошибка
    // здесь показала бы «14 ₽» там, где 14 заказов.
    const byCode = new Map(DASHBOARD_BLOCKS.map((b) => [b.code, b]));
    expect(byCode.get(DASHBOARD_BLOCK.REVENUE_MONTH)?.unit).toBe(DASHBOARD_UNIT.MONEY);
    expect(byCode.get(DASHBOARD_BLOCK.PREPAYMENTS_IN_WORK)?.unit).toBe(DASHBOARD_UNIT.MONEY);
    expect(byCode.get(DASHBOARD_BLOCK.IN_WORK)?.unit).toBe(DASHBOARD_UNIT.COUNT);
    expect(byCode.get(DASHBOARD_BLOCK.OVERDUE)?.unit).toBe(DASHBOARD_UNIT.COUNT);
    expect(byCode.get(DASHBOARD_BLOCK.OPEN_CLAIMS)?.unit).toBe(DASHBOARD_UNIT.COUNT);
  });
});

describe('Права на блоки дашборда (задача 5.8)', () => {
  it('КАССИР видит деньги, но не загрузку цеха', () => {
    /*
     * Главная проверка состава. Кассир работает с оплатой и не управляет
     * производством: загрузка цеха ему не нужна, а выручка — нужна. Если бы
     * блоки фильтровались по роли в одном месте, а права задавались в другом,
     * эта граница разошлась бы незаметно.
     */
    const visible = codes(visibleDashboardBlocks(ROLE_PERMISSIONS[ROLE.CASHIER]));
    expect(visible).toContain(DASHBOARD_BLOCK.REVENUE_MONTH);
    expect(visible).toContain(DASHBOARD_BLOCK.PREPAYMENTS_IN_WORK);
    expect(visible).not.toContain(DASHBOARD_BLOCK.WORKSHOP_LOAD);
  });

  it('РУКОВОДИТЕЛЬ ПРОИЗВОДСТВА видит загрузку цеха, но не выручку', () => {
    // Обратная граница: производство видит свою загрузку и не видит деньги
    // клиентов — это область кассира и руководителя.
    const visible = codes(visibleDashboardBlocks(ROLE_PERMISSIONS[ROLE.PRODUCTION_MANAGER]));
    expect(visible).toContain(DASHBOARD_BLOCK.WORKSHOP_LOAD);
    expect(visible).toContain(DASHBOARD_BLOCK.AVG_REPAIR);
    expect(visible).not.toContain(DASHBOARD_BLOCK.REVENUE_MONTH);
  });

  it('АДМИНИСТРАТОР видит все блоки', () => {
    // У администратора максимальный набор прав, и он обязан видеть дашборд
    // целиком — иначе не сможет проверить, что видят другие.
    const visible = codes(visibleDashboardBlocks(ROLE_PERMISSIONS[ROLE.ADMIN]));
    expect(visible.length).toBe(DASHBOARD_BLOCKS.length);
  });

  it('РУКОВОДИТЕЛЬ видит и операционные отчёты, и деньги', () => {
    const visible = codes(visibleDashboardBlocks(ROLE_PERMISSIONS[ROLE.MANAGER]));
    expect(visible).toContain(DASHBOARD_BLOCK.REVENUE_MONTH);
    expect(visible).toContain(DASHBOARD_BLOCK.WORKSHOP_LOAD);
    expect(visible).toContain(DASHBOARD_BLOCK.OVERDUE);
  });

  it('ЛОГИСТ видит заказы, но не деньги и не загрузку цеха', () => {
    // Логист сопровождает партии: ему нужен список заказов, а финансы и
    // производственные показатели — нет.
    const visible = codes(visibleDashboardBlocks(ROLE_PERMISSIONS[ROLE.LOGISTICIAN]));
    expect(visible).toContain(DASHBOARD_BLOCK.IN_WORK);
    expect(visible).not.toContain(DASHBOARD_BLOCK.REVENUE_MONTH);
    expect(visible).not.toContain(DASHBOARD_BLOCK.WORKSHOP_LOAD);
  });

  it('блок показывается ТОЛЬКО при наличии права', () => {
    // Проверка по всем ролям сразу: расхождение обнаружится при добавлении
    // роли, а не на живом человеке.
    for (const role of ALL_ROLES) {
      const permissions = ROLE_PERMISSIONS[role];
      for (const block of visibleDashboardBlocks(permissions)) {
        expect(permissions, `роль ${role}, блок ${block.code}`).toContain(block.permission);
      }
    }
  });

  it('блок НЕ скрывается при наличии права', () => {
    // Обратная проверка: право есть — блок обязан быть. Иначе сотрудник с правом
    // на отчёт не увидит его на главном экране и будет искать в меню.
    for (const role of ALL_ROLES) {
      const permissions = ROLE_PERMISSIONS[role];
      for (const block of DASHBOARD_BLOCKS) {
        const visible = visibleDashboardBlocks(permissions).includes(block);
        expect(visible, `роль ${role}, блок ${block.code}`).toBe(
          permissions.includes(block.permission),
        );
      }
    }
  });

  it('пустой набор прав не даёт блоков', () => {
    // Роль без прав не должна видеть ничего: пустой экран честнее выдуманных
    // чисел.
    expect(visibleDashboardBlocks([])).toHaveLength(0);
    expect(hasAnyDashboardBlock([])).toBe(false);
  });

  it('порядок блоков не зависит от набора прав', () => {
    // Экран не должен переставляться от того, что у одной роли блок есть, а у
    // другой нет: человек привыкает к расположению карточек.
    /*
     * Эталон — ОБЪЯВЛЕННЫЙ порядок, а не вывод администратора. Если брать эталон
     * из вывода, переворот всего списка сократится с обеих сторон и тест его не
     * заметит: он сравнит перевёрнутое с перевёрнутым.
     *
     * Проверяется каждая роль, а не только кассир: у него денежные блоки стоят
     * рядом, и их перестановка не видна. У приёмщика блоки идут через пропуски,
     * и там любая перестановка обнаружится.
     */
    const declared = codes(DASHBOARD_BLOCKS);
    for (const role of ALL_ROLES) {
      const partial = codes(visibleDashboardBlocks(ROLE_PERMISSIONS[role]));
      const expected = declared.filter((code) => partial.includes(code));
      expect(partial, `роль ${role}`).toEqual(expected);
    }
  });

  it('роль без права на заказы не видит дашборд пустым', () => {
    /*
     * Защита от вырожденного случая: если бы все блоки требовали одного права,
     * дашборд был бы бесполезен.
     */
    for (const role of ALL_ROLES) {
      const permissions = ROLE_PERMISSIONS[role];
      if (permissions.includes(PERMISSION.ORDER_READ)) {
        expect(visibleDashboardBlocks(permissions).length, `роль ${role}`).toBeGreaterThan(0);
      }
    }
  });

  it('ЛОГИСТ видит ровно один блок — это осознанное следствие спецификации', () => {
    /*
     * Единственная роль с одноблочным экраном. У логиста есть `order:read`, но
     * нет ни операционных отчётов, ни `report:revenue`, ни `claim:read`, а
     * docs/06 §6.5 перечисляет семь блоков, среди которых нет логистического
     * (партии и «в пути» — отдельные экраны).
     *
     * Тест фиксирует это как известное состояние, а не как норму: если у логиста
     * появится свой блок, тест придётся осознанно изменить. Пока он защищает от
     * незаметного расширения прав — например, от случайной выдачи логисту
     * `report:revenue`, из-за которой он увидел бы выручку сети.
     */
    const visible = codes(visibleDashboardBlocks(ROLE_PERMISSIONS[ROLE.LOGISTICIAN]));
    expect(visible).toEqual([DASHBOARD_BLOCK.IN_WORK]);
  });
});
