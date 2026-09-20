/**
 * Логика экрана партий (задача 7.6).
 *
 * ## Почему логика вынесена из компонентов
 *
 * Веб-тесты работают в окружении `node` и React НЕ рендерят (см.
 * `apps/web/vitest.config.ts`). Всё, что можно проверить — это чистые функции:
 * какие действия доступны в каком статусе, как сгруппировать кандидатов, что
 * показать перед отправкой. Если бы эти правила жили внутри разметки, они
 * проверялись бы только глазами на проде, а цена ошибки здесь высокая:
 *
 *  * кнопка «Отправить» на черновике без акта отправила бы партию, по которой
 *    нет передаточного документа;
 *  * предупреждение о чужом магазине, потерянное в разметке, привело бы к
 *    отправке изделия не в тот магазин — а это уже потерянный заказ.
 *
 * ## Один источник правды
 *
 * Доступность действий берётся из `@app/shared` (`canDispatchBatch`,
 * `canReceiveBatch`, `isBatchCompositionEditable` и т. д.), а НЕ дублируется
 * списками статусов здесь. Ровно на таком дублировании в проекте уже случался
 * дефект с нормативами сроков: клиент показывал одно, сервер делал другое.
 */

import {
  BATCH_DIRECTION,
  BATCH_STATUS,
  batchCompositionLockReason,
  batchDispatchLockReason,
  batchPhotoUploadLockReason,
  batchReceiveLockReason,
  canDispatchBatch,
  canReceiveBatch,
  canUploadBatchPhoto,
  isBatchCompositionEditable,
  type BatchDirection,
  type BatchStatus,
} from '@app/shared';
import type { Batch, BatchCandidateGroup } from './api-types';

/** Направление партии по-русски: заголовок экрана и колонка списка. */
export const BATCH_DIRECTION_LABELS: Record<BatchDirection, string> = {
  [BATCH_DIRECTION.TO_PRODUCTION]: 'В цех',
  [BATCH_DIRECTION.TO_STORE]: 'В магазин',
};

/** Подписи статусов партии. */
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  [BATCH_STATUS.DRAFT]: 'Черновик',
  [BATCH_STATUS.ACT_FORMED]: 'Акт сформирован',
  [BATCH_STATUS.IN_TRANSIT]: 'В пути',
  [BATCH_STATUS.RECEIVED]: 'Принята',
  [BATCH_STATUS.CANCELLED]: 'Отменена',
};

/** Тон бейджа статуса: совпадает с цветами статусов заказа. */
export function batchStatusTone(status: string): 'slate' | 'blue' | 'green' | 'red' {
  switch (status) {
    case BATCH_STATUS.ACT_FORMED:
      return 'blue';
    case BATCH_STATUS.IN_TRANSIT:
      return 'blue';
    case BATCH_STATUS.RECEIVED:
      return 'green';
    case BATCH_STATUS.CANCELLED:
      return 'red';
    default:
      return 'slate';
  }
}

/**
 * Что можно сделать с партией прямо сейчас.
 *
 * Каждое действие сопровождается ПРИЧИНОЙ недоступности, а не просто флагом:
 * серая кнопка без объяснения заставляет сотрудника гадать, чего не хватает
 * (не сформирован акт? не та роль? партия уже уехала?), и он идёт спрашивать.
 * Причина берётся из домена — она уже сформулирована по-русски и покрыта
 * тестами.
 */
export interface BatchActionState {
  /** Можно менять состав (добавлять и убирать заказы). */
  canEditComposition: boolean;
  compositionLockReason: string | null;
  /** Можно отправить. */
  canDispatch: boolean;
  dispatchLockReason: string | null;
  /** Можно принять. */
  canReceive: boolean;
  receiveLockReason: string | null;
  /** Можно загружать фотофиксацию. */
  canUploadPhoto: boolean;
  photoLockReason: string | null;
}

export function batchActions(status: string): BatchActionState {
  const s = status as BatchStatus;
  return {
    canEditComposition: isBatchCompositionEditable(s),
    compositionLockReason: batchCompositionLockReason(s),
    canDispatch: canDispatchBatch(s),
    dispatchLockReason: batchDispatchLockReason(s),
    canReceive: canReceiveBatch(s),
    receiveLockReason: batchReceiveLockReason(s),
    canUploadPhoto: canUploadBatchPhoto(s),
    photoLockReason: batchPhotoUploadLockReason(s),
  };
}

/**
 * Сколько заказов сменит статус и на какой — текст подтверждения.
 *
 * Требование задания: «перед отправкой/приёмом интерфейс сообщает, сколько
 * заказов сменит статус и на какой». Показывать последствия обязательно, потому
 * что отправка партии — массовая операция: одно нажатие переводит десятки
 * заказов, и отменить это одним действием нельзя.
 *
 * @param targetStatusLabel подпись целевого статуса заказа («В пути в цех»)
 */
export function dispatchConsequences(
  batch: Pick<Batch, 'itemsCount' | 'direction'>,
  targetStatusLabel: string,
): string {
  const direction = batch.direction === BATCH_DIRECTION.TO_PRODUCTION ? 'в цех' : 'в магазин';
  return `${batch.itemsCount} заказ(ов) уедет ${direction} и сменит статус на «${targetStatusLabel}»`;
}

/** Текст подтверждения приёма партии. */
export function receiveConsequences(
  batch: { itemsCount: number; items?: readonly { returnedWithoutWork: boolean }[] },
  targetStatusLabel: string,
  refusalStatusLabel: string,
): string {
  /*
   * Смешанный рейс (дефект 67): в одном рейсе «в магазин» едут и изделия после
   * выполненной работы, и изделия, возвращённые без работ. Первые становятся
   * «Готов к выдаче», вторые закрываются отказом клиента. Сказать «все заказы
   * перейдут в <один статус>» значило бы пообещать неверное: сотрудник,
   * увидевший отказ вместо готовности к выдаче, решил бы, что система сломалась.
   *
   * `items` необязателен: список партий приходит без состава, и там
   * довольствуются общим текстом. Если состава нет, обещать один статус тоже
   * нельзя — говорим нейтрально о направлении.
   */
  const items = batch.items;
  if (items === undefined) {
    return `${batch.itemsCount} заказ(ов) сменит статус при приёмке`;
  }

  const refused = items.filter((item) => item.returnedWithoutWork).length;
  const ready = items.length - refused;

  if (refused === 0) {
    return `${items.length} заказ(ов) сменит статус на «${targetStatusLabel}»`;
  }
  if (ready === 0) {
    return `${refused} заказ(ов) будет закрыто статусом «${refusalStatusLabel}»`;
  }
  return `${ready} заказ(ов) сменит статус на «${targetStatusLabel}», ${refused} — будет закрыто статусом «${refusalStatusLabel}»`;
}

/**
 * Маршрут партии одной строкой: «Магазин на Тверской → Центральный цех».
 *
 * Пустое направление показывает прочерк, а не пустую строку: пустое место в
 * списке читается как «данные не загрузились», и сотрудник обновляет страницу.
 */
export function batchRoute(
  batch: Pick<Batch, 'fromStoreName' | 'toStoreName' | 'toWorkshopName'>,
): string {
  const to = batch.toStoreName ?? batch.toWorkshopName ?? '—';
  return `${batch.fromStoreName ?? '—'} → ${to}`;
}

/**
 * Предупреждения по составу партии (задача 7.4).
 *
 * Кандидат с `warning` не отклонён, а принят с замечанием: контроль «где
 * приняли, там и выдаём» — зона ответственности менеджера (решение заказчика),
 * поэтому интерфейс о несовпадении магазина СООБЩАЕТ, но не блокирует.
 * Отклонение же показывается с причиной: без неё непонятно, почему заказ не
 * попал в список, и его начинают искать вручную.
 */
export interface CandidateView {
  orderId: string;
  orderNo: string;
  status: string;
  /** Замечание: заказ можно добавить, но на него стоит посмотреть. */
  warning: string | null;
  /** Причина отказа: заказ добавить нельзя. */
  rejectionReason: string | null;
  /** Подпись причины отказа; null, если заказ подходит. */
  rejectionLabel: string | null;
}

/** Подписи причин отказа в подборе (совпадают с `BATCH_INELIGIBILITY`). */
export const BATCH_REJECTION_LABELS: Record<string, string> = {
  WRONG_STATUS: 'Статус не подходит для этого направления',
  ALREADY_IN_BATCH: 'Уже в другой активной партии',
  WRONG_STORE: 'Другой магазин отправления',
  WRONG_DELIVERY_STORE: 'Выдача в другом магазине',
  NO_WORKSHOP: 'У заказа не определён цех',
  WRONG_WORKSHOP: 'Заказ закреплён за другим цехом',
};

/**
 * Кандидаты и отказы в едином виде для интерфейса.
 *
 * API отдаёт две группы (`eligible` и `rejected`), и это правильно: у них
 * разная семантика. Но в разметке они идут одним списком с разными отметками —
 * иначе сотрудник видит «заказ пропал» и не понимает, что он отклонён и почему.
 */
export function candidateViews(group: BatchCandidateGroup): CandidateView[] {
  const eligible: CandidateView[] = group.eligible.map((c) => ({
    orderId: c.id,
    orderNo: c.orderNo,
    status: c.status,
    warning: c.warning ?? null,
    rejectionReason: null,
    rejectionLabel: null,
  }));

  const rejected: CandidateView[] = group.rejected.map((c) => ({
    orderId: c.id,
    orderNo: c.orderNo,
    status: '',
    warning: null,
    rejectionReason: c.reason,
    rejectionLabel: BATCH_REJECTION_LABELS[c.reason] ?? c.message,
  }));

  return [...eligible, ...rejected];
}

/** Есть ли в подборе предупреждения — для заметки над списком. */
export function hasWarnings(group: BatchCandidateGroup): boolean {
  return group.eligible.some((c) => (c.warning ?? null) !== null);
}

/** Можно ли создать партию с выбранными параметрами (валидация формы). */
export interface CreateBatchForm {
  direction: BatchDirection;
  fromStoreId: string;
  toStoreId: string;
  toWorkshopId: string;
  plannedAt: string;
  comment: string;
}

/** Ошибки формы создания партии по полям. */
export type CreateBatchErrors = Partial<Record<keyof CreateBatchForm, string>>;

/**
 * Проверка формы создания партии до отправки запроса.
 *
 * Намеренно повторяет `createBatchSchema`, но с человеческими подписями полей:
 * сервер вернёт `VALIDATION_ERROR` с `details` по полям, однако показать их
 * рядом с полем формы можно только зная соответствие. Проверка на клиенте не
 * заменяет серверную — она избавляет от заведомо обречённого запроса.
 */
export function validateCreateBatch(form: CreateBatchForm): CreateBatchErrors {
  const errors: CreateBatchErrors = {};

  if (form.fromStoreId === '') {
    errors.fromStoreId = 'Выберите магазин отправления';
  }
  if (form.direction === BATCH_DIRECTION.TO_PRODUCTION && form.toWorkshopId === '') {
    errors.toWorkshopId = 'Для партии в цех выберите цех';
  }
  if (form.direction === BATCH_DIRECTION.TO_STORE && form.toStoreId === '') {
    errors.toStoreId = 'Для партии в магазин выберите магазин назначения';
  }
  if (form.plannedAt.trim() === '') {
    errors.plannedAt = 'Укажите плановую дату';
  }
  if (form.comment.length > 1000) {
    errors.comment = 'Не более 1000 символов';
  }

  return errors;
}

/** Можно ли отправлять форму (ошибок нет). */
export function isCreateBatchValid(form: CreateBatchForm): boolean {
  return Object.keys(validateCreateBatch(form)).length === 0;
}

/**
 * Параметры фильтра списка партий в query-строку.
 *
 * Пустые значения пропускаются: `direction=` сервер попытается разобрать как
 * направление и ответит ошибкой валидации.
 */
export function batchFiltersToQuery(filters: {
  direction: string;
  status: string;
  fromStoreId: string;
  plannedOn: string;
}): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.direction !== '') query['direction'] = filters.direction;
  if (filters.status !== '') query['status'] = filters.status;
  if (filters.fromStoreId !== '') query['fromStoreId'] = filters.fromStoreId;
  if (filters.plannedOn !== '') query['plannedOn'] = filters.plannedOn;
  return query;
}

/**
 * Ссылка на печать акта.
 *
 * PDF открывается в новой вкладке: это и есть «реестр отправляемых документов»,
 * который печатают и подписывают. Скачивать файл в «Загрузки» не нужно —
 * сотрудник печатает и отдаёт бумагу.
 */
export function batchActPdfPath(batchId: string): string {
  return `/api/v1/batches/${batchId}/act/pdf`;
}
