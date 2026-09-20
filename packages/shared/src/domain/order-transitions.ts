/**
 * Таблица переходов статусов заказа с ролями и guard-условиями.
 * Реализует docs/04-status-workflow.md §2. Тесты обязаны покрывать каждый переход.
 *
 * ВАЖНО: это единственное место, где описаны разрешённые переходы. Ни контроллер,
 * ни фронтенд не дублируют эту логику.
 */

import { ORDER_STATUS, type OrderStatus, isTerminalStatus } from './order-status.js';
import { ROLE, type RoleCode } from './roles.js';

/** Кто может выполнить переход: конкретные роли или система (планировщик). */
export type TransitionActor = RoleCode | 'SYSTEM';

/**
 * Guard-условия, проверяемые доменным сервисом перед переходом.
 * Каждое условие соответствует коду ошибки в API (docs/07-api-spec.md §16).
 */
export const GUARD = {
  /** Есть отметка о согласии клиента на запись разговоров (ТЗ п. 2.4). */
  CONSENT_CALL_RECORDING: 'CONSENT_CALL_RECORDING',
  /** В заказе минимум одно изделие. */
  HAS_ITEMS: 'HAS_ITEMS',
  /** Калькуляция не пуста (есть хотя бы одна строка работы). */
  CALC_NOT_EMPTY: 'CALC_NOT_EMPTY',
  /** Предоплата внесена в достаточном объёме (ТЗ п. 2.5). */
  PREPAYMENT_SATISFIED: 'PREPAYMENT_SATISFIED',
  /** Предоплата для этого заказа не требуется. */
  PREPAYMENT_NOT_REQUIRED: 'PREPAYMENT_NOT_REQUIRED',
  /** Есть согласование клиента по сумме и сроку (ТЗ п. 2.4). */
  APPROVAL_EXISTS: 'APPROVAL_EXISTS',
  /**
   * Согласование покрывает ТЕКУЩУЮ сумму заказа (требование заказчика).
   *
   * Отличается от `APPROVAL_EXISTS` принципиально: тот проверяет наличие
   * записи, этот — совпадение сумм. После правки состава работ итог меняется,
   * и запись остаётся, а согласие клиента относится уже к другой сумме.
   */
  APPROVAL_COVERS_TOTAL: 'APPROVAL_COVERS_TOTAL',
  /** Заказ оплачен полностью (ТЗ п. 2.8). */
  PAID_IN_FULL: 'PAID_IN_FULL',
  /** Есть подпись клиента о получении. */
  PICKUP_SIGNATURE: 'PICKUP_SIGNATURE',
  /** Оформлен акт отказа от оплаты (ТЗ п. 2.8). */
  REFUSAL_ACT_EXISTS: 'REFUSAL_ACT_EXISTS',
  /** Заказ привязан к партии. */
  BATCH_ASSIGNED: 'BATCH_ASSIGNED',
  /** Акт приёма-передачи партии сформирован. */
  BATCH_ACT_FORMED: 'BATCH_ACT_FORMED',
  /** Назначен исполнитель производства. */
  PERFORMER_ASSIGNED: 'PERFORMER_ASSIGNED',
  /** Работы завершены. */
  WORK_FINISHED: 'WORK_FINISHED',
  /** Партия фактически принята цехом. */
  BATCH_RECEIVED_BY_WORKSHOP: 'BATCH_RECEIVED_BY_WORKSHOP',
  /** Партия принята магазином. */
  BATCH_RECEIVED_BY_STORE: 'BATCH_RECEIVED_BY_STORE',
  /** Есть основание для доработки: рекламация или внутренний брак. */
  REWORK_REASON: 'REWORK_REASON',
  /** Готовый заказ не получен клиентом более 30 дней (ТЗ п. 2.8). */
  UNCLAIMED_THRESHOLD: 'UNCLAIMED_THRESHOLD',
  /** Обязательное поле «причина» заполнено. */
  REASON_REQUIRED: 'REASON_REQUIRED',
  /** Работы ещё не начаты (для отмены). */
  WORK_NOT_STARTED: 'WORK_NOT_STARTED',
} as const;

export type GuardCode = (typeof GUARD)[keyof typeof GUARD];

/** Побочные эффекты перехода — выполняются в одной транзакции с изменением статуса. */
export const EFFECT = {
  GENERATE_ORDER_NO: 'GENERATE_ORDER_NO',
  RECALC_TOTALS: 'RECALC_TOTALS',
  SET_DUE_AT: 'SET_DUE_AT',
  SET_ACCEPTED_AT: 'SET_ACCEPTED_AT',
  SET_APPROVED_AT: 'SET_APPROVED_AT',
  SET_PREPAYMENT_CONFIRMED_AT: 'SET_PREPAYMENT_CONFIRMED_AT',
  SET_PRODUCTION_STARTED_AT: 'SET_PRODUCTION_STARTED_AT',
  SET_PRODUCTION_FINISHED_AT: 'SET_PRODUCTION_FINISHED_AT',
  /**
   * Пометить заказ как возвращённый в магазин БЕЗ работ (дефект 67).
   *
   * Отметка нужна приёмке обратной партии: по ней заказ закрывается статусом
   * «Отказ до начала работ», а не «Готов к выдаче». Без неё отказ клиента,
   * оформленный в цехе, терялся бы по дороге.
   */
  MARK_RETURNED_WITHOUT_WORK: 'MARK_RETURNED_WITHOUT_WORK',
  SET_READY_AT: 'SET_READY_AT',
  SET_COMPLETED_AT: 'SET_COMPLETED_AT',
  COMPUTE_WARRANTY: 'COMPUTE_WARRANTY',
  RESET_PERFORMER: 'RESET_PERFORMER',
  NOTIFY_NEXT_RESPIBLE: 'NOTIFY_NEXT_RESPIBLE',
  NOTIFY_CUSTOMER: 'NOTIFY_CUSTOMER',
  NOTIFY_RECEIVER: 'NOTIFY_RECEIVER',
  CLEAR_ESCALATION: 'CLEAR_ESCALATION',
} as const;

export type EffectCode = (typeof EFFECT)[keyof typeof EFFECT];

export interface TransitionRule {
  /** Стабильный идентификатор правила — совпадает с номером в docs/04-status-workflow.md §2. */
  id: number;
  from: OrderStatus | null; // null = создание заказа
  to: OrderStatus;
  actors: readonly TransitionActor[];
  guards: readonly GuardCode[];
  effects: readonly EffectCode[];
  /** Требуется ли обоснование (пишется в AuditLog.reason). */
  requiresReason: boolean;
  /** Подпись действия для UI. */
  label: string;
}

/**
 * Полная таблица переходов. Порядок соответствует docs/04-status-workflow.md §2.
 * Изменение этой таблицы требует обновления документации — это проверяется тестом.
 */
export const ORDER_TRANSITIONS: readonly TransitionRule[] = [
  {
    id: 1,
    from: null,
    to: ORDER_STATUS.DRAFT,
    actors: [ROLE.RECEIVER, ROLE.ADMIN],
    guards: [GUARD.CONSENT_CALL_RECORDING, GUARD.HAS_ITEMS],
    effects: [EFFECT.GENERATE_ORDER_NO],
    requiresReason: false,
    label: 'Создать заказ',
  },
  {
    id: 2,
    from: ORDER_STATUS.DRAFT,
    to: ORDER_STATUS.AWAITING_APPROVAL,
    actors: [ROLE.RECEIVER, ROLE.ADMIN],
    guards: [GUARD.CONSENT_CALL_RECORDING, GUARD.CALC_NOT_EMPTY],
    effects: [EFFECT.RECALC_TOTALS, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Отправить на согласование',
  },
  {
    id: 3,
    from: ORDER_STATUS.DRAFT,
    to: ORDER_STATUS.ACCEPTED,
    actors: [ROLE.RECEIVER, ROLE.ADMIN],
    guards: [GUARD.CALC_NOT_EMPTY, GUARD.PREPAYMENT_NOT_REQUIRED],
    // Без SET_DUE_AT: ACCEPTED — это этап INTAKE, норматива срока у него нет
    // (docs/04 §2 в эффектах перехода dueAt не указывает). Срок появится на
    // следующем этапе. Объявлять здесь SET_DUE_AT значило бы обещать, что срок
    // будет назначен, тогда как назначать его нечем, — и расчёт молча оставлял
    // бы поле пустым, что уже случалось.
    /*
     * `NOTIFY_CUSTOMER` — docs/05 §3 обещает клиенту событие «Заказ принят»
     * (`ORDER_ACCEPTED`). Раньше эффекта здесь не было, и обещанное уведомление
     * не создавалось ничем: шаблон существовал, а события не возникало.
     */
    effects: [EFFECT.RECALC_TOTALS, EFFECT.SET_ACCEPTED_AT, EFFECT.NOTIFY_CUSTOMER],
    requiresReason: false,
    label: 'Принять в работу',
  },
  {
    id: 4,
    from: ORDER_STATUS.AWAITING_APPROVAL,
    to: ORDER_STATUS.AWAITING_PREPAYMENT,
    actors: [ROLE.RECEIVER, ROLE.CASHIER, ROLE.ADMIN],
    guards: [GUARD.APPROVAL_EXISTS],
    effects: [EFFECT.SET_APPROVED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Согласовано, ждём предоплату',
  },
  {
    id: 5,
    from: ORDER_STATUS.AWAITING_APPROVAL,
    to: ORDER_STATUS.ACCEPTED,
    actors: [ROLE.RECEIVER, ROLE.ADMIN],
    guards: [GUARD.APPROVAL_EXISTS, GUARD.PREPAYMENT_NOT_REQUIRED],
    // Без SET_DUE_AT: ACCEPTED — этап INTAKE, норматива срока у него нет
    // (docs/04 §2). Срок назначит переход в QUEUED_FOR_DISPATCH.
    // Уведомление клиенту по той же причине: заказ согласован и принят в работу.
    effects: [EFFECT.SET_APPROVED_AT, EFFECT.SET_ACCEPTED_AT, EFFECT.NOTIFY_CUSTOMER],
    requiresReason: false,
    label: 'Согласовано, принят в работу',
  },
  {
    id: 6,
    from: ORDER_STATUS.AWAITING_APPROVAL,
    to: ORDER_STATUS.CANCELLED,
    actors: [ROLE.RECEIVER, ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REASON_REQUIRED],
    effects: [],
    requiresReason: true,
    label: 'Отменить (клиент отказался)',
  },
  {
    id: 7,
    // Система переводит автоматически при поступлении предоплаты; кассир/админ — вручную.
    from: ORDER_STATUS.AWAITING_PREPAYMENT,
    to: ORDER_STATUS.ACCEPTED,
    actors: ['SYSTEM', ROLE.CASHIER, ROLE.ADMIN],
    guards: [GUARD.PREPAYMENT_SATISFIED],
    // Без SET_DUE_AT по той же причине: ACCEPTED — этап INTAKE.
    effects: [EFFECT.SET_PREPAYMENT_CONFIRMED_AT, EFFECT.NOTIFY_NEXT_RESPIBLE],
    requiresReason: false,
    label: 'Предоплата внесена, работы разблокированы',
  },
  {
    id: 8,
    from: ORDER_STATUS.AWAITING_PREPAYMENT,
    to: ORDER_STATUS.CANCELLED,
    actors: [ROLE.RECEIVER, ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REASON_REQUIRED],
    effects: [],
    requiresReason: true,
    label: 'Отменить (предоплата не внесена)',
  },
  {
    id: 9,
    from: ORDER_STATUS.ACCEPTED,
    to: ORDER_STATUS.QUEUED_FOR_DISPATCH,
    actors: [ROLE.PRODUCTION_MANAGER, ROLE.LOGISTICIAN, 'SYSTEM'],
    guards: [GUARD.PREPAYMENT_SATISFIED],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'В очередь на отправку',
  },
  {
    id: 10,
    from: ORDER_STATUS.ACCEPTED,
    to: ORDER_STATUS.CANCELLED,
    actors: [ROLE.RECEIVER, ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REASON_REQUIRED, GUARD.WORK_NOT_STARTED],
    effects: [],
    requiresReason: true,
    label: 'Отменить до начала работ',
  },
  {
    id: 11,
    from: ORDER_STATUS.QUEUED_FOR_DISPATCH,
    to: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
    actors: [ROLE.PRODUCTION_MANAGER, ROLE.LOGISTICIAN],
    guards: [GUARD.BATCH_ASSIGNED, GUARD.BATCH_ACT_FORMED],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Отправить в цех',
  },
  {
    id: 12,
    from: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
    to: ORDER_STATUS.IN_PRODUCTION,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.BATCH_RECEIVED_BY_WORKSHOP],
    effects: [EFFECT.SET_PRODUCTION_STARTED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Принят цехом',
  },
  {
    /*
     * Приём партии цехом ПОСЛЕ введения статусов производства (задача 7.3,
     * переход 12a в docs/04-status-workflow.md §2.1).
     *
     * Переход 12 сохранён: заказы, принятые цехом до этой правки, остаются в
     * `IN_PRODUCTION`, и лишить их пути дальше нельзя. Новые партии приходят
     * сюда — в «Принят цехом», откуда менеджер распределяет работу.
     *
     * Номер 28: номера 23–27 заняты переходами распределения работы и возврата
     * (задание §7.3), а этот переход в задании помечен как «12a» — дробный
     * номер, который нельзя записать в числовой идентификатор.
     */
    id: 28,
    from: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
    to: ORDER_STATUS.ACCEPTED_BY_WORKSHOP,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.BATCH_RECEIVED_BY_WORKSHOP],
    effects: [EFFECT.SET_PRODUCTION_STARTED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Принят цехом',
  },
  {
    id: 13,
    from: ORDER_STATUS.IN_PRODUCTION,
    to: ORDER_STATUS.QUEUED_FOR_DISPATCH,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.REASON_REQUIRED],
    effects: [EFFECT.RESET_PERFORMER, EFFECT.SET_DUE_AT],
    requiresReason: true,
    label: 'Вернуть в очередь (перераспределение)',
  },
  {
    id: 14,
    from: ORDER_STATUS.IN_PRODUCTION,
    to: ORDER_STATUS.IN_TRANSIT_TO_STORE,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.PERFORMER_ASSIGNED, GUARD.WORK_FINISHED],
    effects: [EFFECT.SET_PRODUCTION_FINISHED_AT, EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Работы завершены, отправить в магазин',
  },
  {
    id: 15,
    from: ORDER_STATUS.IN_PRODUCTION,
    to: ORDER_STATUS.REWORK,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.REWORK_REASON, GUARD.REASON_REQUIRED],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: true,
    label: 'На доработку',
  },
  {
    id: 16,
    from: ORDER_STATUS.REWORK,
    to: ORDER_STATUS.IN_PRODUCTION,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.PERFORMER_ASSIGNED],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Вернуть в производство',
  },
  {
    id: 17,
    from: ORDER_STATUS.IN_TRANSIT_TO_STORE,
    to: ORDER_STATUS.READY_FOR_PICKUP,
    actors: [ROLE.RECEIVER, ROLE.LOGISTICIAN],
    guards: [GUARD.BATCH_RECEIVED_BY_STORE],
    effects: [EFFECT.SET_READY_AT, EFFECT.SET_DUE_AT, EFFECT.NOTIFY_CUSTOMER],
    requiresReason: false,
    label: 'Готов к выдаче',
  },
  {
    id: 18,
    from: ORDER_STATUS.READY_FOR_PICKUP,
    to: ORDER_STATUS.COMPLETED,
    actors: [ROLE.RECEIVER, ROLE.CASHIER, ROLE.ADMIN],
    guards: [GUARD.PAID_IN_FULL, GUARD.PICKUP_SIGNATURE],
    effects: [
      EFFECT.SET_COMPLETED_AT,
      EFFECT.COMPUTE_WARRANTY,
      EFFECT.CLEAR_ESCALATION,
      EFFECT.NOTIFY_CUSTOMER,
    ],
    requiresReason: false,
    label: 'Выдать клиенту',
  },
  {
    id: 19,
    from: ORDER_STATUS.READY_FOR_PICKUP,
    to: ORDER_STATUS.UNCLAIMED,
    actors: ['SYSTEM'],
    guards: [GUARD.UNCLAIMED_THRESHOLD],
    effects: [EFFECT.NOTIFY_RECEIVER],
    requiresReason: false,
    label: 'Невостребовано (30 дней)',
  },
  {
    id: 20,
    from: ORDER_STATUS.READY_FOR_PICKUP,
    to: ORDER_STATUS.REFUSED,
    actors: [ROLE.RECEIVER, ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REFUSAL_ACT_EXISTS, GUARD.REASON_REQUIRED],
    effects: [EFFECT.CLEAR_ESCALATION],
    requiresReason: true,
    label: 'Отказ от оплаты (акт)',
  },
  {
    id: 21,
    from: ORDER_STATUS.UNCLAIMED,
    to: ORDER_STATUS.COMPLETED,
    actors: [ROLE.RECEIVER, ROLE.CASHIER, ROLE.ADMIN],
    guards: [GUARD.PAID_IN_FULL, GUARD.PICKUP_SIGNATURE],
    effects: [EFFECT.SET_COMPLETED_AT, EFFECT.COMPUTE_WARRANTY, EFFECT.CLEAR_ESCALATION],
    requiresReason: false,
    label: 'Выдать клиенту (невостребованный)',
  },
  {
    id: 22,
    from: ORDER_STATUS.UNCLAIMED,
    to: ORDER_STATUS.REFUSED,
    actors: [ROLE.MANAGER, ROLE.ADMIN],
    guards: [GUARD.REFUSAL_ACT_EXISTS, GUARD.REASON_REQUIRED],
    effects: [EFFECT.CLEAR_ESCALATION],
    requiresReason: true,
    label: 'Отказ от оплаты (акт, невостребованный)',
  },
  {
    /*
     * Распределение работы: исполнитель назначен, изделие выдано ювелиру.
     *
     * Guard `PERFORMER_ASSIGNED` проверяет запись `OrderAssignment` со статусом
     * `ASSIGNED`/`IN_PROGRESS`. До задачи 7.2 такие записи не создавались ничем,
     * поэтому переход был бы недостижим — сейчас его создаёт маршрут назначения.
     */
    id: 23,
    from: ORDER_STATUS.ACCEPTED_BY_WORKSHOP,
    to: ORDER_STATUS.IN_WORK,
    actors: [ROLE.PRODUCTION_MANAGER],
    /*
     * `APPROVAL_COVERS_TOTAL` — требование заказчика: без согласования на
     * ТЕКУЩУЮ сумму заказ в работу не передаётся. Guard стоит именно здесь,
     * потому что этот переход и есть «передал исполнителю»: до него изделие
     * едет и лежит в цехе, но работы по нему ещё не начаты.
     *
     * Одного `APPROVAL_EXISTS` мало: он смотрит лишь наличие записи. Если
     * работы дополнили после согласования, запись осталась, а согласованная
     * сумма — прежняя, и заказ ушёл бы в работу с несогласованным итогом.
     */
    guards: [GUARD.PERFORMER_ASSIGNED, GUARD.APPROVAL_COVERS_TOTAL],
    /*
     * Эффектов нет намеренно: запись об исполнителе в историю делает сервис
     * назначения (задача 7.2) — она содержит ФИО и плановые часы, которых в
     * таблице переходов нет. Эффект здесь дублировал бы эту запись.
     */
    effects: [],
    requiresReason: false,
    label: 'Выдано в работу',
  },
  {
    /* Работа выполнена и принята менеджером: изделие готово к возврату. */
    id: 24,
    from: ORDER_STATUS.IN_WORK,
    to: ORDER_STATUS.WORK_COMPLETED,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.WORK_FINISHED],
    effects: [EFFECT.SET_PRODUCTION_FINISHED_AT],
    requiresReason: false,
    label: 'Работы завершены',
  },
  {
    /*
     * Отправка готового изделия в магазин. Без `PERFORMER_ASSIGNED`: работа уже
     * принята на переходе 25, и повторное требование исполнителя блокировало бы
     * отправку, если назначение успели закрыть.
     */
    id: 25,
    from: ORDER_STATUS.WORK_COMPLETED,
    to: ORDER_STATUS.IN_TRANSIT_TO_STORE,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [],
    effects: [EFFECT.SET_DUE_AT],
    requiresReason: false,
    label: 'Отправить в магазин',
  },
  {
    /*
     * Возврат БЕЗ РАБОТ: клиент отказался на этапе согласования, изделие ещё не
     * отдавали в работу (решение заказчика, docs/00-decisions.md §7.2).
     *
     * Отдельный статус отказа не вводится: изделие возвращается обычной партией
     * «в магазин», принимает его магазин, и уже там заказ переводится в
     * `CANCELLED`. Причина обязательна — по ней в истории видно, что отказ
     * клиента произошёл до начала работ.
     */
    id: 26,
    from: ORDER_STATUS.ACCEPTED_BY_WORKSHOP,
    to: ORDER_STATUS.IN_TRANSIT_TO_STORE,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.REASON_REQUIRED],
    effects: [EFFECT.SET_DUE_AT, EFFECT.MARK_RETURNED_WITHOUT_WORK],
    requiresReason: true,
    label: 'Вернуть в магазин без работ',
  },
  {
    /*
     * Возврат без работ, когда работа уже начата: ювелир остановлен, изделие
     * едет в магазин. Причина обязательна — по ней видно, что работа была
     * прервана, а не завершена.
     */
    id: 27,
    from: ORDER_STATUS.IN_WORK,
    to: ORDER_STATUS.IN_TRANSIT_TO_STORE,
    actors: [ROLE.PRODUCTION_MANAGER],
    guards: [GUARD.REASON_REQUIRED],
    effects: [
      EFFECT.SET_PRODUCTION_FINISHED_AT,
      EFFECT.SET_DUE_AT,
      EFFECT.MARK_RETURNED_WITHOUT_WORK,
    ],
    requiresReason: true,
    label: 'Вернуть в магазин без работ (работа прервана)',
  },
  {
    /*
     * Отказ до начала работ (дефект 67). Приёмка обратной партии закрывает
     * заказ, если он вернулся из цеха БЕЗ работ.
     *
     * Раньше такой заказ переводился в `READY_FOR_PICKUP`, откуда отмена
     * недостижима (переход 10 разрешён только из `ACCEPTED`): заказ «Готов к
     * выдаче» нельзя было ни выдать (клиент отказался, работы не выполнены), ни
     * закрыть — сценарий отказа упирался в тупик.
     */
    id: 29,
    from: ORDER_STATUS.IN_TRANSIT_TO_STORE,
    to: ORDER_STATUS.REFUSED_BEFORE_WORK,
    actors: [ROLE.RECEIVER, ROLE.LOGISTICIAN],
    guards: [GUARD.BATCH_RECEIVED_BY_STORE],
    effects: [EFFECT.CLEAR_ESCALATION],
    requiresReason: false,
    label: 'Отказ до начала работ',
  },
];

/** Результат проверки допустимости перехода. */
export type TransitionCheck =
  | { allowed: true; rule: TransitionRule }
  | { allowed: false; code: TransitionDenialCode; message: string };

export type TransitionDenialCode =
  'INVALID_TRANSITION' | 'TERMINAL_STATE' | 'FORBIDDEN_ROLE' | 'REASON_REQUIRED';

/** Найти правило перехода. Возвращает undefined, если переход не разрешён. */
export function findTransition(
  from: OrderStatus | null,
  to: OrderStatus,
): TransitionRule | undefined {
  return ORDER_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/**
 * Проверка перехода по статусу, роли и наличию причины.
 * Проверка guard-условий выполняется отдельно — они требуют данных из БД.
 *
 * ## Почему `actorRoles`, а не одна `actorRole`
 *
 * Мультироль в системе поддержана: у сотрудника может быть несколько ролей
 * (`UserRole[]`), и права объединяются. Но переходы сверялись только с
 * `primaryRole` — ролью, которая в наборе первая. Приёмщик, которому выдали
 * ВТОРУЮ роль логиста (решение заказчика: «где приняли, там и выдаём»), не мог
 * отправить партию в цех: `primaryRole` остаётся `RECEIVER`, а правило 11
 * допускает `PRODUCTION_MANAGER`/`LOGISTICIAN`. Проверено на домене: переход
 * давал `FORBIDDEN_ROLE`, хотя право `logistics:manage` у сотрудника есть —
 * то есть роли расходились с правами, и выданная роль не давала ничего.
 *
 * `actorRole` оставлен для обратной совместимости и системных переходов
 * (`'SYSTEM'`): если `actorRoles` не задан, проверяется только он.
 */
export function checkTransition(params: {
  from: OrderStatus | null;
  to: OrderStatus;
  actorRole: TransitionActor;
  /** Полный набор ролей сотрудника. Если задан, `actorRole` — только запасной. */
  actorRoles?: readonly TransitionActor[];
  reason?: string | null;
}): TransitionCheck {
  const { from, to, actorRole, reason } = params;
  const roles = params.actorRoles ?? [actorRole];

  if (from !== null && isTerminalStatus(from)) {
    return {
      allowed: false,
      code: 'TERMINAL_STATE',
      message: 'Заказ закрыт, изменение статуса невозможно',
    };
  }

  const rule = findTransition(from, to);
  if (!rule) {
    return {
      allowed: false,
      code: 'INVALID_TRANSITION',
      message: `Переход ${from ?? 'создание'} → ${to} не предусмотрен`,
    };
  }

  /*
   * Роль администратора открывает любой переход — проверяется по всему набору:
   * администратор с дополнительной ролью не должен получать меньше прав, чем
   * администратор с одной.
   */
  const isAllowedActor =
    rulesAllow(rule, roles) || roles.includes(ROLE.ADMIN) || actorRole === ROLE.ADMIN;
  if (!isAllowedActor) {
    return {
      allowed: false,
      code: 'FORBIDDEN_ROLE',
      message: 'Недостаточно прав для этого действия',
    };
  }

  if (rule.requiresReason && (!reason || reason.trim().length < 3)) {
    return {
      allowed: false,
      code: 'REASON_REQUIRED',
      message: 'Необходимо указать причину (минимум 3 символа)',
    };
  }

  return { allowed: true, rule };
}

/**
 * Допускает ли правило хотя бы одну из ролей сотрудника.
 *
 * Отдельная функция, потому что то же условие нужно `availableTransitions`:
 * список доступных действий и фактический переход ОБЯЗАНЫ отвечать одинаково.
 * Расхождение дало бы кнопку, которая видна, но не работает, — а это худший вид
 * дефекта прав: пользователь считает, что действует неправильно он, а не код.
 */
function rulesAllow(rule: TransitionRule, roles: readonly TransitionActor[]): boolean {
  return roles.some((role) => rule.actors.includes(role));
}

/** Все переходы, доступные из текущего статуса указанной роли (для UI). */
export function availableTransitions(
  from: OrderStatus | null,
  actorRole: TransitionActor,
  /** Полный набор ролей сотрудника. Если задан, `actorRole` — только запасной. */
  actorRoles?: readonly TransitionActor[],
): readonly TransitionRule[] {
  if (from !== null && isTerminalStatus(from)) return [];
  const roles = actorRoles ?? [actorRole];
  return ORDER_TRANSITIONS.filter(
    (t) => t.from === from && (rulesAllow(t, roles) || roles.includes(ROLE.ADMIN)),
  );
}
