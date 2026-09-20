/**
 * Домен партий: правила включения заказов и направления перевозки.
 *
 * Документация: docs/02-domain-and-roles.md, docs/04-status-workflow.md,
 * ТЗ п. 2.6 («формирование партий по графику»).
 *
 * ЗАЧЕМ ПРАВИЛА ЗДЕСЬ, А НЕ В СЕРВИСЕ. Те же вопросы задаёт интерфейс, чтобы
 * показать, какие заказы можно включить в партию, и подсветить лишние. Если
 * правило живёт в сервисе, интерфейс повторяет его своими средствами — а две
 * реализации одного правила расходятся (это уже случалось в проекте: словари
 * этапов разошлись на три варианта, см. docs/15 «Дефект 26»). Поэтому правило
 * одно: функция в домене, вызываемая и сервисом, и интерфейсом.
 */

import { ORDER_STATUS, type OrderStatus } from './order-status.js';

/**
 * Направление партии: в цех или из цеха в магазин.
 *
 * Значения совпадают с `enum BatchDirection` в схеме БД.
 */
export const BATCH_DIRECTION = {
  TO_PRODUCTION: 'TO_PRODUCTION',
  TO_STORE: 'TO_STORE',
} as const;

export type BatchDirection = (typeof BATCH_DIRECTION)[keyof typeof BATCH_DIRECTION];

/** Статусы партии. Значения совпадают с `enum BatchStatus` в схеме БД. */
export const BATCH_STATUS = {
  DRAFT: 'DRAFT',
  ACT_FORMED: 'ACT_FORMED',
  IN_TRANSIT: 'IN_TRANSIT',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const;

export type BatchStatus = (typeof BATCH_STATUS)[keyof typeof BATCH_STATUS];

/**
 * Заказ в том состоянии, в каком его видит правило включения в партию.
 *
 * Тип структурный: сервис передаёт сущность Prisma, интерфейс — список заказов,
 * и оба обязаны получить один и тот же ответ.
 */
export interface BatchCandidateOrder {
  id: string;
  orderNo?: string;
  status: OrderStatus;
  createdStoreId: string;
  pickupStoreId: string;
  workshopId: string | null;
}

/** Почему заказ нельзя включить в партию. Код — для интерфейса, текст — для человека. */
export interface BatchEligibility {
  eligible: boolean;
  /** Машиночитаемая причина отказа; `null`, если заказ подходит. */
  reason: BatchIneligibilityReason | null;
  /** Текст для приёмщика. */
  message: string | null;
  /**
   * Замечание, которое НЕ мешает включить заказ.
   *
   * Контроль «где приняли, там и выдаём» — зона ответственности менеджера
   * (решение заказчика, docs/00-decisions.md §7.4), поэтому расхождение
   * магазинов показывается, но не блокирует: заказ может ехать в другой
   * магазин осознанно — например, клиент попросил выдать изделие в другой
   * точке.
   */
  warning: string | null;
}

export const BATCH_INELIGIBILITY = {
  WRONG_STATUS: 'WRONG_STATUS',
  ALREADY_IN_BATCH: 'ALREADY_IN_BATCH',
  /** Заказ принят в другом магазине (направление «в цех»). */
  WRONG_STORE: 'WRONG_STORE',
  NO_WORKSHOP: 'NO_WORKSHOP',
  WRONG_WORKSHOP: 'WRONG_WORKSHOP',
  /**
   * Заказ выдаётся не в том магазине, куда едет партия.
   *
   * Заменяет прежний `SAME_STORE`, который сравнивал получателя с магазином
   * ПРИЁМА и тем самым запрещал ровно то, что требуется: доставить изделие
   * туда, где его принимали. Подробности — дефект 62 в docs/15-known-issues.md.
   */
  WRONG_DELIVERY_STORE: 'WRONG_DELIVERY_STORE',
} as const;

export type BatchIneligibilityReason =
  (typeof BATCH_INELIGIBILITY)[keyof typeof BATCH_INELIGIBILITY];

/**
 * Статус заказа, при котором он может ехать в цех.
 *
 * `QUEUED_FOR_DISPATCH` — «в очереди на отправку»: предоплата снята или не
 * требовалась, заказ ждёт партию (docs/04 §2, переход 11).
 */
export function isReadyForDispatch(status: OrderStatus): boolean {
  return status === ORDER_STATUS.QUEUED_FOR_DISPATCH;
}

/**
 * Статус заказа, при котором он может ехать из цеха в магазин.
 *
 * `IN_TRANSIT_TO_STORE` выставляет цех, когда работы завершены (переход 14);
 * до этого момента везти нечего. `READY_FOR_PICKUP` уже не в партии: изделие
 * физически в магазине (переход 17).
 */
export function isReadyForStoreDelivery(status: OrderStatus): boolean {
  return status === ORDER_STATUS.IN_TRANSIT_TO_STORE;
}

/**
 * Проверить, можно ли включить заказ в партию.
 *
 * @param order        заказ
 * @param direction    направление партии
 * @param fromStoreId  магазин отправления (для «в цех» — точка сбора)
 * @param toStoreId    магазин-получатель (для «в магазин»)
 * @param toWorkshopId цех-получатель (для «в цех»)
 * @param alreadyInIds идентификаторы заказов, уже лежащих в активных партиях
 */
export function checkBatchEligibility(params: {
  order: BatchCandidateOrder;
  direction: BatchDirection;
  fromStoreId?: string | null;
  toStoreId?: string | null;
  toWorkshopId?: string | null;
  alreadyInIds?: ReadonlySet<string>;
}): BatchEligibility {
  const { order, direction, fromStoreId, toStoreId, toWorkshopId, alreadyInIds } = params;

  const reject = (reason: BatchIneligibilityReason, message: string): BatchEligibility => ({
    eligible: false,
    reason,
    message,
    warning: null,
  });

  const accept = (warning: string | null = null): BatchEligibility => ({
    eligible: true,
    reason: null,
    message: null,
    warning,
  });

  /*
   * Заказ может лежать только в одной активной партии. Без этой проверки один
   * и тот же заказ попал бы в две партии, и его статус перевели бы дважды:
   * «в пути» сменилось бы на «принят» при разгрузке первой партии, а вторая
   * продолжила бы считаться в пути.
   */
  if (alreadyInIds?.has(order.id) === true) {
    return reject(
      BATCH_INELIGIBILITY.ALREADY_IN_BATCH,
      'Заказ уже находится в другой активной партии',
    );
  }

  if (direction === BATCH_DIRECTION.TO_PRODUCTION) {
    if (!isReadyForDispatch(order.status)) {
      return reject(
        BATCH_INELIGIBILITY.WRONG_STATUS,
        'В цех можно отправить только заказ в статусе «В очереди на отправку»',
      );
    }
    /*
     * Партия собирается одним магазином: машина забирает изделия с одной точки.
     * Заказ, принятый в другом магазине, физически лежит там и в эту партию
     * попасть не может — иначе акт приёма-передачи подписывался бы на изделие,
     * которого у отправителя нет.
     */
    if (fromStoreId != null && order.createdStoreId !== fromStoreId) {
      return reject(BATCH_INELIGIBILITY.WRONG_STORE, 'Заказ принят в другом магазине');
    }
    /*
     * Цех у заказа может быть уже назначен (например, руководитель производства
     * распределил работу). Партия, идущая в другой цех, не должна его забрать.
     */
    if (toWorkshopId != null && order.workshopId != null && order.workshopId !== toWorkshopId) {
      return reject(BATCH_INELIGIBILITY.WRONG_WORKSHOP, 'Заказ закреплён за другим цехом');
    }
    return accept();
  }

  /*
   * Направление TO_STORE: возврат изделия из цеха в магазин.
   *
   * Получатель — `toStoreId`. Прежняя реализация сравнивала получателя с
   * магазином ПРИЁМА (`fromStoreId`) и отклоняла совпадение как «заказ уже
   * числится в этом магазине»: изделие, которое принимали в MSK1, нельзя было
   * вернуть в MSK1. Вместе с фильтром `candidates()` по `createdStoreId`
   * это делало сборку обратной партии невозможной (дефект 62).
   */
  if (!isReadyForStoreDelivery(order.status)) {
    return reject(
      BATCH_INELIGIBILITY.WRONG_STATUS,
      'В магазин можно отправить только заказ в статусе «В пути в магазин»',
    );
  }
  /*
   * Партия едет в ОДИН магазин: все изделия в ней должны выдаваться там же.
   * Иначе машина привезёт изделие в точку, где его не ждут, и его придётся
   * везти дальше. Это запрет, а не замечание: расхождение означает, что
   * изделие физически доставят не туда.
   */
  if (toStoreId != null && order.pickupStoreId !== toStoreId) {
    return reject(
      BATCH_INELIGIBILITY.WRONG_DELIVERY_STORE,
      'Заказ выдают в другом магазине — выберите партию на магазин выдачи',
    );
  }
  /*
   * Магазин ПРИЁМА может отличаться от магазина выдачи: контроль «где приняли,
   * там и выдаём» — зона ответственности менеджера (решение заказчика,
   * docs/00-decisions.md §7.4), поэтому здесь только замечание. Осознанная
   * выдача в другой точке — законный сценарий, и запрет заставил бы менеджера
   * искать обходной путь.
   */
  if (toStoreId != null && order.createdStoreId !== toStoreId) {
    return accept('Заказ принят в другом магазине — выдача будет в магазине, куда едет партия');
  }
  return accept();
}

/**
 * Отобрать заказы, подходящие для партии, и отдельно — неподходящие.
 *
 * Возвращает обе группы, а не только подходящие: интерфейс обязан показать
 * причину отказа по каждому заказу, иначе приёмщик видит, что «заказ не
 * добавился», и не понимает почему.
 *
 * Замечания подходящих заказов (`warning`) идут третьим списком: они не мешают
 * включить заказ, но интерфейс обязан их показать — иначе предупреждение
 * «заказ принят в другом магазине» существовало бы только в коде.
 */
export function partitionBatchCandidates(params: {
  orders: readonly BatchCandidateOrder[];
  direction: BatchDirection;
  fromStoreId?: string | null;
  toStoreId?: string | null;
  toWorkshopId?: string | null;
  alreadyInIds?: ReadonlySet<string>;
}): {
  eligible: BatchCandidateOrder[];
  rejected: Array<{
    order: BatchCandidateOrder;
    reason: BatchIneligibilityReason;
    message: string;
  }>;
  warnings: Array<{ order: BatchCandidateOrder; message: string }>;
} {
  const eligible: BatchCandidateOrder[] = [];
  const rejected: Array<{
    order: BatchCandidateOrder;
    reason: BatchIneligibilityReason;
    message: string;
  }> = [];
  const warnings: Array<{ order: BatchCandidateOrder; message: string }> = [];

  for (const order of params.orders) {
    const verdict = checkBatchEligibility({ ...params, order });
    if (verdict.eligible) {
      eligible.push(order);
      if (verdict.warning !== null) warnings.push({ order, message: verdict.warning });
    } else {
      rejected.push({
        order,
        reason: verdict.reason as BatchIneligibilityReason,
        message: verdict.message as string,
      });
    }
  }

  return { eligible, rejected, warnings };
}

/**
 * Лимит заказов в партии по умолчанию.
 *
 * `null` — без ограничения. Лимит намеренно ВЫКЛЮЧЕН по умолчанию: он не задан
 * ни в ТЗ, ни в документации, и включённый «на глазок» лимит блокировал бы
 * работу точки. Администратор задаёт число сам в настройках
 * (`logistics.batchMaxItems`), и только тогда оно действует.
 */
export const DEFAULT_BATCH_MAX_ITEMS: number | null = null;

/** Сверх лимита интерфейс предупреждает, но не блокирует (см. решение по 2.1). */
export function exceedsBatchLimit(count: number, maxItems: number | null): boolean {
  return maxItems !== null && count > maxItems;
}

/**
 * Статусы, при которых состав партии можно менять.
 *
 * После формирования акта состав ЗАМОРОЖЕН. Это не формальность: акт — документ
 * о передаче конкретных изделий, и если после подписания из партии убрать заказ,
 * подписанный акт перестанет соответствовать действительности, а изделие
 * окажется «переданным» без записи о том, что с ним стало. Разбираться в такой
 * ситуации пришлось бы вручную, поэтому изменение состава запрещено, а не
 * «не рекомендовано».
 */
export const BATCH_EDITABLE_STATUSES: readonly BatchStatus[] = [BATCH_STATUS.DRAFT];

/** Можно ли менять состав партии в этом статусе. */
export function isBatchCompositionEditable(status: BatchStatus): boolean {
  return BATCH_EDITABLE_STATUSES.includes(status);
}

/** Почему состав партии менять нельзя. Текст показывается логисту. */
export function batchCompositionLockReason(status: BatchStatus): string | null {
  if (isBatchCompositionEditable(status)) return null;
  if (status === BATCH_STATUS.ACT_FORMED) {
    return 'Акт уже сформирован: состав партии заморожен';
  }
  if (status === BATCH_STATUS.IN_TRANSIT) {
    return 'Партия в пути: состав заморожен';
  }
  if (status === BATCH_STATUS.RECEIVED) {
    return 'Партия уже принята: состав заморожен';
  }
  return 'Партия отменена: состав изменить нельзя';
}

/**
 * Фотофиксация партии (задача 2.4, ТЗ п. 2.6).
 *
 * ЗАЧЕМ ФОТО. Снимок — доказательство состояния тары и содержимого на момент
 * передачи. При споре «изделие поцарапано» или «недостача» решает не подпись
 * (её ставят, не разглядывая каждый пакет), а фотография с датой и автором.
 *
 * ПОЧЕМУ ЗАГРУЗКА И УДАЛЕНИЕ РАЗРЕШЕНЫ В РАЗНЫХ СТАТУСАХ. Снимок при приёмке
 * так же ценен, как при отправке, поэтому загружать фото можно и в пути, и после
 * приёмки. А удалять — только до отправки: после отъезда фото уже часть записи о
 * передаче, и пропавшее задним числом доказательство хуже, чем его отсутствие.
 */
export const BATCH_PHOTO_UPLOAD_STATUSES: readonly BatchStatus[] = [
  BATCH_STATUS.DRAFT,
  BATCH_STATUS.ACT_FORMED,
  BATCH_STATUS.IN_TRANSIT,
  BATCH_STATUS.RECEIVED,
];

/** Удалять фото можно, пока партия не уехала. */
export const BATCH_PHOTO_DELETABLE_STATUSES: readonly BatchStatus[] = [
  BATCH_STATUS.DRAFT,
  BATCH_STATUS.ACT_FORMED,
];

/** Можно ли добавить фото в этом статусе. */
export function canUploadBatchPhoto(status: BatchStatus): boolean {
  return BATCH_PHOTO_UPLOAD_STATUSES.includes(status);
}

/** Почему фото добавить нельзя. Текст показывается логисту. */
export function batchPhotoUploadLockReason(status: BatchStatus): string | null {
  if (canUploadBatchPhoto(status)) return null;
  return 'Партия отменена: фотофиксация недоступна';
}

/** Можно ли удалить фото в этом статусе. */
export function canDeleteBatchPhoto(status: BatchStatus): boolean {
  return BATCH_PHOTO_DELETABLE_STATUSES.includes(status);
}

/**
 * Почему фото удалить нельзя. Текст показывается логисту.
 *
 * Причина разная для «в пути» и «принята»: в первом случае фото ещё можно
 * переснять и дополнить, во втором передача состоялась, и запись закрыта.
 */
export function batchPhotoDeleteLockReason(status: BatchStatus): string | null {
  if (canDeleteBatchPhoto(status)) return null;
  if (status === BATCH_STATUS.IN_TRANSIT) {
    return 'Партия в пути: фото передачи удалить нельзя, добавьте новое';
  }
  if (status === BATCH_STATUS.RECEIVED) {
    return 'Партия принята: фото передачи удалить нельзя';
  }
  return 'Партия отменена: фотофиксация недоступна';
}

/**
 * Отправка и приём партии (задача 2.5, ТЗ п. 2.6).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЕ ПРАВИЛА. Отправка переводит СРАЗУ все заказы партии в «в пути»,
 * а приём — в «в производстве» (или «готов к выдаче»). Если правило статуса
 * живёт в сервисе, интерфейс не может показать кнопку заранее и логист узнаёт о
 * запрете только по ошибке.
 *
 * ПОЧЕМУ ИЗ DRAFT НЕЛЬЗЯ ОТПРАВИТЬ. Отправлять партию без акта приёма-передачи
 * значит везти изделия клиентов без документа: при утрате нечем подтвердить, что
 * именно и в каком виде приняли. Акт формируется отдельным шагом (2.2), и
 * требование акта — не формальность, а условие самой перевозки.
 */
export const BATCH_DISPATCHABLE_STATUSES: readonly BatchStatus[] = [BATCH_STATUS.ACT_FORMED];

/** Принять партию можно, только когда она в пути. */
export const BATCH_RECEIVABLE_STATUSES: readonly BatchStatus[] = [BATCH_STATUS.IN_TRANSIT];

/** Можно ли отправить партию в этом статусе. */
export function canDispatchBatch(status: BatchStatus): boolean {
  return BATCH_DISPATCHABLE_STATUSES.includes(status);
}

/** Почему партию нельзя отправить. Текст показывается логисту. */
export function batchDispatchLockReason(status: BatchStatus): string | null {
  if (canDispatchBatch(status)) return null;
  if (status === BATCH_STATUS.DRAFT) {
    return 'Сначала сформируйте акт приёма-передачи';
  }
  if (status === BATCH_STATUS.IN_TRANSIT) {
    return 'Партия уже отправлена';
  }
  if (status === BATCH_STATUS.RECEIVED) {
    return 'Партия уже принята';
  }
  return 'Партия отменена: отправить нельзя';
}

/** Можно ли принять партию в этом статусе. */
export function canReceiveBatch(status: BatchStatus): boolean {
  return BATCH_RECEIVABLE_STATUSES.includes(status);
}

/** Почему партию нельзя принять. Текст показывается принимающему. */
export function batchReceiveLockReason(status: BatchStatus): string | null {
  if (canReceiveBatch(status)) return null;
  if (status === BATCH_STATUS.DRAFT) {
    return 'Партия ещё не отправлена: сначала сформируйте акт и отправьте';
  }
  if (status === BATCH_STATUS.ACT_FORMED) {
    return 'Партия ещё не отправлена';
  }
  if (status === BATCH_STATUS.RECEIVED) {
    return 'Партия уже принята';
  }
  return 'Партия отменена: принять нельзя';
}

/**
 * Статус заказа, в который его переводит отправка или приём партии.
 *
 * Соответствие задано таблицей переходов (docs/04 §2), а не выведено из
 * направления: «в пути» для рейса в цех и из цеха — РАЗНЫЕ статусы
 * (`IN_TRANSIT_TO_PRODUCTION` и `IN_TRANSIT_TO_STORE`), и заказы этих рейсов
 * движутся по разным веткам. Перепутать их значит отправить заказ в цех,
 * который ждёт его из цеха.
 *
 * Возвращается `null`, когда направление и фаза несовместимы: подставлять
 * «хоть какой-нибудь» статус нельзя, иначе заказ молча уедет не туда.
 */
export function batchOrderTargetStatus(
  direction: BatchDirection,
  phase: 'DISPATCH' | 'RECEIVE',
  /**
   * Вернулся ли заказ из цеха без работ (отказ клиента, дефект 67).
   *
   * Параметр нужен только для приёмки рейса «в магазин»: по статусу
   * `IN_TRANSIT_TO_STORE` изделие после выполненной работы и изделие,
   * вернувшееся без работ, неразличимы — оба едут в магазин одним рейсом.
   */
  options?: { returnedWithoutWork?: boolean },
): OrderStatus | null {
  if (direction === BATCH_DIRECTION.TO_PRODUCTION) {
    /*
     * Приём партии цехом ведёт в `ACCEPTED_BY_WORKSHOP`, а не в `IN_PRODUCTION`:
     * менеджер должен видеть, какие заказы он получил, но ещё не распределил
     * (задача 7.1, дефект 63). `IN_PRODUCTION` остаётся статусом заказов,
     * принятых цехом до введения новых статусов; переход в него сохранён как
     * правило 12, но партиями больше не выставляется.
     */
    return phase === 'DISPATCH'
      ? ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION
      : ORDER_STATUS.ACCEPTED_BY_WORKSHOP;
  }
  if (direction === BATCH_DIRECTION.TO_STORE) {
    if (phase === 'DISPATCH') return ORDER_STATUS.IN_TRANSIT_TO_STORE;
    /*
     * Вернувшееся без работ изделие закрывается отказом клиента, а НЕ «Готов к
     * выдаче» (дефект 67). Из «Готов к выдаче» отмена недостижима — переход 10
     * разрешён только из `ACCEPTED`, — и заказ, от которого отказались, нельзя
     * было ни выдать (работы не выполнены, клиент отказался), ни закрыть.
     */
    return options?.returnedWithoutWork === true
      ? ORDER_STATUS.REFUSED_BEFORE_WORK
      : ORDER_STATUS.READY_FOR_PICKUP;
  }
  return null;
}

/** Строка состава так, как её видит снимок акта. */
export interface BatchActItem {
  orderId: string;
  orderNo: string;
  customerName: string;
  totalAmountMinor: number;
}

/**
 * Снимок состава партии для акта.
 *
 * Фиксируется в `BatchAct.itemsSnapshot` и больше не пересчитывается: акт должен
 * оставаться тем же документом, даже если заказ позже переименовали, а клиент
 * сменил ФИО. Именно поэтому снимок делается один раз в момент формирования, а
 * не собирается при каждой печати.
 */
export interface BatchActSnapshot {
  batchNo: string;
  direction: BatchDirection;
  fromLabel: string;
  toLabel: string;
  /** Число заказов — дублируется в снимке, чтобы акт читался без партии. */
  itemsCount: number;
  items: BatchActItem[];
  /** Общая сумма по составу, в минорных единицах (копейках). */
  totalAmountMinor: number;
  formedAt: string;
}

/**
 * Собрать снимок состава для акта.
 *
 * Чистая функция: сервис передаёт уже прочитанные строки, а не сам ходит в базу.
 * Так снимок можно проверить тестом отдельно от транзакции.
 */
export function buildBatchActSnapshot(params: {
  batchNo: string;
  direction: BatchDirection;
  fromLabel: string;
  toLabel: string;
  formedAt: Date;
  items: readonly BatchActItem[];
}): BatchActSnapshot {
  const items = [...params.items].sort((a, b) => a.orderNo.localeCompare(b.orderNo));
  return {
    batchNo: params.batchNo,
    direction: params.direction,
    fromLabel: params.fromLabel,
    toLabel: params.toLabel,
    itemsCount: items.length,
    items,
    totalAmountMinor: items.reduce((sum, item) => sum + item.totalAmountMinor, 0),
    formedAt: params.formedAt.toISOString(),
  };
}
