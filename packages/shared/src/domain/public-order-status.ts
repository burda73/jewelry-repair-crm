/**
 * Публичная проверка статуса заказа (задача 5.11, docs/05 §5, docs/07 §15).
 *
 * ## Зачем это отдельный домен, а не код в контроллере
 *
 * Здесь живут правила ДОСТУПА к чужим данным, а не форматирование ответа. Такие
 * правила обязаны быть проверяемыми тестом на десятках случаев: ошибка в них —
 * это утечка чужого заказа, и заметить её в контроллере по одному сценарию
 * невозможно.
 *
 * ## Угроза, ради которой всё сделано именно так
 *
 * Номера заказов угадываемы: формат «МСК1-2509-000001» содержит код магазина,
 * месяц и последовательный номер. Без защиты перебор номеров давал бы чужую
 * информацию: статус, сумму, срок. Поэтому доступ требует ДВУХ факторов —
 * номера заказа И кода, отправленного на телефон клиента из этого заказа.
 *
 * Публичный ответ содержит МИНИМУМ (docs/05 §5): статус, срок, сумму. Никаких
 * ФИО, адресов, телефонов и истории — перечень полей задан здесь, чтобы он не
 * «расползся» по мере доработок.
 */

/**
 * Сколько цифр в коде подтверждения.
 *
 * Четыре — компромисс: код диктуют по телефону и вводят на телефоне, длиннее
 * вводить неудобно. Четыре цифры — это 10 000 комбинаций, то есть перебор
 * реален, и защита держится НЕ на длине кода, а на счётчике попыток и сроке
 * жизни (см. `PUBLIC_CODE_MAX_ATTEMPTS`).
 */
export const PUBLIC_CODE_DIGITS = 4;

/** Срок жизни кода: 10 минут (docs/05 §5). */
export const PUBLIC_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Сколько раз можно ошибиться, прежде чем код перестанет действовать.
 *
 * ЭТО ГЛАВНАЯ ЗАЩИТА, а не длина кода. Четыре цифры дают 10 000 комбинаций, и
 * без счётчика их перебирают за минуты даже с учётом сетевых задержек. С
 * пятью попытками вероятность угадать — 0,05 %, а после пятой ошибки код
 * гасится: чтобы продолжить, нужно запросить новый, а выдача ограничена
 * `PUBLIC_CODE_REQUESTS_PER_HOUR`.
 */
export const PUBLIC_CODE_MAX_ATTEMPTS = 5;

/**
 * Сколько кодов можно запросить на один телефон за час (docs/05 §5).
 *
 * Ограничение ПО ТЕЛЕФОНУ, а не по адресу. Счётчик по IP здесь бесполезен: SMS
 * «выкачивают» с множества адресов на один номер, и как раз этот сценарий —
 * платные сообщения за счёт магазина — ограничение и должно остановить.
 */
export const PUBLIC_CODE_REQUESTS_PER_HOUR = 3;

/** Окно, в котором считаются запросы кода. */
export const PUBLIC_CODE_REQUEST_WINDOW_MS = 60 * 60 * 1000;

/**
 * Сколько знаков номера телефона показывать при подтверждении.
 *
 * Показываем последние четыре: клиент по ним узнаёт свой номер, а посторонний,
 * перебирающий заказы, не получает полный номер — тот сам по себе является
 * персональным данным и ключом к остальным заказам клиента.
 */
export const PUBLIC_PHONE_VISIBLE_DIGITS = 4;

/**
 * Статусы, при которых заказ ВИДЕН публично.
 *
 * `DRAFT` намеренно отсутствует: черновик — незавершённый приём, его мог начать
 * и бросить сотрудник, и клиент по такому заказу ещё ничего не сдавал. Показ
 * «Черновик» на публичной странице только путал бы. Вместо этого по черновику
 * отвечаем «заказ не найден» — ровно так же, как по несуществующему.
 */
export const PUBLIC_VISIBLE_STATUSES = [
  'AWAITING_APPROVAL',
  'AWAITING_PREPAYMENT',
  'ACCEPTED',
  'QUEUED_FOR_DISPATCH',
  'IN_TRANSIT_TO_PRODUCTION',
  'IN_PRODUCTION',
  'ACCEPTED_BY_WORKSHOP',
  'IN_WORK',
  'WORK_COMPLETED',
  'IN_TRANSIT_TO_STORE',
  'READY_FOR_PICKUP',
  'UNCLAIMED',
  'COMPLETED',
  'REFUSED',
  'REFUSED_BEFORE_WORK',
  'CANCELLED',
  'REWORK',
] as const;

export type PublicVisibleStatus = (typeof PUBLIC_VISIBLE_STATUSES)[number];

/**
 * Формулировки статусов ДЛЯ КЛИЕНТА.
 *
 * Отдельный словарь, а не `STATUS_LABELS` из `order-status.ts`. Причина: внутри
 * системы статусы названы так, как удобно сотрудникам, и часть названий клиенту
 * непонятна или звучит пугающе. «Невостребовано» читается как претензия к
 * клиенту, «Отказ от оплаты» — как юридический ярлык, «В пути в цех» не
 * сообщает, где изделие. Клиентский текст говорит о том, что происходит с его
 * вещью и что от него требуется.
 *
 * Тест сверяет, что словарь покрывает РОВНО `PUBLIC_VISIBLE_STATUSES`: новый
 * статус, добавленный в систему и забытый здесь, стал бы виден клиенту как
 * внутреннее название.
 */
export const PUBLIC_STATUS_LABELS: Record<PublicVisibleStatus, string> = {
  AWAITING_APPROVAL: 'Согласуем с вами стоимость',
  AWAITING_PREPAYMENT: 'Ожидаем предоплату',
  ACCEPTED: 'Заказ принят',
  QUEUED_FOR_DISPATCH: 'Готовим к отправке в цех',
  IN_TRANSIT_TO_PRODUCTION: 'Изделие направлено в цех',
  IN_PRODUCTION: 'Идёт ремонт',
  /*
   * Три статуса производства для клиента НЕ различаются: ему неважно, распределена
   * работа между мастерами или уже выполняется. «Идёт ремонт» — то же, что и
   * `IN_PRODUCTION`: клиент видит непрерывный этап, а не внутреннюю кухню цеха.
   */
  ACCEPTED_BY_WORKSHOP: 'Идёт ремонт',
  IN_WORK: 'Идёт ремонт',
  WORK_COMPLETED: 'Ремонт завершён, готовим к отправке',
  IN_TRANSIT_TO_STORE: 'Изделие возвращается в магазин',
  READY_FOR_PICKUP: 'Готово к выдаче',
  UNCLAIMED: 'Ждёт вас в магазине',
  COMPLETED: 'Заказ выдан',
  REFUSED: 'Ремонт не выполнен',
  REFUSED_BEFORE_WORK: 'Заказ закрыт по вашему отказу',
  CANCELLED: 'Заказ отменён',
  REWORK: 'Устраняем замечания',
};

/** Виден ли заказ на публичной странице при таком статусе. */
export function isPubliclyVisible(status: string): boolean {
  return (PUBLIC_VISIBLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Текст статуса для клиента.
 *
 * Возвращает `null`, если статус публично не показывается. `null`, а не текст
 * по умолчанию: подставить внутреннее название чужого статуса хуже, чем ничего
 * не показать, — в первом случае утечёт внутренняя терминология и станет
 * понятно, что заказ существует.
 */
export function publicStatusLabel(status: string): string | null {
  if (!isPubliclyVisible(status)) return null;
  return PUBLIC_STATUS_LABELS[status as PublicVisibleStatus] ?? null;
}

/**
 * Источник случайности для кода.
 *
 * Параметр ради тестов: без него нельзя проверить ни равномерность, ни
 * поведение при «плохом» источнике. Тот же приём, что в генераторе паролей.
 */
export type CodeRandomSource = (bytes: Uint8Array) => Uint8Array;

const defaultRandom: CodeRandomSource = (bytes) => {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj === undefined || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Источник криптографической случайности недоступен');
  }
  return cryptoObj.getRandomValues(bytes);
};

/**
 * Сгенерировать код подтверждения.
 *
 * Отбрасываем «хвост» значений, не покрывающий полный круг: `byte % 10` смещает
 * выбор к первым цифрам, потому что 256 не делится на 10 нацело (цифры 0..5
 * выпадают 26 раз, 6..9 — 25). При 10 000 комбинациях и переборе такое смещение
 * сокращает работу противнику, а не нам.
 */
export function generateCode(random: CodeRandomSource = defaultRandom): string {
  const alphabet = '0123456789';
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const buffer = new Uint8Array(1);
  let code = '';

  while (code.length < PUBLIC_CODE_DIGITS) {
    random(buffer);
    const value = buffer[0] ?? 0;
    if (value >= limit) continue;
    code += alphabet[value % alphabet.length];
  }

  return code;
}

/**
 * Похож ли ввод на код подтверждения.
 *
 * Проверяем ДО обращения к базе: иначе любой мусор в поле вызывал бы запрос и
 * позволял нагружать систему. Пробелы и дефисы убираем — код диктуют голосом и
 * записывают как «12 34», а требовать от клиента точного ввода незачем.
 */
export function normalizeCodeInput(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  if (digits.length !== PUBLIC_CODE_DIGITS) return null;
  if (!/^\d+$/.test(digits)) return null;
  return digits;
}

/** Истёк ли код. */
export function isCodeExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/**
 * Исчерпаны ли попытки.
 *
 * Проверяется ДО сравнения кода: иначе последняя попытка всё ещё работала бы, а
 * смысл ограничения — в том, что после N ошибок код мёртв независимо от того,
 * угадали бы следующей или нет.
 */
export function isCodeLocked(attempts: number): boolean {
  return attempts >= PUBLIC_CODE_MAX_ATTEMPTS;
}

/** Сколько попыток осталось. Ноль означает, что код заблокирован. */
export function remainingAttempts(attempts: number): number {
  return Math.max(0, PUBLIC_CODE_MAX_ATTEMPTS - attempts);
}

/** Можно ли запросить новый код при таком числе недавних запросов. */
export function canRequestCode(recentRequests: number): boolean {
  return recentRequests < PUBLIC_CODE_REQUESTS_PER_HOUR;
}

/**
 * Маска телефона для показа клиенту.
 *
 * Оставляем последние четыре цифры: их достаточно, чтобы клиент узнал свой
 * номер, и недостаточно, чтобы узнать чужой. Формат вывода намеренно не зависит
 * от формата хранения — в базе номер лежит нормализованным (E.164), а
 * показывать его целиком нельзя.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= PUBLIC_PHONE_VISIBLE_DIGITS) return '****';
  return `****${digits.slice(-PUBLIC_PHONE_VISIBLE_DIGITS)}`;
}

/**
 * Что видно клиенту по заказу.
 *
 * Поля перечислены ЯВНО и по одному — это и есть защита от разрастания ответа.
 * Добавить сюда `customerName` или `description` нельзя незаметно: тип не
 * позволит, а тест сверит состав ключей.
 */
export interface PublicOrderStatusView {
  /** Номер заказа, как его ввёл клиент. */
  orderNo: string;
  /** Текст статуса для клиента. */
  statusLabel: string;
  /** Внутренний код статуса: нужен интерфейсу для цвета и порядка шагов. */
  status: PublicVisibleStatus;
  /** Плановая дата готовности. */
  dueAt: string | null;
  /** Сумма заказа в минорных единицах. */
  totalAmountMinor: number;
  /** Сколько уже оплачено. */
  paidAmountMinor: number;
  /** Сколько осталось внести. */
  remainingAmountMinor: number;
  currency: string;
  /** Маска телефона, на который выдан код: подтверждение, что это «свой» заказ. */
  phoneMask: string;
}

/**
 * Собрать публичное представление заказа.
 *
 * Функция, а не разбор объекта в контроллере: так состав полей проверяется
 * тестом, и «лишнее поле» не появится оттого, что кто-то вернул объект целиком.
 * `remainingAmountMinor` не может быть отрицательным — переплата не должна
 * выглядеть как долг магазина клиенту в публичном ответе.
 */
export function toPublicOrderStatusView(input: {
  orderNo: string;
  status: string;
  dueAt: Date | null;
  totalAmountMinor: number;
  paidAmountMinor: number;
  currency: string;
  phone: string;
}): PublicOrderStatusView | null {
  const label = publicStatusLabel(input.status);
  if (label === null) return null;

  return {
    orderNo: input.orderNo,
    statusLabel: label,
    status: input.status as PublicVisibleStatus,
    dueAt: input.dueAt === null ? null : input.dueAt.toISOString(),
    totalAmountMinor: input.totalAmountMinor,
    paidAmountMinor: input.paidAmountMinor,
    remainingAmountMinor: Math.max(0, input.totalAmountMinor - input.paidAmountMinor),
    currency: input.currency,
    phoneMask: maskPhone(input.phone),
  };
}
