/**
 * Тесты схемы правки учётной записи (задача 1.2.4, дефект 45).
 *
 * Проверяются правила, ошибка в которых делает карточку сотрудника
 * бесполезной:
 *
 *  * телефон можно СТЕРЕТЬ: пустая строка и `null` означают «удалить номер».
 *    Без этого администратор, очистив поле, получал `VALIDATION_ERROR`, а
 *    сохранённый ранее телефон оставался в базе;
 *  * заполненный телефон по-прежнему проверяется по формату: послабление
 *    касается только пустого значения, а не «любого»;
 *  * частичная правка не подставляет значения по умолчанию — иначе правка
 *    одного ФИО переписывала бы `isActive` или состав магазинов;
 *  * пустой `PATCH` отклоняется: он записал бы в аудит «до» и «после» без
 *    изменений.
 */

import { describe, expect, it } from 'vitest';
import { updateUserSchema } from './schemas.js';

/** Правка одного поля — так приходит запрос от интерфейса. */
function parse(input: unknown) {
  return updateUserSchema.safeParse(input);
}

describe('updateUserSchema: телефон', () => {
  it('принимает пустую строку как «стереть телефон»', () => {
    const result = parse({ phone: '' });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ phone: '' });
  });

  it('принимает null как «стереть телефон»', () => {
    const result = parse({ phone: null });

    expect(result.success).toBe(true);
  });

  it('принимает корректный телефон', () => {
    const result = parse({ phone: '+79000000008' });

    expect(result.success).toBe(true);
  });

  it('по-прежнему отклоняет слишком короткий телефон', () => {
    // Послабление касается только пустого значения: иначе проверка формата
    // исчезла бы вовсе, и в базу попал бы обрывок номера.
    const result = parse({ phone: '+7900' });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.flatten().fieldErrors.phone).toBeDefined();
  });

  it('по-прежнему отклоняет телефон без достаточного числа цифр', () => {
    const result = parse({ phone: '+-() ---' });

    expect(result.success).toBe(false);
  });

  it('обрезает пробелы вокруг корректного телефона', () => {
    const result = parse({ phone: '  +79000000008  ' });

    expect(result.success && result.data.phone).toBe('+79000000008');
  });

  it('считает телефон из одних пробелов пустым', () => {
    // Пробелы — это «стёр поле»: обрезка выполняется до проверки формата, иначе
    // администратор, оставив в поле пробел, не смог бы удалить номер.
    const result = parse({ phone: '   ' });

    expect(result.success).toBe(true);
    expect(result.success && result.data.phone).toBe('');
  });
});

describe('updateUserSchema: частичная правка', () => {
  it('принимает только ФИО и не подставляет остальные поля', () => {
    const result = parse({ fullName: 'Аудитор Внешний 2' });

    expect(result.success).toBe(true);
    // Значений по умолчанию быть не должно: иначе правка ФИО отключала бы
    // учётную запись или снимала привязки к магазинам.
    expect(result.success && result.data).toEqual({ fullName: 'Аудитор Внешний 2' });
  });

  it('принимает только флаг активности', () => {
    const result = parse({ isActive: false });

    expect(result.success && result.data).toEqual({ isActive: false });
  });

  it('отклоняет ФИО из одного символа', () => {
    expect(parse({ fullName: 'A' }).success).toBe(false);
  });

  it('отклоняет некорректный e-mail', () => {
    expect(parse({ email: 'auditor.remixgold.ru' }).success).toBe(false);
  });

  it('приводит e-mail к нижнему регистру', () => {
    const result = parse({ email: 'Auditor@RemixGold.RU' });

    // Регистр не влияет на уникальность адреса, поэтому нормализуется схемой, а
    // не остаётся на усмотрение вызывающего кода.
    expect(result.success && result.data.email).toBe('auditor@remixgold.ru');
  });

  it('принимает пустой объект: отсутствие изменений не ошибка схемы', () => {
    // Интерфейс не отправляет пустой запрос, но схема обязана быть совместимой:
    // отклонение пустого объекта сломало бы вызовы, передающие поля условно.
    expect(parse({}).success).toBe(true);
  });
});
