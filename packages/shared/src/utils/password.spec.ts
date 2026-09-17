/**
 * Тесты генератора паролей.
 *
 * Главная проверка — не «пароль похож на пароль», а **каждое** сгенерированное
 * значение проходит `passwordSchema`. Если бы генератор выдавал пароль, не
 * удовлетворяющий политике, администратор не смог бы создать сотрудника:
 * форма уходила бы с отказом валидации, и причину пришлось бы искать в коде
 * генератора, а не в форме.
 */

import { describe, expect, it } from 'vitest';
import {
  GENERATED_PASSWORD_LENGTH,
  generatePassword,
  isStrongEnoughPassword,
  type RandomSource,
} from './password.js';
import { passwordSchema } from '../validation/schemas.js';

/** Детерминированный источник: линейный конгруэнтный генератор. */
function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i += 1) {
      // Числа из `Numerical Recipes`; для теста важна воспроизводимость, а не
      // криптостойкость — боевой источник здесь не подменяется.
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes[i] = (state >>> 24) & 0xff;
    }
    return bytes;
  };
}

describe('generatePassword: соответствие парольной политике', () => {
  it('1000 сгенерированных паролей проходят passwordSchema', () => {
    // Много прогонов, потому что дефект мог бы проявляться редко — например,
    // только при определённом порядке байтов источника случайности.
    const random = seededRandom(20260917);
    for (let i = 0; i < 1000; i += 1) {
      const password = generatePassword(undefined, random);
      const result = passwordSchema.safeParse(password);
      expect(result.success, `пароль не прошёл политику: ${password}`).toBe(true);
    }
  });

  it('длина по умолчанию — 20 символов', () => {
    expect(generatePassword().length).toBe(GENERATED_PASSWORD_LENGTH);
    expect(GENERATED_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });

  it('содержит строчную, прописную и цифру', () => {
    const password = generatePassword();
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/\d/);
  });

  it('на короткой длине обязательные классы символов всё равно есть', () => {
    // Минимальная осмысленная длина: три обязательных символа и ничего лишнего.
    const random = seededRandom(7);
    for (let i = 0; i < 200; i += 1) {
      const password = generatePassword(3, random);
      expect(password).toHaveLength(3);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/\d/);
    }
  });

  it('отклоняет невозможную длину', () => {
    expect(() => generatePassword(2)).toThrow();
    expect(() => generatePassword(1.5)).toThrow();
  });
});

describe('generatePassword: читаемость', () => {
  it('не содержит визуально неоднозначных символов', () => {
    // `O`/`0`, `l`/`1`, `I`: пароль диктуют голосом и переписывают с экрана,
    // и такие символы приводят к ошибкам входа.
    const random = seededRandom(99);
    for (let i = 0; i < 500; i += 1) {
      const password = generatePassword(undefined, random);
      expect(password, `неоднозначный символ в ${password}`).not.toMatch(/[O0lI1]/);
    }
  });
});

describe('generatePassword: случайность', () => {
  it('одинаковый источник даёт одинаковый пароль (воспроизводимость)', () => {
    expect(generatePassword(undefined, seededRandom(42))).toBe(
      generatePassword(undefined, seededRandom(42)),
    );
  });

  it('разные источники дают разные пароли', () => {
    expect(generatePassword(undefined, seededRandom(1))).not.toBe(
      generatePassword(undefined, seededRandom(2)),
    );
  });

  it('1000 паролей не повторяются', () => {
    const random = seededRandom(2026);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generatePassword(undefined, random));
    }
    expect(seen.size).toBe(1000);
  });

  it('первый символ не фиксирован: обязательные классы перемешаны', () => {
    // Без перемешивания пароль всегда начинался бы со строчной буквы, затем
    // шли бы прописная и цифра — три предсказуемые позиции.
    const random = seededRandom(555);
    const firstChars = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      firstChars.add(generatePassword(undefined, random).charAt(0));
    }
    expect(firstChars.size).toBeGreaterThan(10);
  });

  it('распределение символов не смещено к началу алфавита', () => {
    // Проверяем именно отсутствие смещения от `% length`: при наивной
    // реализации первые символы алфавита встречались бы чаще.
    const random = seededRandom(31337);
    const counts = new Map<string, number>();
    const total = 300;
    for (let i = 0; i < total; i += 1) {
      for (const char of generatePassword(undefined, random)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }

    const values = [...counts.values()];
    const sum = values.reduce((acc, value) => acc + value, 0);
    const expected = sum / counts.size;
    // Отклонение от равномерного меньше 40 %: при смещении к началу алфавита
    // разброс был бы заметно больше. Порог намеренно грубый — тест не должен
    // падать из-за случайной флуктуации.
    for (const [char, count] of counts) {
      expect(Math.abs(count - expected) / expected, `смещение для «${char}»`).toBeLessThan(0.4);
    }
  });
});

describe('isStrongEnoughPassword: совпадает с passwordSchema', () => {
  it('согласован с passwordSchema на наборе случаев', () => {
    const cases = [
      'Str0ngPassword12',
      'short',
      'alllowercase123',
      'ALLUPPERCASE123',
      'NoDigitsHereAtAll',
      'a'.repeat(129),
      generatePassword(),
    ];
    for (const value of cases) {
      expect(isStrongEnoughPassword(value), `расхождение на «${value}»`).toBe(
        passwordSchema.safeParse(value).success,
      );
    }
  });
});
