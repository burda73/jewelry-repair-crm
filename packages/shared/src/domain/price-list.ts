/**
 * Правила жизненного цикла прейскуранта (задача 1.4.2–1.4.3).
 *
 * Прейскурант — это ЦЕНЫ. Изменение цены задним числом меняет смысл уже
 * принятых заказов, поэтому версия проходит путь «черновик → на утверждение →
 * утверждена», а утверждённая версия перестаёт быть редактируемой. Здесь
 * собраны сами правила; ни сервис, ни интерфейс их не дублируют.
 *
 * Почему отдельный модуль, а не проверки внутри сервиса. Правил три, и они
 * проверяются в двух местах — API и интерфейсе (интерфейс прячет недоступные
 * действия). Разойдись они, кнопка вела бы к отказу, а человек считал бы, что
 * сломан продукт. Один источник исключает это.
 */

/** Статусы версии прейскуранта. Совпадают с `PriceListStatus` в схеме БД. */
export const PRICE_LIST_STATUS = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  ARCHIVED: 'ARCHIVED',
  REJECTED: 'REJECTED',
} as const;

export type PriceListStatus = (typeof PRICE_LIST_STATUS)[keyof typeof PRICE_LIST_STATUS];

export const ALL_PRICE_LIST_STATUSES: readonly PriceListStatus[] = Object.values(PRICE_LIST_STATUS);

/** Русские названия статусов для интерфейса. */
export const PRICE_LIST_STATUS_LABELS: Record<PriceListStatus, string> = {
  DRAFT: 'Черновик',
  PENDING_APPROVAL: 'На утверждении',
  APPROVED: 'Утверждён',
  ARCHIVED: 'Архив',
  REJECTED: 'Отклонён',
};

export function isPriceListStatus(value: unknown): value is PriceListStatus {
  return (
    typeof value === 'string' && (ALL_PRICE_LIST_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Статусы, в которых версию МОЖНО править: содержимое и состав позиций.
 *
 * `REJECTED` включён намеренно. Отклонённую версию возвращают в работу: руководитель
 * объясняет причину, администратор исправляет и отправляет снова. Запрет правки
 * заставлял бы создавать новую версию с нуля, теряя при этом уже набранные
 * 24 позиции, — то есть отклонение наказывало бы за исправление.
 */
export const EDITABLE_PRICE_LIST_STATUSES: readonly PriceListStatus[] = [
  PRICE_LIST_STATUS.DRAFT,
  PRICE_LIST_STATUS.REJECTED,
];

/**
 * Можно ли править содержимое версии.
 *
 * ГЛАВНОЕ ПРАВИЛО ЗАДАЧИ 1.4.3: утверждённую версию править нельзя. По ней уже
 * посчитаны заказы, и изменение цены задним числом сделало бы историю
 * недостоверной — при этом незаметно: суммы в заказах хранятся копией, но
 * расхождения между квитанцией и прейскурантом всплыли бы при разборе.
 *
 * Архив править тоже нельзя: он существует, чтобы объяснять прошлые заказы.
 */
export function isPriceListEditable(status: PriceListStatus): boolean {
  return EDITABLE_PRICE_LIST_STATUSES.includes(status);
}

/**
 * Коды ошибок отказа в правке — часть контракта API (docs/07 §16).
 *
 * Отдельный код на каждый статус, а не общий «нельзя»: интерфейс должен
 * объяснить, что именно делать дальше («утверждённую версию скопируйте в новую»
 * против «архив не восстанавливается»).
 */
export const PRICE_LIST_EDIT_DENIED_CODE = {
  [PRICE_LIST_STATUS.APPROVED]: 'PRICE_LIST_APPROVED_IMMUTABLE',
  [PRICE_LIST_STATUS.PENDING_APPROVAL]: 'PRICE_LIST_PENDING_APPROVAL',
  [PRICE_LIST_STATUS.ARCHIVED]: 'PRICE_LIST_ARCHIVED',
  [PRICE_LIST_STATUS.DRAFT]: 'PRICE_LIST_NOT_EDITABLE',
  [PRICE_LIST_STATUS.REJECTED]: 'PRICE_LIST_NOT_EDITABLE',
} as const;

/** Русское объяснение отказа в правке: что делать дальше, а не «нельзя». */
export const PRICE_LIST_EDIT_DENIED_MESSAGE: Record<PriceListStatus, string> = {
  [PRICE_LIST_STATUS.APPROVED]:
    'Утверждённый прейскурант нельзя изменить. Создайте новую версию на основе этой — изменения вступят в силу отдельным документом.',
  [PRICE_LIST_STATUS.PENDING_APPROVAL]:
    'Версия отправлена на утверждение. Верните её в черновик, чтобы продолжить правку.',
  [PRICE_LIST_STATUS.ARCHIVED]:
    'Архивная версия недоступна для правки: она объясняет цены прошлых заказов. Создайте новую версию.',
  [PRICE_LIST_STATUS.DRAFT]: 'Версию можно править.',
  [PRICE_LIST_STATUS.REJECTED]: 'Версию можно править.',
};

/** Действие над версией прейскуранта. */
export type PriceListAction =
  'EDIT' | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'ARCHIVE' | 'RESTORE_TO_DRAFT' | 'COPY';

/**
 * Разрешённые переходы статусов версии: `действие → из каких статусов`.
 *
 * Это ЕДИНСТВЕННОЕ место, где описаны переходы. `DRAFT → APPROVED` напрямую
 * отсутствует намеренно: утверждение без явной отправки означало бы, что
 * руководитель утвердил то, что не видел, — и подпись под ценой теряла бы смысл.
 *
 * `REJECT` возвращает версию в `REJECTED`, а не в `DRAFT`: причина отклонения
 * должна остаться видимой до исправления, иначе администратор не поймёт, что
 * именно поправлено.
 */
export const PRICE_LIST_TRANSITIONS: Record<PriceListAction, readonly PriceListStatus[]> = {
  EDIT: EDITABLE_PRICE_LIST_STATUSES,
  SUBMIT: [PRICE_LIST_STATUS.DRAFT, PRICE_LIST_STATUS.REJECTED],
  APPROVE: [PRICE_LIST_STATUS.PENDING_APPROVAL],
  REJECT: [PRICE_LIST_STATUS.PENDING_APPROVAL],
  ARCHIVE: [PRICE_LIST_STATUS.APPROVED],
  RESTORE_TO_DRAFT: [PRICE_LIST_STATUS.PENDING_APPROVAL],
  /*
   * Создание новой версии на основе этой. Доступно ИЗ УТВЕРЖДЁННОЙ и АРХИВНОЙ:
   * именно так меняют цены — утверждённую версию не правят, а заменяют новой, и
   * новый документ начинается с уже набранных позиций, а не с пустого листа.
   *
   * Это единственное действие, которое НЕ переводит саму версию: оно создаёт
   * ДРУГУЮ запись. Поэтому целевой статус у него `null` (см. таблицу ниже), и
   * архив перестаёт быть тупиком: из него есть осмысленный следующий шаг.
   */
  COPY: [PRICE_LIST_STATUS.APPROVED, PRICE_LIST_STATUS.ARCHIVED],
};

/** Статус, в который переводит действие. `EDIT` статус не меняет. */
export const PRICE_LIST_ACTION_TARGET: Record<PriceListAction, PriceListStatus | null> = {
  EDIT: null,
  SUBMIT: PRICE_LIST_STATUS.PENDING_APPROVAL,
  APPROVE: PRICE_LIST_STATUS.APPROVED,
  REJECT: PRICE_LIST_STATUS.REJECTED,
  ARCHIVE: PRICE_LIST_STATUS.ARCHIVED,
  RESTORE_TO_DRAFT: PRICE_LIST_STATUS.DRAFT,
  // Новая версия создаётся в статусе `DRAFT`, но это ДРУГАЯ запись: текущая
  // остаётся в своём статусе. Поэтому здесь `null`, а не `DRAFT`.
  COPY: null,
};

/** Можно ли выполнить действие над версией в указанном статусе. */
export function canApplyPriceListAction(action: PriceListAction, status: PriceListStatus): boolean {
  return PRICE_LIST_TRANSITIONS[action].includes(status);
}

/** Русские названия действий для интерфейса. */
export const PRICE_LIST_ACTION_LABELS: Record<PriceListAction, string> = {
  EDIT: 'Править',
  SUBMIT: 'Отправить на утверждение',
  APPROVE: 'Утвердить',
  REJECT: 'Отклонить',
  ARCHIVE: 'В архив',
  RESTORE_TO_DRAFT: 'Вернуть в черновик',
  COPY: 'Создать версию на основе этой',
};

/**
 * Подсказка о следующем шаге для интерфейса: что можно сделать с версией сейчас.
 *
 * Возвращается список действий, а не только «редактируема/нет»: администратору
 * нужно видеть, доступна ли отправка и утверждение, иначе он нажимает кнопку и
 * получает отказ, который можно было предвидеть.
 */
export function availablePriceListActions(status: PriceListStatus): readonly PriceListAction[] {
  const all: PriceListAction[] = [
    'EDIT',
    'SUBMIT',
    'APPROVE',
    'REJECT',
    'ARCHIVE',
    'RESTORE_TO_DRAFT',
    'COPY',
  ];
  return all.filter((action) => canApplyPriceListAction(action, status));
}
