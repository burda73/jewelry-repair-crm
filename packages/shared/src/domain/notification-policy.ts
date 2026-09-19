/**
 * Правила выбора каналов уведомления (задача 5.10, docs/05 §3).
 *
 * ЗАЧЕМ ПРАВИЛА В ДОМЕНЕ, А НЕ В СЕРВИСЕ. «Кому и как сообщать о событии» — это
 * решение о бизнес-процессе, а не техническая деталь доставки. Клиенту о
 * готовности заказа звонят или пишут в мессенджер, а приёмщику о просрочке —
 * письмом. Если это зашито в вызывающий код, то при добавлении канала правится
 * каждое место рассылки, и однажды одно из них забывают.
 *
 * ГЛАВНОЕ РЕШЕНИЕ ЗДЕСЬ: SMS — ПЛАТНЫЙ И ВНЕШНИЙ КАНАЛ, И ОН ВЫКЛЮЧЕН ПО
 * УМОЛЧАНИЮ. Ошибка в выборе канала стоит не «неудобства», а денег: массовая
 * рассылка по ошибке уходит реальным клиентам и тарифицируется. Поэтому решение
 * «отправлять ли SMS» отделено от решения «создавать ли уведомление»: запись в
 * базу создаётся всегда, а внешняя отправка — только при включённом канале.
 *
 * ЧТО ЭТО ЗНАЧИТ ПРАКТИЧЕСКИ. При выключенном SMS событие не теряется: оно
 * остаётся `IN_APP`-записью с пометкой канала, и его видно в истории. Когда канал
 * включат, новые события начнут уходить в SMS, а старые не «догоняются» — и это
 * правильно: клиенту через неделю после готовности заказа писать уже нечего.
 */

/**
 * Кому адресовано уведомление.
 *
 * Различие принципиальное: клиенту нельзя показать внутренние формулировки
 * («просрочка на этапе производства»), а сотруднику не нужно писать «ваш заказ
 * готов» — он не клиент.
 */
export const NOTIFICATION_AUDIENCE = {
  /** Клиент: только внешние каналы, ничего внутреннего. */
  CUSTOMER: 'CUSTOMER',
  /** Сотрудник: канал в приложении и почта. */
  STAFF: 'STAFF',
} as const;

export type NotificationAudience =
  (typeof NOTIFICATION_AUDIENCE)[keyof typeof NOTIFICATION_AUDIENCE];

/** Правило доставки одного события. */
export interface NotificationChannelRule {
  /** Код шаблона. */
  code: string;
  /** Кому адресовано. */
  audience: NotificationAudience;
  /** Каналы, которые нужны ВСЕГДА (внутренние, бесплатные). */
  baseChannels: readonly string[];
  /** Каналы, которые подключаются настройкой (внешние, платные). */
  optionalChannels: readonly string[];
}

/**
 * Длина одного SMS в символах.
 *
 * 70 символов для кириллицы — это ОДНО сообщение. Всё, что длиннее, разбивается
 * на части, и каждая тарифицируется отдельно: «сообщение на 140 символов» стоит
 * как два SMS, а не как одно. Поэтому тексты SMS хранятся отдельными шаблонами,
 * короткими, а не берутся из письма.
 */
export const SMS_SINGLE_LENGTH = 70;

/** События для клиента (docs/05 §3). */
export const CUSTOMER_NOTIFICATION_CODES = {
  ORDER_ACCEPTED: 'ORDER_ACCEPTED',
  APPROVAL_REQUEST: 'APPROVAL_REQUEST',
  PREPAYMENT_RECEIVED: 'PREPAYMENT_RECEIVED',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  UNCLAIMED_REMINDER: 'UNCLAIMED_REMINDER',
  WARRANTY_ISSUED: 'WARRANTY_ISSUED',
} as const;

/** События для сотрудника (docs/05 §3). */
export const STAFF_NOTIFICATION_CODES = {
  ORDER_OVERDUE: 'ORDER_OVERDUE',
  ESCALATION_MANAGER: 'ESCALATION_MANAGER',
  ORDER_UNCLAIMED: 'ORDER_UNCLAIMED',
  CLAIM_DEADLINE: 'CLAIM_DEADLINE',
  BATCH_RECEIVED: 'BATCH_RECEIVED',
  BATCH_TRANSIT_LATE: 'BATCH_TRANSIT_LATE',
} as const;

/**
 * Полный список правил доставки.
 *
 * Соответствует таблице в docs/05 §3. События для клиента идут через SMS или
 * мессенджер — это внешние каналы, и они подключаются настройкой. События для
 * сотрудника идут в приложение и на почту: почта уже реализована (задача 5.9), а
 * SMS сотруднику не нужен — рабочие вопросы решаются в системе.
 */
export const NOTIFICATION_CHANNEL_RULES: readonly NotificationChannelRule[] = [
  {
    code: CUSTOMER_NOTIFICATION_CODES.ORDER_ACCEPTED,
    audience: NOTIFICATION_AUDIENCE.CUSTOMER,
    baseChannels: [],
    optionalChannels: ['SMS', 'MESSENGER'],
  },
  {
    code: CUSTOMER_NOTIFICATION_CODES.APPROVAL_REQUEST,
    audience: NOTIFICATION_AUDIENCE.CUSTOMER,
    baseChannels: [],
    optionalChannels: ['SMS', 'MESSENGER'],
  },
  {
    code: CUSTOMER_NOTIFICATION_CODES.PREPAYMENT_RECEIVED,
    audience: NOTIFICATION_AUDIENCE.CUSTOMER,
    baseChannels: [],
    optionalChannels: ['SMS', 'MESSENGER'],
  },
  {
    code: CUSTOMER_NOTIFICATION_CODES.READY_FOR_PICKUP,
    audience: NOTIFICATION_AUDIENCE.CUSTOMER,
    baseChannels: [],
    optionalChannels: ['SMS', 'MESSENGER'],
  },
  {
    code: CUSTOMER_NOTIFICATION_CODES.UNCLAIMED_REMINDER,
    audience: NOTIFICATION_AUDIENCE.CUSTOMER,
    baseChannels: [],
    optionalChannels: ['SMS', 'MESSENGER'],
  },
  {
    code: CUSTOMER_NOTIFICATION_CODES.WARRANTY_ISSUED,
    audience: NOTIFICATION_AUDIENCE.CUSTOMER,
    baseChannels: [],
    optionalChannels: ['SMS', 'MESSENGER'],
  },
  {
    code: STAFF_NOTIFICATION_CODES.ORDER_OVERDUE,
    audience: NOTIFICATION_AUDIENCE.STAFF,
    baseChannels: ['IN_APP', 'EMAIL'],
    optionalChannels: [],
  },
  {
    code: STAFF_NOTIFICATION_CODES.ESCALATION_MANAGER,
    audience: NOTIFICATION_AUDIENCE.STAFF,
    baseChannels: ['IN_APP', 'EMAIL'],
    optionalChannels: [],
  },
  {
    code: STAFF_NOTIFICATION_CODES.ORDER_UNCLAIMED,
    audience: NOTIFICATION_AUDIENCE.STAFF,
    baseChannels: ['IN_APP', 'EMAIL'],
    optionalChannels: [],
  },
  {
    code: STAFF_NOTIFICATION_CODES.CLAIM_DEADLINE,
    audience: NOTIFICATION_AUDIENCE.STAFF,
    baseChannels: ['IN_APP', 'EMAIL'],
    optionalChannels: [],
  },
  {
    code: STAFF_NOTIFICATION_CODES.BATCH_RECEIVED,
    audience: NOTIFICATION_AUDIENCE.STAFF,
    baseChannels: ['IN_APP', 'EMAIL'],
    optionalChannels: [],
  },
  {
    code: STAFF_NOTIFICATION_CODES.BATCH_TRANSIT_LATE,
    audience: NOTIFICATION_AUDIENCE.STAFF,
    baseChannels: ['IN_APP', 'EMAIL'],
    optionalChannels: [],
  },
];

/** Правило по коду события; `null`, если событие неизвестно. */
export function ruleForCode(code: string): NotificationChannelRule | null {
  return NOTIFICATION_CHANNEL_RULES.find((rule) => rule.code === code) ?? null;
}

/** Состояние внешних каналов, как его видит система. */
export interface ChannelAvailability {
  /** Включён ли канал настройкой (`notifications.sms.enabled`). */
  smsEnabled: boolean;
  messengerEnabled: boolean;
  /**
   * Известен ли телефон получателя.
   *
   * Без него SMS отправить некуда. Проверка здесь, а не в адаптере: адаптер не
   * должен решать, есть ли у клиента телефон, — он получает готовый номер.
   */
  hasPhone: boolean;
}

/**
 * Какие каналы нужны для события.
 *
 * Возвращает только те каналы, которые РЕАЛЬНО будут использованы. Решение
 * принимается один раз здесь, а не разбросано по вызывающему коду: иначе
 * «отправить, если включено» повторялось бы в каждом месте рассылки, и одно из
 * них однажды отправило бы SMS при выключенном канале.
 *
 * Внешний канал добавляется ТОЛЬКО при выполнении всех условий: он включён
 * настройкой, есть правило для события и известен адрес. Отсутствие телефона не
 * ошибка: клиент мог не оставить номер, и уведомление просто не создаётся.
 */
export function channelsFor(code: string, availability: ChannelAvailability): readonly string[] {
  const rule = ruleForCode(code);
  if (rule === null) return [];

  const channels: string[] = [...rule.baseChannels];

  for (const channel of rule.optionalChannels) {
    if (channel === 'SMS' && availability.smsEnabled && availability.hasPhone) {
      channels.push(channel);
      continue;
    }
    /*
     * Мессенджер требует и включения, и телефона: большинство провайдеров
     * адресуют сообщение по номеру, а не по внутреннему идентификатору чата.
     */
    if (channel === 'MESSENGER' && availability.messengerEnabled && availability.hasPhone) {
      channels.push(channel);
    }
  }

  return channels;
}

/**
 * Кому адресовано событие.
 *
 * Нужно, чтобы не перепутать формулировки: текст для клиента и текст для
 * сотрудника — разные шаблоны, и отправка клиентского текста сотруднику выглядела
 * бы как обращение не к тому человеку.
 */
export function audienceFor(code: string): NotificationAudience | null {
  return ruleForCode(code)?.audience ?? null;
}

/**
 * Какое событие соответствует какому ПЕРЕХОДУ заказа (задача 5.10).
 *
 * ПОЧЕМУ КЛЮЧ — ПЕРЕХОД, А НЕ ЦЕЛЕВОЙ СТАТУС. Первый вариант таблицы ключевался
 * статусом, и это оказалось НЕВЕРНО: статус `ACCEPTED` достигается двумя разными
 * переходами — из `DRAFT` («заказ принят») и из `AWAITING_PREPAYMENT» («предоплата
 * получена»). У них разные поводы для сообщения клиенту, но один целевой статус,
 * и таблица по статусу смогла бы выразить только один из них. Второй смысл молча
 * пропал бы: клиент либо не узнал бы, что заказ принят, либо получил бы «оплата
 * получена», ничего не заплатив.
 *
 * ЧТО ЗДЕСЬ ЗАПИСАНО. Только те события, которые можно утверждать достоверно:
 * «принят», «готов к выдаче», «выдан». Согласование и предоплата — события
 * ПЛАТЕЖА и РЕШЕНИЯ, они создаются там, где известны сумма и результат, а не в
 * переходе статуса.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Перевода в производство, в путь, между цехами — они
 * клиента не касаются, и сообщение на каждый шаг было бы навязчивым. Таблица
 * делает это решение явным; вывод «раз есть статус — есть и событие» заставлял бы
 * писать клиенту без повода.
 */
export const CUSTOMER_TRANSITION_NOTIFICATION: Readonly<Record<string, string>> = {
  // Заказ принят в работу: клиент должен знать, что изделие у нас.
  'DRAFT->ACCEPTED': CUSTOMER_NOTIFICATION_CODES.ORDER_ACCEPTED,
  // Изделие в магазине: самое важное для клиента событие — без него заказ лежит
  // и ждёт, пока клиент сам догадается позвонить.
  'IN_TRANSIT_TO_STORE->READY_FOR_PICKUP': CUSTOMER_NOTIFICATION_CODES.READY_FOR_PICKUP,
  // Заказ выдан: сообщается срок гарантии.
  'READY_FOR_PICKUP->COMPLETED': CUSTOMER_NOTIFICATION_CODES.WARRANTY_ISSUED,
  /*
   * `UNCLAIMED->COMPLETED` здесь СОЗНАТЕЛЬНО НЕТ, хотя заказ тоже выдаётся.
   * У этого перехода нет эффекта `NOTIFY_CUSTOMER` (docs/04 §2, строка 21), и
   * запись была бы мёртвой. Смысл и в том, что клиент в этот момент пришёл за
   * изделием сам: сообщать ему по SMS о выдаче, которая только что произошла на
   * его глазах, незачем.
   */
  // Заказ согласован и принят в работу.
  'AWAITING_APPROVAL->ACCEPTED': CUSTOMER_NOTIFICATION_CODES.ORDER_ACCEPTED,
};

/** Событие для перехода; `null`, если клиента уведомлять не нужно. */
export function customerEventForTransition(from: string, to: string): string | null {
  return CUSTOMER_TRANSITION_NOTIFICATION[`${from}->${to}`] ?? null;
}

/**
 * Переходы, у которых есть событие для клиента.
 *
 * Нужно проверке согласованности: таблица событий и таблица переходов живут в
 * разных файлах, и запись о событии для перехода БЕЗ эффекта `NOTIFY_CUSTOMER`
 * была бы мёртвой. Уведомление не создавалось бы никогда, хотя текст шаблона
 * существует и выглядит рабочим, - именно так и пропало событие "заказ принят".
 */
export function transitionKeysWithCustomerEvent(): readonly string[] {
  return Object.keys(CUSTOMER_TRANSITION_NOTIFICATION);
}

/**
 * Влезает ли текст в одно SMS.
 *
 * Проверка нужна при синхронизации шаблонов: длинный текст не сломает отправку,
 * но будет тарифицирован как несколько сообщений. Заметить это можно только по
 * счёту от провайдера, то есть слишком поздно.
 */
export function fitsSingleSms(text: string): boolean {
  return text.length <= SMS_SINGLE_LENGTH;
}
