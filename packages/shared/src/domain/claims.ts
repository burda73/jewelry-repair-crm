/**
 * Домен рекламаций (этап 6, ТЗ п. 2.9).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Рекламация — обязательство с юридическим сроком: ТЗ требует
 * рассмотреть её за 10 РАБОЧИХ дней. Срок, который считают «на глазок»,
 * истекает незаметно, а просроченная рекламация — это уже не неудобство, а
 * нарушение прав потребителя. Поэтому срок считает система, а не человек, и она
 * же предупреждает о его приближении (задача 6.6).
 *
 * ПОЧЕМУ ПРАВИЛА ЗДЕСЬ, А НЕ В СЕРВИСЕ. Те же вопросы задаёт интерфейс: какие
 * решения доступны в текущем статусе, можно ли ещё изменить рекламацию, что
 * произойдёт при отказе. Если правило живёт только в сервисе, интерфейс
 * повторяет его своими средствами, и две реализации расходятся — в этом проекте
 * так уже разошлись словари этапов на три варианта (docs/15 «Дефект 26»).
 *
 * ПОЧЕМУ СТАТУСЫ ИМЕННО ТАКИЕ. Значения совпадают с `enum ClaimStatus` в схеме
 * БД, то есть с контрактом, заложенным при проектировании. Способ возмещения
 * закодирован в самом статусе (`RESOLVED_REPAIR` против `RESOLVED_REFUND`),
 * потому что исход рекламации — это состояние, в котором она находится: по
 * статусу строится и список, и отчёт, и выборка «сколько вернули денег».
 */

import { addWorkingDays, workingDaysBetween, type WorkingCalendar } from '../utils/dates.js';

/** Статусы рекламации. Значения совпадают с `enum ClaimStatus` в схеме БД. */
export const CLAIM_STATUS = {
  /** Открыта приёмщиком, решение ещё не принято. */
  OPENED: 'OPENED',
  /** Взята в работу: назначен рассматривающий. */
  IN_REVIEW: 'IN_REVIEW',
  /** Одобрена: гарантийный случай подтверждён, работа предстоит. */
  APPROVED: 'APPROVED',
  /** Отклонена с обязательной причиной. */
  REJECTED: 'REJECTED',
  /** Урегулирована гарантийным ремонтом. */
  RESOLVED_REPAIR: 'RESOLVED_REPAIR',
  /** Урегулирована возвратом денег. */
  RESOLVED_REFUND: 'RESOLVED_REFUND',
  /** Закрыта: работа по рекламации завершена. */
  CLOSED: 'CLOSED',
} as const;

export type ClaimStatus = (typeof CLAIM_STATUS)[keyof typeof CLAIM_STATUS];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  [CLAIM_STATUS.OPENED]: 'Открыта',
  [CLAIM_STATUS.IN_REVIEW]: 'На рассмотрении',
  [CLAIM_STATUS.APPROVED]: 'Одобрена',
  [CLAIM_STATUS.REJECTED]: 'Отклонена',
  [CLAIM_STATUS.RESOLVED_REPAIR]: 'Урегулирована ремонтом',
  [CLAIM_STATUS.RESOLVED_REFUND]: 'Урегулирована возвратом',
  [CLAIM_STATUS.CLOSED]: 'Закрыта',
};

/**
 * Срок рассмотрения — 10 РАБОЧИХ дней (ТЗ п. 2.9).
 *
 * Именно рабочих: календарные 10 дней почти всегда попадают на выходные, и срок
 * истекал бы в день, когда никто не работает. Рабочие дни считает
 * `addWorkingDays` по тому же календарю, что и нормативы этапов, — иначе «10
 * рабочих дней» в рекламации и в сроке заказа означали бы разное.
 */
export const CLAIM_REVIEW_WORKING_DAYS = 10;

/**
 * За сколько рабочих дней до срока предупреждать (задача 6.6).
 *
 * Три дня — время, за которое рассмотрение можно реально завершить: за один
 * день согласовать решение с мастером и клиентом не всегда возможно, а
 * предупреждение за неделю перестало бы восприниматься как срочное.
 */
export const CLAIM_WARNING_WORKING_DAYS = 3;

/**
 * Срок рассмотрения рекламации: `openedAt` плюс `workingDays` рабочих дней.
 *
 * Срок — параметр, а не константа: значение приходит из настройки
 * `CLAIM_REVIEW_WORKDAYS`. Настройка объявлена с самого начала, но до этапа 6
 * не читалась нигде, то есть изменение «10» в конфигурации ничего не меняло —
 * тот же класс дефекта, что у флагов каналов (docs/15 «Дефект 41»).
 *
 * На уже открытые рекламации смена настройки не влияет: `dueAt` сохранён при
 * открытии. Это и есть смысл хранения — обязательство, названное клиенту, не
 * должно меняться задним числом.
 */
export function computeClaimDueAt(
  openedAt: Date,
  calendar: WorkingCalendar,
  workingDays: number = CLAIM_REVIEW_WORKING_DAYS,
): Date {
  return addWorkingDays(openedAt, workingDays, calendar);
}

/** Момент, с которого рекламацию пора предупреждать: `dueAt` минус 3 рабочих дня. */
export function computeClaimWarningAt(dueAt: Date, calendar: WorkingCalendar): Date {
  return addWorkingDays(dueAt, -CLAIM_WARNING_WORKING_DAYS, calendar);
}

/**
 * Разрешённые переходы статусов.
 *
 * Отклонённая и закрытая рекламации не имеют исходящих переходов: закрытую
 * нельзя переоткрыть, иначе история рассмотрения теряла бы смысл, а срок 10 дней
 * можно было бы обойти, закрыв и открыв рекламацию заново. Для повторного
 * обращения заводится новая рекламация — так сохраняются и статистика, и
 * юридически значимая последовательность.
 *
 * «Одобрена» НЕ ведёт в «закрыта» напрямую: одобрение означает, что случай
 * признан гарантийным, но чем именно он урегулирован — ремонтом или возвратом
 * денег, — должно быть зафиксировано. Иначе отчёт не смог бы ответить, сколько
 * денег вернули клиентам.
 */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  [CLAIM_STATUS.OPENED]: [CLAIM_STATUS.IN_REVIEW, CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.IN_REVIEW]: [CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.APPROVED]: [CLAIM_STATUS.RESOLVED_REPAIR, CLAIM_STATUS.RESOLVED_REFUND],
  [CLAIM_STATUS.RESOLVED_REPAIR]: [CLAIM_STATUS.CLOSED],
  [CLAIM_STATUS.RESOLVED_REFUND]: [CLAIM_STATUS.CLOSED],
  [CLAIM_STATUS.REJECTED]: [],
  [CLAIM_STATUS.CLOSED]: [],
};

/** Возможен ли переход. */
export function canTransitionClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

/** Терминальный ли статус: дальнейшие изменения невозможны. */
export function isClaimTerminal(status: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[status].length === 0;
}

/** Читаемая формулировка исхода для карточки и отчёта. */
export const CLAIM_RESOLUTION_LABELS: Record<string, string> = {
  [CLAIM_STATUS.RESOLVED_REPAIR]: 'Гарантийный ремонт',
  [CLAIM_STATUS.RESOLVED_REFUND]: 'Возврат денег',
};

/**
 * Урегулирована ли рекламация по существу.
 *
 * «Закрыта» сама по себе не говорит, чем закончилось дело, поэтому для отчётов
 * нужен отдельный вопрос «решение принято и исполнено». Отклонение тоже решение,
 * но оно не является урегулированием в пользу клиента.
 */
export function isClaimResolved(status: ClaimStatus): boolean {
  return status === CLAIM_STATUS.RESOLVED_REPAIR || status === CLAIM_STATUS.RESOLVED_REFUND;
}

/**
 * Требуется ли текстовое обоснование для перехода.
 *
 * Отказ обязан быть мотивирован: клиент вправе знать причину, а сотрудник,
 * разбирающий жалобу, — видеть, на чём основано решение. Остальные переходы
 * обоснования не требуют.
 */
export function claimTransitionRequirement(to: ClaimStatus): 'REJECTION_REASON' | null {
  return to === CLAIM_STATUS.REJECTED ? 'REJECTION_REASON' : null;
}

/** Коды отказа в переходе — часть контракта API (docs/07). */
export const CLAIM_TRANSITION_DENIED = {
  /** Переход не предусмотрен правилами. */
  ILLEGAL: 'CLAIM_ILLEGAL_TRANSITION',
  /** Отказ без причины. */
  NO_REASON: 'CLAIM_REJECTION_REASON_REQUIRED',
  /** Рекламация уже закрыта или отклонена. */
  TERMINAL: 'CLAIM_TERMINAL',
} as const;

export type ClaimTransitionDeniedCode =
  (typeof CLAIM_TRANSITION_DENIED)[keyof typeof CLAIM_TRANSITION_DENIED];

/** Проверка перехода: `null` — переход разрешён. */
export function claimTransitionDenial(
  from: ClaimStatus,
  to: ClaimStatus,
  input: { rejectionReason?: string | null },
): ClaimTransitionDeniedCode | null {
  // Терминальность проверяется ПЕРВОЙ: для закрытой рекламации любой переход
  // запрещён именно потому, что она закрыта, и сообщать про отсутствие причины
  // было бы неточно.
  if (isClaimTerminal(from)) return CLAIM_TRANSITION_DENIED.TERMINAL;
  if (!canTransitionClaim(from, to)) return CLAIM_TRANSITION_DENIED.ILLEGAL;

  if (
    claimTransitionRequirement(to) === 'REJECTION_REASON' &&
    (input.rejectionReason ?? '').trim() === ''
  ) {
    return CLAIM_TRANSITION_DENIED.NO_REASON;
  }

  return null;
}

/**
 * Просрочена ли рекламация: срок рассмотрения истёк, а решения нет.
 *
 * Закрытая и отклонённая рекламация не бывает просроченной: срок относится к
 * рассмотрению, а оно завершено — даже если завершилось после срока, это уже
 * история, а не текущая просрочка. Иначе закрытые рекламации копились бы в
 * списке просроченных навсегда, и список перестал бы быть списком задач.
 */
export function isClaimOverdue(status: ClaimStatus, dueAt: Date, now = new Date()): boolean {
  if (isClaimTerminal(status)) return false;
  return dueAt.getTime() < now.getTime();
}

/**
 * Осталось рабочих дней до срока. Отрицательное значение — просрочка.
 *
 * Считается по календарю, а не делением миллисекунд: «осталось 2 дня» должно
 * означать два рабочих дня, а не 48 часов, которые могут целиком прийтись на
 * выходные. Используется общий `workingDaysBetween` — та же функция, что считает
 * сроки этапов, поэтому «рабочий день» в рекламации и в заказе означает одно.
 */
export function claimWorkingDaysLeft(
  dueAt: Date,
  calendar: WorkingCalendar,
  now = new Date(),
): number {
  // `workingDaysBetween` возвращает 0, если конец раньше начала, поэтому
  // направление задаётся порядком аргументов, а знак — знаком результата.
  if (dueAt.getTime() <= now.getTime()) {
    return -workingDaysBetween(dueAt, now, calendar);
  }
  return workingDaysBetween(now, dueAt, calendar);
}

/**
 * Нужно ли предупредить о приближении срока.
 *
 * Предупреждение должно уйти ровно один раз за рекламацию, поэтому решение о
 * повторной отправке принимает вызывающий код по сохранённой отметке; здесь
 * отвечается только на вопрос «срок уже близко или прошёл».
 */
export function needsClaimWarning(
  status: ClaimStatus,
  dueAt: Date,
  calendar: WorkingCalendar,
  now = new Date(),
): boolean {
  if (isClaimTerminal(status)) return false;
  if (isClaimOverdue(status, dueAt, now)) return true;
  const warningAt = computeClaimWarningAt(dueAt, calendar);
  return now.getTime() >= warningAt.getTime();
}
