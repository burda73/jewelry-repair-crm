/**
 * Тесты заголовка `Content-Disposition` (задача 2.3).
 *
 * ЗАЧЕМ. Номер акта начинается с кириллицы («АПП-26-000001»). HTTP-заголовки
 * допускают только ASCII, поэтому прямая подстановка номера в `filename`
 * приводила к `ERR_INVALID_CHAR` и ответу 500 вместо PDF — дефект нашёлся только
 * при проверке на живом сервере: юнит-тесты подменяли PDF-сервис, а заголовок
 * собирался в контроллере.
 *
 * Здесь проверяется главное свойство: результат обязан быть ASCII-чистым и
 * одновременно содержать точное имя в `filename*`.
 */

import { describe, expect, it } from 'vitest';
import { contentDisposition } from './batches.controller';

describe('contentDisposition: заголовок для имени файла', () => {
  it('не содержит не-ASCII символов для кириллического номера', () => {
    // Ровно тот случай, который ломал ответ: заголовок с кириллицей Node
    // отвергает с `ERR_INVALID_CHAR`.
    const header = contentDisposition('inline', 'act-АПП-26-000001.pdf');

    // eslint-disable-next-line no-control-regex
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(() => {
      // Повторяет проверку Node: заголовок не должен бросать при установке.
      const { validateHeaderValue } = require('node:http') as typeof import('node:http');
      validateHeaderValue('Content-Disposition', header);
    }).not.toThrow();
  });

  it('сохраняет точное имя в filename* по RFC 5987', () => {
    const header = contentDisposition('inline', 'act-АПП-26-000001.pdf');

    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent('act-АПП-26-000001.pdf'));
  });

  it('оставляет читаемый ASCII-запасной вариант', () => {
    // Старые клиенты берут `filename`, и он должен быть осмысленным, а не пустым.
    const header = contentDisposition('inline', 'act-АПП-26-000001.pdf');

    expect(header).toContain('filename="act-');
    expect(header).toContain('.pdf"');
    expect(header).not.toContain('filename=""');
  });

  it('передаёт вид отображения', () => {
    expect(contentDisposition('inline', 'a.pdf')).toMatch(/^inline;/);
    expect(contentDisposition('attachment', 'a.pdf')).toMatch(/^attachment;/);
  });

  it('не ломает ASCII-имя', () => {
    // Номер заказа ASCII — этот случай работал и раньше, регрессия недопустима.
    const header = contentDisposition('inline', 'act-MSK1-2609-000001.pdf');

    expect(header).toContain('filename="act-MSK1-2609-000001.pdf"');
    expect(header).toContain("filename*=UTF-8''act-MSK1-2609-000001.pdf");
  });

  it('экранирует кавычку в ASCII-варианте', () => {
    // Незакрытая кавычка разорвала бы заголовок и сделала бы его неоднозначным.
    const header = contentDisposition('inline', 'a"b.pdf');

    expect(header).not.toContain('"a"b.pdf"');
  });
});
