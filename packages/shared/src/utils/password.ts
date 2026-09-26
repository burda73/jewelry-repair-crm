/**
 * Генерация паролей для учётных записей, которые заводит администратор.
 *
 * Живёт в доменном пакете, а не в интерфейсе, по трём причинам:
 *  * тот же генератор нужен серверному скрипту ротации
 *    (`scripts/rotate-demo-passwords.mjs`) — иначе появились бы две реализации,
 *    которые расходятся в алфавитах и длине;
 *  * результат обязан удовлетворять `passwordSchema`, а это доменное правило;
 *  * генератор можно проверить тестом на многих прогонах, чего не сделать для
 *    функции внутри React-компонента.
 *
 * Требования к результату:
 *  * не меньше 6 символов (`passwordSchema`), берём 20 — с запасом;
 *  * есть строчная, прописная буква и цифра. ЭТО НЕ ТРЕБОВАНИЕ ПОЛИТИКИ: состав
 *    символов заказчик отменил, генератор просто продолжает выдавать пароли
 *    прежней стойкости — снижать её не требуется, а длина и разнообразие
 *    алфавита достаются бесплатно;
 *  * нет визуально неоднозначных символов: пароль диктуют голосом или
 *    переписывают с экрана, и `O`/`0`, `l`/`1`, `I` приводят к ошибкам входа,
 *    которые выглядят как «пароль не подошёл».
 */

/** Строчные буквы без `l` и `o` (похожи на `1` и `0`). */
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
/** Прописные буквы без `I` и `O`. */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Цифры без `0` и `1`. */
const DIGIT = '23456789';
const ALL = LOWER + UPPER + DIGIT;

/** Длина пароля по умолчанию. */
export const GENERATED_PASSWORD_LENGTH = 20;

/**
 * Источник случайности.
 *
 * По умолчанию `crypto.getRandomValues`. Параметр существует для тестов: без
 * него нельзя проверить ни равномерность, ни поведение при «плохом» источнике.
 */
export type RandomSource = (bytes: Uint8Array) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => {
  // `globalThis.crypto` есть и в браузере, и в Node 18+. Проверяем явно,
  // потому что при его отсутствии пароль оказался бы предсказуемым.
  const cryptoObj = globalThis.crypto;
  if (cryptoObj === undefined || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Источник криптографической случайности недоступен');
  }
  return cryptoObj.getRandomValues(bytes);
};

/**
 * Выбрать один символ из алфавита без смещения распределения.
 *
 * `byte % length` смещает выбор к первым символам, когда длина алфавита не
 * делит 256: например, при алфавите из 3 символов значения 0..255 дают 0 в
 * 86 случаях против 85 у остальных. Отбрасываем «хвост» значений, не
 * покрывающий полный круг, — тогда все символы равновероятны.
 */
function pick(alphabet: string, random: RandomSource): string {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const buffer = new Uint8Array(1);
  for (;;) {
    const value = random(buffer)[0] ?? 0;
    if (value < limit) {
      return alphabet[value % alphabet.length] ?? '';
    }
  }
}

/**
 * Перемешать массив (Фишер—Йетс).
 *
 * Нужно, потому что обязательные символы добавляются первыми: без перемешивания
 * пароль всегда начинался бы со строчной буквы, затем прописной и цифры, то
 * есть три позиции были бы предсказуемы.
 */
function shuffle(chars: string[], random: RandomSource): void {
  const buffer = new Uint32Array(chars.length);
  random(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = (buffer[i] ?? 0) % (i + 1);
    const a = chars[i] ?? '';
    const b = chars[j] ?? '';
    chars[i] = b;
    chars[j] = a;
  }
}

/**
 * Сгенерировать пароль, удовлетворяющий `passwordSchema`.
 *
 * Результат детерминирован при переданном `random`, что и используется в тестах.
 */
export function generatePassword(
  length: number = GENERATED_PASSWORD_LENGTH,
  random: RandomSource = defaultRandom,
): string {
  if (!Number.isInteger(length) || length < 3) {
    throw new Error('Длина пароля должна быть целым числом не меньше 3');
  }

  const chars = [pick(LOWER, random), pick(UPPER, random), pick(DIGIT, random)];
  while (chars.length < length) {
    chars.push(pick(ALL, random));
  }

  shuffle(chars, random);
  return chars.join('');
}

/**
 * Проверить, что пароль удовлетворяет парольной политике.
 *
 * Продублировано здесь, а не импортировано из `validation/schemas.ts`, чтобы
 * `utils/` не зависел от `validation/` — иначе получился бы цикл импортов.
 * Соответствие проверяется тестом: он гоняет генератор и `passwordSchema`
 * вместе, поэтому расхождение будет обнаружено, а не останется незамеченным.
 *
 * Политика — только длина (минимум 6 символов, решение заказчика): требований к
 * регистру, цифрам и специальным символам больше нет. Обе границы продублированы
 * буквально: расхождение с `passwordSchema` означало бы, что пароль, принятый
 * администратором, не проходит смену пароля самим сотрудником.
 */
export function isStrongEnoughPassword(password: string): boolean {
  return password.length >= 6 && password.length <= 128;
}
