/**
 * Тесты ограничения пула соединений.
 *
 * ЗАЧЕМ ЭТО ПРОВЕРЯТЬ. В продакшне база — СУЩЕСТВУЮЩИЙ сервер PostgreSQL
 * предприятия, общий с другими системами (ответ A1, docs/14 §3.2). PostgreSQL
 * допускает `max_connections` соединений на ВЕСЬ сервер: если наше приложение
 * займёт их все, встанут 1С и остальные системы. Причина при этом будет искаться
 * где угодно, кроме нашего приложения, — со стороны это выглядит как «лёг
 * сервер базы».
 *
 * `connectionLimit` — единственная защита от этого, и она чистая функция, то есть
 * проверяется без базы. Тест фиксирует не только «добавляет параметр», но и
 * случаи, где наивная реализация испортила бы строку подключения.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { connectionLimit } from './connection-limit.js';

const URL_BASE = 'postgresql://repair_app:secret@10.10.0.119:5432/repair';

/** Исходное значение переменной, чтобы тесты не влияли друг на друга. */
let original: string | undefined;

beforeEach(() => {
  original = process.env.DATABASE_POOL_SIZE;
});

afterEach(() => {
  if (original === undefined) delete process.env.DATABASE_POOL_SIZE;
  else process.env.DATABASE_POOL_SIZE = original;
});

describe('Ограничение пула соединений', () => {
  it('добавляет connection_limit из DATABASE_POOL_SIZE', () => {
    process.env.DATABASE_POOL_SIZE = '10';
    expect(connectionLimit(URL_BASE)).toBe(`${URL_BASE}?connection_limit=10`);
  });

  it('не портит строку, где уже есть параметры запроса', () => {
    /*
     * Продакшн-строка содержит `?schema=public`. Наивная склейка через `?`
     * дала бы `...?schema=public?connection_limit=10` — невалидную строку, и
     * приложение не подключилось бы к базе ВООБЩЕ.
     */
    process.env.DATABASE_POOL_SIZE = '10';
    expect(connectionLimit(`${URL_BASE}?schema=public`)).toBe(
      `${URL_BASE}?schema=public&connection_limit=10`,
    );
  });

  it('не перезаписывает явно заданное ограничение', () => {
    /*
     * Если администратор задал `connection_limit` в самой строке, он знал, что
     * делает: у него может быть свой расчёт бюджета. Молчаливая подмена
     * значения настройкой сделала бы строку подключения непредсказуемой.
     */
    process.env.DATABASE_POOL_SIZE = '50';
    const url = `${URL_BASE}?connection_limit=3`;
    expect(connectionLimit(url)).toBe(url);
  });

  it('без заданной настройки оставляет строку как есть', () => {
    /*
     * Отсутствие настройки — не повод подставлять выдуманное число: у Prisma
     * есть собственное поведение по умолчанию, и подменять его вслепую значило
     * бы гадать о бюджете соединений заказчика.
     */
    delete process.env.DATABASE_POOL_SIZE;
    expect(connectionLimit(URL_BASE)).toBe(URL_BASE);
  });

  it('игнорирует нечисловое и неположительное значение', () => {
    // `connection_limit=abc` или `=0` Prisma либо отвергнет, либо поймёт как
    // «без ограничения» — в обоих случаях защита не работает.
    process.env.DATABASE_POOL_SIZE = 'abc';
    expect(connectionLimit(URL_BASE)).toBe(URL_BASE);

    process.env.DATABASE_POOL_SIZE = '0';
    expect(connectionLimit(URL_BASE)).toBe(URL_BASE);

    process.env.DATABASE_POOL_SIZE = '-5';
    expect(connectionLimit(URL_BASE)).toBe(URL_BASE);
  });

  it('пустая строка подключения не превращается в параметр', () => {
    // Клиент без строки подключения (например, реплика не настроена) должен
    // получить `undefined`, а не `?connection_limit=10`.
    process.env.DATABASE_POOL_SIZE = '10';
    expect(connectionLimit(undefined)).toBeUndefined();
  });
});
