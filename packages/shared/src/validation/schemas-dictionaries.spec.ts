/**
 * Тесты схем справочников (задача 1.3.1).
 *
 * Проверяются правила, которые защищают данные за пределами самого справочника:
 *  * код магазина попадает в номер заказа (`MSK1-2609-000001`), поэтому формат
 *    кода — не вопрос оформления, а часть формата номера;
 *  * дефис в коде допустим, но не в начале и не в конце: `-MSK` и `MSK-` —
 *    обрывки, которые ломают сортировку и читаются как опечатка;
 *  * `updateStoreSchema` не подставляет значения по умолчанию: иначе правка
 *    названия молча переписывала бы часовой пояс магазина на `Europe/Moscow`;
 *  * пустой `PATCH` отклоняется: он записал бы в аудит «до» и «после» без
 *    изменений и засорил журнал;
 *  * цена камня — целое неотрицательное число минорных единиц.
 */

import { describe, expect, it } from 'vitest';
import {
  createStoreSchema,
  updateStoreSchema,
  createWorkshopSchema,
  updateWorkshopSchema,
  createPerformerSchema,
  updatePerformerSchema,
  createWorkCategorySchema,
  updateWorkCategorySchema,
  createStoneTypeSchema,
  updateStoneTypeSchema,
} from './schemas.js';

const CUID = 'cmu5p70yu0002cm7pzqlcawsz';
const OTHER = 'cmu5p70yu0001bm7pzqlcawsw';

describe('Код справочника', () => {
  it('принимает заглавные буквы, цифры и дефис внутри', () => {
    for (const code of ['MSK1', 'SOLDER', 'DIAMOND-S', 'AB', 'A1-B2-C3']) {
      const parsed = createStoreSchema.safeParse({ code, name: 'Название' });
      expect(parsed.success, `код ${code} должен приниматься`).toBe(true);
    }
  });

  it('отклоняет строчные буквы, кириллицу, пробелы и дефис по краям', () => {
    for (const code of ['msk1', 'МСК1', 'MSK 1', '-MSK', 'MSK-', 'MSK--1', 'MSK_1', '']) {
      const parsed = createStoreSchema.safeParse({ code, name: 'Название' });
      expect(parsed.success, `код ${code} должен отклоняться`).toBe(false);
    }
  });

  it('ограничивает длину кода работоспособным диапазоном', () => {
    expect(createStoreSchema.safeParse({ code: 'A', name: 'Имя' }).success).toBe(false);
    expect(createStoreSchema.safeParse({ code: 'A'.repeat(21), name: 'Имя' }).success).toBe(false);
    expect(createStoreSchema.safeParse({ code: 'A'.repeat(20), name: 'Имя' }).success).toBe(true);
  });
});

describe('Магазин', () => {
  it('подставляет часовой пояс при создании', () => {
    const parsed = createStoreSchema.parse({ code: 'MSK1', name: 'Тверская' });
    expect(parsed.timezone).toBe('Europe/Moscow');
  });

  it('НЕ подставляет часовой пояс при изменении', () => {
    // `.partial()` в Zod не подставляет дефолты для отсутствующих ключей,
    // поэтому правка названия не переписывает часовой пояс. Тест закрепляет
    // инвариант: если кто-то добавит `timezone: timezoneSchema.default(...)`
    // в схему изменения, он упадёт.
    const parsed = updateStoreSchema.parse({ name: 'Новое название' });
    expect(parsed).toEqual({ name: 'Новое название' });
    expect('timezone' in parsed).toBe(false);
  });

  it('позволяет ОЧИСТИТЬ адрес и телефон, чего не умеет .partial()', () => {
    // Настоящая причина, по которой схема изменения написана отдельно:
    // `createStoreSchema.address` объявлен `.optional()` (принимает отсутствие
    // поля, но не `null`), и `.partial()` этого не меняет — стереть адрес было
    // бы невозможно. Проверяем именно это различие.
    expect(
      createStoreSchema.safeParse({ code: 'MSK1', name: 'Тверская', address: null }).success,
    ).toBe(false);
    expect(updateStoreSchema.safeParse({ address: null }).success).toBe(true);
    expect(updateStoreSchema.safeParse({ phone: null }).success).toBe(true);
  });

  it('различает «не передано» и «передано null»', () => {
    const cleared = updateStoreSchema.parse({ address: null, phone: null });
    expect(cleared.address).toBeNull();
    expect(cleared.phone).toBeNull();

    // Ключ отсутствует в результате: сервис получит `undefined` и не тронет
    // поле. Это же отличие нужно и в `updateUserSchema`.
    const untouched = updateStoreSchema.parse({ name: 'Тверская' });
    expect('address' in untouched).toBe(false);
  });

  it('отклоняет пустой PATCH', () => {
    // Пустой PATCH записал бы в журнал «до» и «после» без изменений.
    expect(updateStoreSchema.safeParse({}).success).toBe(false);
  });

  it('позволяет отключить магазин', () => {
    expect(updateStoreSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });
});

describe('Цех', () => {
  it('требует код и название при создании', () => {
    expect(createWorkshopSchema.safeParse({ name: 'Цех' }).success).toBe(false);
    expect(createWorkshopSchema.safeParse({ code: 'CENTER' }).success).toBe(false);
    expect(createWorkshopSchema.safeParse({ code: 'CENTER', name: 'Центральный' }).success).toBe(
      true,
    );
  });

  it('отклоняет пустой PATCH', () => {
    expect(updateWorkshopSchema.safeParse({}).success).toBe(false);
  });
});

describe('Исполнитель', () => {
  it('требует идентификатор цеха в формате cuid', () => {
    expect(createPerformerSchema.safeParse({ workshopId: CUID, fullName: 'Иванов' }).success).toBe(
      true,
    );
    // Короткая строка вида `workshop-1` не должна проходить: настоящие
    // идентификаторы Prisma — cuid, и такой «идентификатор» не найдётся в базе.
    expect(
      createPerformerSchema.safeParse({ workshopId: 'workshop-1', fullName: 'Иванов' }).success,
    ).toBe(false);
  });

  it('позволяет перевести исполнителя в другой цех', () => {
    const parsed = updatePerformerSchema.parse({ workshopId: OTHER });
    expect(parsed.workshopId).toBe(OTHER);
  });

  it('требует ФИО не короче двух символов', () => {
    expect(createPerformerSchema.safeParse({ workshopId: CUID, fullName: 'И' }).success).toBe(
      false,
    );
  });

  it('отклоняет пустой PATCH', () => {
    expect(updatePerformerSchema.safeParse({}).success).toBe(false);
  });
});

describe('Категория работ', () => {
  it('подставляет порядок 0 при создании', () => {
    const parsed = createWorkCategorySchema.parse({ code: 'SOLDER', name: 'Пайка' });
    expect(parsed.sortOrder).toBe(0);
  });

  it('ограничивает порядок диапазоном 0–999', () => {
    // Опечатка вроде 100000 отправила бы категорию в конец списка, и
    // администратор не понял бы, почему она не на месте.
    for (const sortOrder of [-1, 1000, 1.5]) {
      expect(
        createWorkCategorySchema.safeParse({ code: 'SOLDER', name: 'Пайка', sortOrder }).success,
        `порядок ${sortOrder} должен отклоняться`,
      ).toBe(false);
    }
    expect(
      createWorkCategorySchema.safeParse({ code: 'SOLDER', name: 'Пайка', sortOrder: 999 }).success,
    ).toBe(true);
  });

  it('позволяет отключить категорию', () => {
    expect(updateWorkCategorySchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it('отклоняет пустой PATCH', () => {
    expect(updateWorkCategorySchema.safeParse({}).success).toBe(false);
  });
});

describe('Тип камня', () => {
  it('требует целую неотрицательную цену', () => {
    const base = { code: 'TOPAZ', name: 'Топаз' };
    expect(createStoneTypeSchema.safeParse({ ...base, priceMinor: 0 }).success).toBe(true);
    expect(createStoneTypeSchema.safeParse({ ...base, priceMinor: 1234 }).success).toBe(true);

    // Дробная цена в минорных единицах означала бы потерянную точность.
    expect(createStoneTypeSchema.safeParse({ ...base, priceMinor: 1234.56 }).success).toBe(false);
    expect(createStoneTypeSchema.safeParse({ ...base, priceMinor: -1 }).success).toBe(false);
  });

  it('подставляет единицу «шт» по умолчанию', () => {
    const parsed = createStoneTypeSchema.parse({ code: 'TOPAZ', name: 'Топаз', priceMinor: 100 });
    expect(parsed.unit).toBe('шт');
  });

  it('позволяет отключить тип камня', () => {
    expect(updateStoneTypeSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it('отклоняет пустой PATCH', () => {
    expect(updateStoneTypeSchema.safeParse({}).success).toBe(false);
  });
});
