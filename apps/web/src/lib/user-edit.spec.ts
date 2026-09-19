/**
 * Тесты правки учётной записи администратором.
 *
 * КАЖДЫЙ ТЕСТ ЗДЕСЬ ОХРАНЯЕТ КОНКРЕТНЫЙ СЦЕНАРИЙ ПОТЕРИ ДАННЫХ. Проверяются не
 * «функции вообще», а правила, нарушение которых либо теряет правку
 * администратора, либо отменяет чужую:
 *
 *  * неизменённые поля не уходят на сервер — иначе `PATCH` затирает
 *    параллельную правку из другой вкладки;
 *  * очищенный телефон отправляется как `""`, а не пропускается, — иначе
 *    «Изменения сохранены» показывается, а телефон остаётся прежним;
 *  * порядок магазинов не считается изменением, потому что сервер заменяет
 *    привязки целиком и назначает магазином по умолчанию первый элемент;
 *  * причина, по которой кнопка сброса пароля неактивна, называется явно.
 */

import { describe, expect, it } from 'vitest';
import { generatePassword } from '@app/shared';
import {
  buildUserUpdateInput,
  describeUserDraftError,
  hasUserChanges,
  isPasswordReady,
  passwordPolicyViolations,
  shouldExplainPassword,
  userEditDraft,
  type UserEditableFields,
  type UserEditDraft,
} from './user-edit';

const ORIGINAL: UserEditableFields = {
  fullName: 'Аудитор Внешний',
  email: 'auditor@remixgold.ru',
  phone: '+79000000008',
  isActive: true,
  storeIds: ['store-a', 'store-b'],
};

/** Черновик без изменений — база для проверки, что правило срабатывает. */
function unchanged(): UserEditDraft {
  return userEditDraft(ORIGINAL);
}

describe('userEditDraft', () => {
  it('превращает отсутствующий телефон в пустую строку', () => {
    const draft = userEditDraft({ ...ORIGINAL, phone: null });
    expect(draft.phone).toBe('');
  });

  it('копирует список магазинов, а не ссылается на него', () => {
    const source = { ...ORIGINAL, storeIds: ['store-a'] };
    const draft = userEditDraft(source);

    // Мутация исходного массива не должна менять черновик: иначе открытая
    // карточка «поехала» бы вслед за обновлением списка из кэша react-query.
    source.storeIds.push('store-z');
    expect(draft.storeIds).toEqual(['store-a']);
  });
});

describe('buildUserUpdateInput', () => {
  it('возвращает null, когда администратор ничего не изменил', () => {
    // Иначе открытие карточки и нажатие «Сохранить» отправляло бы пустой PATCH.
    expect(buildUserUpdateInput(ORIGINAL, unchanged())).toBeNull();
  });

  it('отправляет только изменённое поле', () => {
    const draft = { ...unchanged(), fullName: 'Аудитор Внешний 2' };

    const payload = buildUserUpdateInput(ORIGINAL, draft);

    // Ровно одно поле: любое лишнее затрёт параллельную правку из другой вкладки.
    expect(payload).toEqual({ fullName: 'Аудитор Внешний 2' });
  });

  it('отправляет очищенный телефон как пустую строку, а не пропускает его', () => {
    const draft = { ...unchanged(), phone: '' };

    const payload = buildUserUpdateInput(ORIGINAL, draft);

    // Если поле пропустить, сервер сохранит старый телефон, а интерфейс
    // отчитается об успехе — администратор не поймёт, почему номер остался.
    expect(payload).toEqual({ phone: '' });
    expect('phone' in (payload ?? {})).toBe(true);
  });

  it('не считает изменением перестановку магазинов', () => {
    const draft = { ...unchanged(), storeIds: ['store-b', 'store-a'] };

    // Сервер заменяет привязки целиком и делает первый элемент магазином по
    // умолчанию, поэтому порядок в интерфейсе содержательного смысла не несёт.
    expect(buildUserUpdateInput(ORIGINAL, draft)).toBeNull();
  });

  it('замечает добавление магазина', () => {
    const draft = { ...unchanged(), storeIds: ['store-a', 'store-b', 'store-c'] };

    expect(buildUserUpdateInput(ORIGINAL, draft)).toEqual({
      storeIds: ['store-a', 'store-b', 'store-c'],
    });
  });

  it('замечает удаление магазина', () => {
    const draft = { ...unchanged(), storeIds: ['store-a'] };

    // Удаление привязки — тоже правка; сравнение «хотя бы один общий элемент»
    // пропустило бы её и оставило лишний доступ.
    expect(buildUserUpdateInput(ORIGINAL, draft)).toEqual({ storeIds: ['store-a'] });
  });

  it('различает одинаковый набор магазинов разной длины', () => {
    const draft = { ...unchanged(), storeIds: ['store-a', 'store-a'] };

    // Дубликат — это другое множество, хотя каждый элемент уже присутствует.
    expect(buildUserUpdateInput(ORIGINAL, draft)).toEqual({
      storeIds: ['store-a', 'store-a'],
    });
  });

  it('отправляет отключение учётной записи', () => {
    const draft = { ...unchanged(), isActive: false };

    expect(buildUserUpdateInput(ORIGINAL, draft)).toEqual({ isActive: false });
  });

  it('обрезает пробелы перед сравнением', () => {
    const draft = { ...unchanged(), fullName: '  Аудитор Внешний  ' };

    // Пробелы по краям не правка: сохранение «того же» значения с пробелами
    // обнулило бы проверку на отсутствие изменений.
    expect(buildUserUpdateInput(ORIGINAL, draft)).toBeNull();
  });

  it('собирает несколько изменений сразу', () => {
    const draft = {
      ...unchanged(),
      email: 'auditor2@remixgold.ru',
      isActive: false,
    };

    expect(buildUserUpdateInput(ORIGINAL, draft)).toEqual({
      email: 'auditor2@remixgold.ru',
      isActive: false,
    });
  });

  it('считает заполненный телефон появлением, если его не было', () => {
    const original = { ...ORIGINAL, phone: null };
    const draft = { ...unchanged(), phone: '+79000000099' };

    expect(buildUserUpdateInput(original, draft)).toEqual({ phone: '+79000000099' });
  });
});

describe('hasUserChanges', () => {
  it('согласован с buildUserUpdateInput на обоих исходах', () => {
    const cases: { draft: UserEditDraft; expected: boolean }[] = [
      { draft: unchanged(), expected: false },
      { draft: { ...unchanged(), fullName: 'Другое Имя' }, expected: true },
      { draft: { ...unchanged(), phone: '' }, expected: true },
      { draft: { ...unchanged(), storeIds: ['store-b', 'store-a'] }, expected: false },
    ];

    const seen: boolean[] = [];
    for (const entry of cases) {
      expect(hasUserChanges(ORIGINAL, entry.draft)).toBe(entry.expected);
      seen.push(hasUserChanges(ORIGINAL, entry.draft));
    }

    // Свидетель: цикл действительно прошёл все случаи, а не остановился на
    // первом. Без него тест зеленел бы даже при возврате из цикла.
    expect(seen).toHaveLength(cases.length);
  });
});

describe('describeUserDraftError', () => {
  it('не находит ошибок в корректном черновике', () => {
    expect(describeUserDraftError(unchanged())).toBeNull();
  });

  it('отклоняет ФИО короче двух символов', () => {
    expect(describeUserDraftError({ ...unchanged(), fullName: 'A' })).toBe('Укажите ФИО');
  });

  it('отклоняет e-mail без собаки', () => {
    expect(describeUserDraftError({ ...unchanged(), email: 'auditor.remixgold.ru' })).toBe(
      'Некорректный email',
    );
  });

  it('отклоняет слишком короткий телефон', () => {
    expect(describeUserDraftError({ ...unchanged(), phone: '+7900' })).toBe(
      'Укажите телефон полностью',
    );
  });

  it('пропускает пустой телефон: это «не задан», а не ошибка', () => {
    expect(describeUserDraftError({ ...unchanged(), phone: '' })).toBeNull();
  });
});

describe('passwordPolicyViolations', () => {
  it('перечисляет все причины для совсем слабого пароля', () => {
    const violations = passwordPolicyViolations('12345');

    expect(violations).toEqual(['TOO_SHORT', 'MISSING_LOWER', 'MISSING_UPPER']);
  });

  it('ничего не находит в пароле от генератора', () => {
    // Генератор и политика обязаны совпадать: иначе кнопка «Обновить»
    // подставляла бы пароль, который сервер затем отклоняет.
    expect(passwordPolicyViolations(generatePassword())).toEqual([]);
  });

  it('различает отсутствие разных классов символов', () => {
    expect(passwordPolicyViolations('abcdefghijkl')).toEqual(['MISSING_UPPER', 'MISSING_DIGIT']);
    expect(passwordPolicyViolations('ABCDEFGHIJKL')).toEqual(['MISSING_LOWER', 'MISSING_DIGIT']);
    expect(passwordPolicyViolations('Abcdefghijkl')).toEqual(['MISSING_DIGIT']);
  });

  it('не считает слишком длинный пароль нарушением длины', () => {
    // Верхняя граница проверяется сервером; здесь важно лишь, что «длинный» не
    // попадает в TOO_SHORT и кнопка остаётся активной.
    expect(passwordPolicyViolations('A'.repeat(200) + 'a1')).not.toContain('TOO_SHORT');
  });
});

describe('isPasswordReady', () => {
  it('не готов к отправке, пока поле пустое', () => {
    // Пустая строка не проходит политику, потому что политика общая с сервером.
    expect(isPasswordReady('')).toBe(false);
  });

  it('готов, когда пароль удовлетворяет политике', () => {
    expect(isPasswordReady('TestReset2026xyz')).toBe(true);
  });

  it('не готов для слабого пароля', () => {
    expect(isPasswordReady('12345')).toBe(false);
  });
});

describe('shouldExplainPassword', () => {
  it('молчит на нетронутом поле', () => {
    // Иначе подсказка о нехватке символов показывалась бы до начала ввода и
    // читалась бы как уже допущенная ошибка.
    expect(shouldExplainPassword('')).toBe(false);
  });

  it('объясняет причину для начатого, но слабого пароля', () => {
    expect(shouldExplainPassword('12345')).toBe(true);
  });

  it('молчит, когда пароль корректен', () => {
    expect(shouldExplainPassword('TestReset2026xyz')).toBe(false);
  });
});
