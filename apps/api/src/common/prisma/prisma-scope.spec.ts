/**
 * Сверка области видимости `PRODUCTION` с доменом статусов (задача 7.1).
 *
 * ## Зачем этот тест
 *
 * Фильтр области видимости `PRODUCTION` перечисляет статусы СТРОКАМИ, а не
 * константой из домена, и это не случайность: у фильтра тип Prisma, и строка
 * перечисления — часть запроса. Но у такого решения есть цена: добавленный в
 * домен статус производства не попадёт в фильтр автоматически, и менеджер
 * производства **перестанет видеть** заказы в новом статусе. Ошибка при этом
 * молчаливая: список просто короче, ни ошибки, ни предупреждения.
 *
 * Ровно это и произошло при введении статусов этапа 7: `ACCEPTED_BY_WORKSHOP`,
 * `IN_WORK` и `WORK_COMPLETED` пришлось дописывать в фильтр вручную. Комментарий
 * в `prisma.service.ts` ссылался на этот тест, но теста не существовало —
 * то есть защита была обещана, но не работала.
 *
 * ## Что именно проверяется
 *
 * Не равенство списков (в фильтре намеренно ШИРЕ — входят логистические
 * статусы, чтобы менеджер видел заказы до приёмки цехом), а **вложение**:
 * каждый статус производства обязан присутствовать. Плюс проверка обратного
 * направления на конкретных «условно-магазинных» статусах: `READY_FOR_PICKUP` и
 * `COMPLETED` в фильтр попадать не должны, иначе менеджер производства видел бы
 * заказы, уже выданные клиенту, и путался бы в списке.
 */

import { describe, expect, it } from 'vitest';
import { IN_PRODUCTION_STATUSES, ORDER_STATUS } from '@app/shared';
import { PrismaService } from './prisma.service';

/**
 * Сервис создаётся без подключения к базе: `buildOrderScopeFilter` — чистая
 * функция от аргументов и не обращается к `this`-соединению. Настоящее
 * соединение здесь не нужно и вредно: тест не должен требовать запущенной БД.
 */
const service = new PrismaService();

/** Все строки статусов, перечисленные в фильтре `PRODUCTION`. */
function productionStatusesInScope(): string[] {
  const filter = service.buildOrderScopeFilter({
    scope: 'PRODUCTION',
    storeIds: [],
    userId: 'cmu47z0zi0006ampvild7q09v',
  });

  const statuses = new Set<string>();
  /*
   * Фильтр — это `{ OR: [...] }`, и статусы лежат в одном из условий. Обход
   * ведётся структурно, а не поиском подстроки в JSON: подстрочный поиск нашёл
   * бы и `productionManagerId`, и совпадение по имени поля вместо значения.
   */
  const branches = Array.isArray(filter.OR) ? filter.OR : [];
  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object') continue;
    const statusFilter = (branch as { status?: unknown }).status;
    if (statusFilter === null || typeof statusFilter !== 'object') continue;
    const values = (statusFilter as { in?: unknown }).in;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === 'string') statuses.add(value);
    }
  }

  return [...statuses];
}

describe('Область видимости PRODUCTION (задача 7.1)', () => {
  it('включает ВСЕ статусы производства из домена', () => {
    /*
     * Главная проверка. Новый статус производства, забытый в фильтре, —
     * молчаливая ошибка: заказ существует, но менеджер его не видит. Тест
     * падает с перечнем пропущенных статусов, а не с «где-то в списке».
     */
    const inScope = productionStatusesInScope();
    const missing = IN_PRODUCTION_STATUSES.filter((status) => !inScope.includes(status));

    expect(missing, `Не попали в фильтр PRODUCTION: ${missing.join(', ')}`).toEqual([]);
  });

  it('включает статусы логистики: заказ виден до приёмки цехом', () => {
    /*
     * Широта фильтра намеренная. Если оставить только «в цехе», менеджер
     * производства не увидит заказ, который уже едет к нему, и не сможет
     * подготовиться к приёмке партии.
     */
    const inScope = productionStatusesInScope();
    expect(inScope).toContain(ORDER_STATUS.QUEUED_FOR_DISPATCH);
    expect(inScope).toContain(ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION);
    expect(inScope).toContain(ORDER_STATUS.IN_TRANSIT_TO_STORE);
  });

  it('не включает выданные и готовые к выдаче заказы', () => {
    // Иначе менеджер производства видел бы в своём списке заказы, которые уже
    // у клиента, и список перестал бы означать «что у меня в работе».
    const inScope = productionStatusesInScope();
    expect(inScope).not.toContain(ORDER_STATUS.READY_FOR_PICKUP);
    expect(inScope).not.toContain(ORDER_STATUS.COMPLETED);
    expect(inScope).not.toContain(ORDER_STATUS.DRAFT);
  });

  it('три новых статуса этапа 7 присутствуют в фильтре', () => {
    // Проверка «в лоб» по именам: если сверка выше когда-нибудь ослабнет,
    // эта останется и назовёт конкретные статусы из дефекта 59.
    const inScope = productionStatusesInScope();
    expect(inScope).toContain(ORDER_STATUS.ACCEPTED_BY_WORKSHOP);
    expect(inScope).toContain(ORDER_STATUS.IN_WORK);
    expect(inScope).toContain(ORDER_STATUS.WORK_COMPLETED);
  });

  it('разбор фильтра действительно находит статусы (тест не «зелёный впустую»)', () => {
    /*
     * Если разбор выше перестанет находить ветку (например, изменится форма
     * `OR`), все проверки на вложение могут стать бессмысленно зелёными при
     * пустом списке. Поэтому список обязан быть непустым, и это проверяется.
     */
    expect(productionStatusesInScope().length).toBeGreaterThanOrEqual(8);
  });
});
