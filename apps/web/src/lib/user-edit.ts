/**
 * Правка учётной записи администратором: черновик и вычисление изменения.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ. Раньше карточка сотрудника не содержала полей
 * правки вовсе: администратор видел ФИО, e-mail и телефон как текст, а
 * единственной кнопкой была «Закрыть». Сотрудника нельзя было ни
 * переименовать, ни исправить почту, ни привязать к другому магазину.
 *
 * Теперь правка есть, и вместе с ней появляется риск, ради которого логика
 * вынесена из компонента в чистые функции:
 *
 *  * отправлять серверу нужно ТОЛЬКО изменённые поля. `PATCH /users/:id`
 *    принимает частичный набор, и отправка неизменённого ФИО затирала бы
 *    параллельную правку, сделанную в другой вкладке;
 *  * `storeIds` — это МНОЖЕСТВО, а сервер заменяет привязки целиком. Сравнение
 *    по порядку элементов объявило бы изменение там, где его нет, и лишний
 *    `PATCH` переставлял бы магазин по умолчанию (сервер делает первым
 *    элементом массива именно `isDefault`);
 *  * пустое поле телефона означает «стереть», а не «не трогать». Пропустить
 *    его — значит показать «Изменения сохранены» и не сохранить ничего.
 *
 * Компонент не рендерится в тестах (см. `vitest.config.ts`), поэтому правила,
 * ошибка в которых приводит к потере правки администратора, живут здесь и
 * покрыты тестами.
 */

import { isStrongEnoughPassword } from '@app/shared';

/** Поля учётной записи, которые администратор правит в карточке. */
export interface UserEditableFields {
  fullName: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  /** Привязки к магазинам: порядок первого элемента задаёт магазин по умолчанию. */
  storeIds: string[];
}

/** Черновик карточки: телефон и ФИО — строки, потому что так их вводит человек. */
export interface UserEditDraft {
  fullName: string;
  email: string;
  phone: string;
  isActive: boolean;
  storeIds: string[];
}

/** Частичное изменение для `PATCH /users/:id`: только реально тронутые поля. */
export interface UserUpdatePayload {
  fullName?: string;
  email?: string;
  phone?: string;
  isActive?: boolean;
  storeIds?: string[];
}

/**
 * Порядок магазинов не значим для сравнения: сервер всё равно назначает
 * магазином по умолчанию первый элемент переданного массива. Иначе смена
 * порядка в интерфейсе выглядела бы как содержательная правка.
 */
function sameStoreSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/** Начальный черновик карточки по данным сервера. */
export function userEditDraft(fields: UserEditableFields): UserEditDraft {
  return {
    fullName: fields.fullName,
    email: fields.email,
    phone: fields.phone ?? '',
    isActive: fields.isActive,
    storeIds: [...fields.storeIds],
  };
}

/** Есть ли в черновике хотя бы одно изменение относительно исходных данных. */
export function hasUserChanges(original: UserEditableFields, draft: UserEditDraft): boolean {
  return buildUserUpdateInput(original, draft) !== null;
}

/**
 * Собрать частичное изменение. `null` означает «администратор ничего не
 * изменил» — в этом случае запрос на сервер не отправляется, и карточка просто
 * закрывается: пустой `PATCH` вернул бы `200`, но выглядел бы как сохранение.
 */
export function buildUserUpdateInput(
  original: UserEditableFields,
  draft: UserEditDraft,
): UserUpdatePayload | null {
  const payload: UserUpdatePayload = {};

  const fullName = draft.fullName.trim();
  if (fullName !== original.fullName) payload.fullName = fullName;

  const email = draft.email.trim();
  if (email !== original.email) payload.email = email;

  // Пустая строка — это осознанное «стереть телефон», а не «не трогать поле».
  const phone = draft.phone.trim();
  if (phone !== (original.phone ?? '')) payload.phone = phone;

  if (draft.isActive !== original.isActive) payload.isActive = draft.isActive;

  if (!sameStoreSet(draft.storeIds, original.storeIds)) payload.storeIds = [...draft.storeIds];

  return Object.keys(payload).length === 0 ? null : payload;
}

/**
 * Клиентская проверка черновика до отправки.
 *
 * Повторяет правила `updateUserSchema`, но сообщает о первой ошибке рядом с
 * полями, а не после ответа сервера: администратор правит одну карточку и не
 * должен ждать сети, чтобы узнать, что ФИО из одного символа не принимается.
 */
export function describeUserDraftError(draft: UserEditDraft): string | null {
  const fullName = draft.fullName.trim();
  if (fullName.length < 2 || fullName.length > 200) return 'Укажите ФИО';

  const email = draft.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Некорректный email';

  const phone = draft.phone.trim();
  if (phone !== '') {
    if (phone.length > 25) return 'Телефон слишком длинный';
    if (phone.replace(/\D/g, '').length < 10) return 'Укажите телефон полностью';
  }

  return null;
}

/**
 * Код причины, по которой пароль не проходит политику; список пуст — проходит.
 *
 * Осталась ОДНА причина: политика сократилась до длины (минимум 6 символов,
 * решение заказчика). Коды `MISSING_LOWER`, `MISSING_UPPER` и `MISSING_DIGIT`
 * убраны вместе с требованиями, которые они описывали: код, который невозможно
 * получить, пришлось бы держать в словаре переводов и объяснять при следующей
 * правке — то есть он только вводил бы в заблуждение.
 */
export type PasswordPolicyViolation = 'TOO_SHORT';

/**
 * Разобрать пароль по правилам политики.
 *
 * Отдельно от `isStrongEnoughPassword`, потому что администратору нужно
 * объяснить, ЧЕГО не хватает. Кнопка, которая просто «серая» без причины,
 * воспринимается как отсутствующая — именно так и выглядел сброс пароля.
 */
export function passwordPolicyViolations(password: string): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  if (password.length < 6) violations.push('TOO_SHORT');
  return violations;
}

/**
 * Готов ли пароль к отправке. Проверка целиком делегируется общей политике
 * (`@app/shared`), а не повторяется здесь: расхождение с сервером означало бы
 * кнопку, которая активна, но получает `VALIDATION_ERROR`. Пустая строка
 * политику не проходит и потому тоже не готова — отдельной ветки для неё нет,
 * иначе появилось бы условие, которое невозможно нарушить.
 */
export function isPasswordReady(password: string): boolean {
  return isStrongEnoughPassword(password);
}

/**
 * Стоит ли показывать, чего не хватает в пароле.
 *
 * На нетронутом поле подсказка «минимум 6 символов» читалась бы как уже
 * допущенная ошибка, поэтому причины показываются только после начала ввода.
 */
export function shouldExplainPassword(password: string): boolean {
  return password !== '' && !isPasswordReady(password);
}
