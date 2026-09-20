/**
 * Реквизиты организации для печатных документов (требование заказчика).
 *
 * ## Почему отдельный модуль, а не переменные окружения
 *
 * Наименование организации печатается в квитанции и акте. Раньше оно задавалось
 * переменной окружения на сервере: чтобы поменять «РЕМИКС ГОЛД» на «ИП Бурда
 * Виталий Валерьевич», нужен доступ к серверу и перезапуск сервиса. Директор
 * такого доступа не имеет, а реквизиты меняются без программиста.
 *
 * Теперь значение хранится в настройках системы и правится администратором, а
 * переменная окружения остаётся ЗАПАСНЫМ вариантом: если в базе пусто, берётся
 * она. Так обновление ничего не ломает — до первого сохранения поведение
 * прежнее.
 *
 * ## Что здесь, а что в интерфейсе
 *
 * Здесь — правила и значения по умолчанию: что считается заполненным, что
 * печатать, если значение не задано. Вёрстка и поля ввода — в интерфейсе.
 */

/** Ключ настройки с реквизитами организации. */
export const ORGANIZATION_SETTING_KEY = 'organization.requisites';

/**
 * Реквизиты организации.
 *
 * Все поля необязательные: организация может печатать только название, а ИНН
 * добавить позже. Обязательность названия — отдельное правило, потому что
 * документ без исполнителя бессмыслен.
 */
export interface OrganizationRequisites {
  /** Наименование для документов: «ИП Бурда Виталий Валерьевич». */
  name: string;
  /** ИНН. Необязателен: в образце квитанции его нет. */
  inn: string | null;
  /** Телефон организации (общий, не магазина). */
  phone: string | null;
  /** Адрес организации. */
  address: string | null;
}

/** Значение, которым подставляется название, если ничего не задано. */
export const DEFAULT_ORGANIZATION_NAME = 'Ремонт ювелирных изделий';

/** Реквизиты по умолчанию: только название, остальное пусто. */
export function defaultRequisites(): OrganizationRequisites {
  return { name: DEFAULT_ORGANIZATION_NAME, inn: null, phone: null, address: null };
}

/**
 * Привести реквизиты из хранилища к известной форме.
 *
 * Значение в базе — произвольный JSON, и полагаться на его форму нельзя: запись
 * могла остаться от прежней версии, а поле могли дописать руками. Функция
 * читает только известные ключи и приводит пустые строки к `null`, чтобы
 * «заполнено пробелами» не считалось заполненным.
 */
export function normalizeRequisites(raw: unknown): OrganizationRequisites {
  const defaults = defaultRequisites();
  if (typeof raw !== 'object' || raw === null) return defaults;

  const input = raw as Record<string, unknown>;

  /** Непустая строка или `null`: пробелы заполнением не считаются. */
  const text = (value: unknown, fallback: string | null): string | null => {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  return {
    name: text(input.name, null) ?? defaults.name,
    inn: text(input.inn, null),
    phone: text(input.phone, null),
    address: text(input.address, null),
  };
}

/**
 * Название организации для печати.
 *
 * Если реквизиты не заполнены, берётся значение из окружения — оно было
 * единственным источником до появления настроек. Пусто и там — общее название:
 * документ без исполнителя печатать нельзя, но и падать из-за этого он не
 * должен.
 */
export function organizationNameForPrint(params: {
  requisites: OrganizationRequisites;
  envFallback: string | null;
}): string {
  const fromSettings = params.requisites.name.trim();
  if (fromSettings !== '' && fromSettings !== DEFAULT_ORGANIZATION_NAME) return fromSettings;

  const fallback = params.envFallback?.trim() ?? '';
  if (fallback !== '') return fallback;

  return DEFAULT_ORGANIZATION_NAME;
}

/**
 * Заполнено ли значение для печати.
 *
 * Нужно интерфейсу, чтобы показать «не задано» вместо пустой строки, и квитанции,
 * чтобы не печатать строку с одним двоеточием.
 */
export function isFilled(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value.trim() !== '';
}
