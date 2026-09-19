/**
 * Совпадение статусов прейскуранта в общей схеме и в базе.
 *
 * ЗАЧЕМ ЭТО ПРОВЕРЯЕТСЯ ОТДЕЛЬНО. `PriceListStatus` есть в двух местах: в схеме
 * Prisma (`@prisma/client`) и в домене (`@app/shared`). Проверки правки и
 * переходов работают с доменным набором, а статус приходит из базы — значит,
 * набор обязан совпадать.
 *
 * Компилятор это НЕ ловит: оба набора — объединения строковых литералов, и они
 * структурно совместимы, пока значения пересекаются. Поэтому в сервисе нет
 * утверждений типа (они были признаны лишними — и правильно, они маскировали бы
 * настоящее расхождение), а совпадение наборов проверяется здесь.
 *
 * Что было бы при расхождении: новый статус в базе просто не попал бы ни в один
 * переход, и версия в нём оказалась бы недоступна для любого действия — «застряла»
 * без единого сообщения об ошибке. Или наоборот: домен предлагал бы действие,
 * которого база не знает.
 */

import { describe, expect, it } from 'vitest';
import { PriceListStatus as DbPriceListStatus } from '@prisma/client';
import { ALL_PRICE_LIST_STATUSES, PRICE_LIST_STATUS, isPriceListStatus } from './price-list.js';

describe('Совпадение статусов прейскуранта: домен и база', () => {
  it('наборы статусов совпадают', () => {
    expect([...ALL_PRICE_LIST_STATUSES].sort()).toEqual(
      [...Object.values(DbPriceListStatus)].sort(),
    );
  });

  it('каждый статус базы распознаётся доменом', () => {
    for (const status of Object.values(DbPriceListStatus)) {
      expect(isPriceListStatus(status), status).toBe(true);
    }
  });

  it('значения совпадают посимвольно', () => {
    // Ключи домена и значения базы — одна и та же строка. Иначе проверка
    // `isPriceListStatus` пропускала бы статус из базы, а таблицы переходов нет.
    for (const [key, value] of Object.entries(DbPriceListStatus)) {
      expect(PRICE_LIST_STATUS[key as keyof typeof PRICE_LIST_STATUS], key).toBe(value);
    }
  });
});
