import { describe, expect, it } from 'vitest';
import { parseStatusFilter } from './order-status.js';
import { ORDER_STATUS, ALL_ORDER_STATUSES } from './order-status.js';

/**
 * Разбор параметра `status` (дефект 69).
 *
 * Ссылка `/orders?status=A,B` — это срез, который копируют из адресной строки и
 * пересылают коллеге целиком (docs/08 §7). Прежде она уезжала в базу одним
 * значением `"A,B"`, Prisma отвечала ошибкой валидации, и список заказов
 * возвращал 500: скопированная ссылка ломала экран. Неизвестный статус давал ту
 * же 500 вместо понятного 400.
 */
describe('Разбор параметра status: оба формата', () => {
  it('разбирает формат адреса страницы `A,B`', () => {
    const parsed = parseStatusFilter('IN_WORK,WORK_COMPLETED');

    expect(parsed.statuses).toEqual([ORDER_STATUS.IN_WORK, ORDER_STATUS.WORK_COMPLETED]);
    expect(parsed.invalid).toEqual([]);
  });

  it('разбирает формат клиента `A&status=B` (повтор параметра)', () => {
    const parsed = parseStatusFilter([ORDER_STATUS.IN_WORK, ORDER_STATUS.WORK_COMPLETED]);

    expect(parsed.statuses).toEqual([ORDER_STATUS.IN_WORK, ORDER_STATUS.WORK_COMPLETED]);
    expect(parsed.invalid).toEqual([]);
  });

  it('разбирает смесь обоих форматов', () => {
    // `?status=A,B&status=C` — так выглядит адрес, отредактированный вручную
    // поверх ссылки, построенной клиентом.
    const parsed = parseStatusFilter(['IN_WORK,WORK_COMPLETED', 'REWORK']);

    expect(parsed.statuses).toEqual([
      ORDER_STATUS.IN_WORK,
      ORDER_STATUS.WORK_COMPLETED,
      ORDER_STATUS.REWORK,
    ]);
  });

  it('одиночный статус — это набор из одного', () => {
    expect(parseStatusFilter('IN_WORK').statuses).toEqual([ORDER_STATUS.IN_WORK]);
  });

  it('отсутствие параметра означает «фильтра нет»', () => {
    expect(parseStatusFilter(undefined)).toEqual({ statuses: [], invalid: [] });
  });

  it('пустое значение означает «фильтра нет», а не ошибку', () => {
    // `?status=` — это отсутствие фильтра: 400 на пустой параметр был бы
    // неожиданным.
    expect(parseStatusFilter('')).toEqual({ statuses: [], invalid: [] });
    expect(parseStatusFilter(' , ')).toEqual({ statuses: [], invalid: [] });
  });

  it('пробелы вокруг статусов не мешают', () => {
    // Адрес мог быть собран человеком: `?status=IN_WORK, REWORK`.
    expect(parseStatusFilter(' IN_WORK , REWORK ').statuses).toEqual([
      ORDER_STATUS.IN_WORK,
      ORDER_STATUS.REWORK,
    ]);
  });

  it('повтор статуса не дублируется', () => {
    // Повтор в адресе не должен превращаться в `{ in: ['A','A'] }`.
    expect(parseStatusFilter('IN_WORK,IN_WORK').statuses).toEqual([ORDER_STATUS.IN_WORK]);
  });

  it('НЕизвестный статус возвращается как ошибка, а не отбрасывается', () => {
    /*
     * Главная проверка: отбросить неизвестное значение значило бы ответить на
     * `?status=ОПЕЧАТКА` ПОЛНЫМ списком — человек просил отфильтровать, а получил
     * всё, и решил бы, что фильтр не работает. Ошибка честнее.
     */
    const parsed = parseStatusFilter('IN_WORK,НЕТТАКОГО');

    expect(parsed.statuses).toEqual([ORDER_STATUS.IN_WORK]);
    expect(parsed.invalid).toEqual(['НЕТТАКОГО']);
  });

  it('регистр учитывается: `in_work` — не статус', () => {
    const parsed = parseStatusFilter('in_work');

    expect(parsed.statuses).toEqual([]);
    expect(parsed.invalid).toEqual(['in_work']);
  });

  it('принимает ВСЕ объявленные статусы', () => {
    // Проверка на полноту: новый статус в домене обязан быть принят фильтром без
    // правки функции.
    const parsed = parseStatusFilter([...ALL_ORDER_STATUSES]);

    expect(parsed.invalid).toEqual([]);
    expect(parsed.statuses).toEqual([...ALL_ORDER_STATUSES]);
  });

  it('не мутирует переданный массив', () => {
    // Контроллер передаёт значение из запроса; порча его была бы неожиданной.
    const input = [ORDER_STATUS.IN_WORK, ORDER_STATUS.REWORK];
    const copy = [...input];
    parseStatusFilter(input);

    expect(input).toEqual(copy);
  });
});
