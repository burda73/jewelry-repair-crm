/**
 * Покрытие суммы заказа согласованием клиента (ТЗ п. 2.4, требование заказчика).
 *
 * ## Зачем отдельный модуль
 *
 * Согласование — это ДОГОВОРЁННОСТЬ О СУММЕ, а не отметка «клиент в курсе».
 * Пока состав работ не менялся, `OrderApproval` и итог заказа совпадают, и
 * проверка «согласование есть» работает. Но работы можно дополнить или убрать,
 * итог меняется — и старая отметка продолжает пропускать заказ в работу с
 * суммой, которую клиент не подтверждал. Внешне это выглядит как «согласовано»,
 * то есть ошибка не видна ни сотруднику, ни проверяющему.
 *
 * Поэтому здесь сравниваются ДВЕ СУММЫ, а не наличие записи: согласованная и
 * текущая. Расхождение — это не «нет согласования» и не «согласование неверно»,
 * а «согласование устарело»: клиент когда-то согласился, но на другую сумму.
 * Для сотрудника разница существенна — в одном случае нужно позвонить клиенту,
 * в другом достаточно посмотреть, что изменилось после согласования.
 *
 * ## Почему сравнение строгое
 *
 * Удешевление тоже требует согласования. Это не формальность: клиент
 * подтвердил конкретную сумму и срок, а уменьшение объёма меняет и то, и
 * другое. Молчаливое «стало дешевле — значит, клиент не против» — это решение
 * за клиента, а не за систему.
 */

/** Итог проверки: покрывает ли согласование текущую сумму заказа. */
export type ApprovalCoverage =
  | { readonly ok: true; readonly approvedMinor: number }
  | { readonly ok: false; readonly reason: 'MISSING' }
  | {
      readonly ok: false;
      readonly reason: 'STALE';
      readonly approvedMinor: number;
      readonly totalMinor: number;
    };

/**
 * Сравнить согласованную сумму с текущим итогом заказа.
 *
 * @param approvedTotalMinor сумма ПОСЛЕДНЕГО состоявшегося согласования;
 *                           `null`, если согласований не было
 * @param totalAmountMinor   текущий итог заказа
 *
 * Берётся последнее согласование, а не любое подходящее по сумме. Разница
 * проявляется на возврате к прежней цене: клиент согласовал 5000, потом 6000,
 * потом работы убрали и снова стало 5000. «Любое подходящее» нашло бы первое
 * согласование на 5000 и пропустило заказ — хотя состав работ с тех пор
 * менялся дважды и клиент подтверждал уже другой заказ. Последнее согласование
 * обязано относиться к текущему составу.
 */
export function checkApprovalCoverage(
  approvedTotalMinor: number | null,
  totalAmountMinor: number,
): ApprovalCoverage {
  if (approvedTotalMinor === null) return { ok: false, reason: 'MISSING' };
  if (approvedTotalMinor !== totalAmountMinor) {
    return {
      ok: false,
      reason: 'STALE',
      approvedMinor: approvedTotalMinor,
      totalMinor: totalAmountMinor,
    };
  }
  return { ok: true, approvedMinor: approvedTotalMinor };
}

/**
 * Сообщение сотруднику: что именно произошло и что с этим делать.
 *
 * Текст живёт здесь, а не в сервисе: одна и та же ситуация объясняется
 * одинаково и в ошибке API, и в интерфейсе, и в тесте. Расходящиеся
 * формулировки об одном и том же заставляют искать разницу там, где её нет.
 */
export function approvalCoverageMessage(coverage: ApprovalCoverage): string {
  if (coverage.ok) return 'Сумма согласована с клиентом';
  if (coverage.reason === 'MISSING') {
    return 'Отсутствует согласование клиента по сумме и сроку';
  }
  return 'Согласование устарело: сумма заказа изменилась после согласования. Получите согласие клиента на новую сумму';
}

/**
 * Откат заказа до состояния из истории (инструмент администратора).
 *
 * ## Зачем отдельная функция, а не «взять статус из истории»
 *
 * Откат обходит таблицу переходов, поэтому все её гарантии приходится проверять
 * заново — здесь, для одного конкретного случая. Ошибка в этой проверке не
 * проявляется отказом: она проявляется заказом в состоянии, из которого нет
 * выхода, или документом, который противоречит фактам.
 *
 * ## Что проверяется
 *
 * 1. **Целевой статус — из ИСТОРИИ ЭТОГО заказа.** Иначе опечатка или подделка
 *    запроса перевела бы заказ в состояние, которого у него никогда не было, и
 *    «откат» стал бы произвольной сменой статуса.
 * 2. **Это не текущий статус.** Откат в то же состояние — это запись в истории
 *    ни о чём, и она сбивала бы подсчёт времени в статусах.
 * 3. **Заказ не в терминальном статусе.** Закрытый заказ (выдан, отказ, отмена)
 *    откатывать нельзя: выдача подтверждена подписью клиента и оплатой, а отказ
 *    и отмена — документами. «Раскрыть» закрытый заказ значило бы объявить эти
 *    документы недействительными, не оформляя этого.
 */

/** Состояние заказа, зафиксированное в истории. */
export interface RollbackTarget {
  /** Статус, в который заказ был переведён. */
  readonly toStatus: string;
  /** Момент перехода. */
  readonly at: Date;
}

/** Результат проверки отката. */
export type RollbackCheck =
  | { readonly ok: true; readonly fromStatus: string }
  | { readonly ok: false; readonly reason: RollbackRejectReason };

export type RollbackRejectReason = 'SAME_STATUS' | 'NOT_IN_HISTORY' | 'ORDER_FINAL' | 'NO_HISTORY';

/**
 * Можно ли откатить заказ в указанное состояние.
 *
 * @param currentStatus текущий статус заказа
 * @param history       история переходов заказа (в любом порядке)
 * @param target        целевой статус
 * @param isFinal       закрыт ли заказ (терминальный статус)
 */
export function checkOrderRollback(params: {
  currentStatus: string;
  history: readonly RollbackTarget[];
  target: string;
  isFinal: boolean;
}): RollbackCheck {
  const { currentStatus, history, target, isFinal } = params;

  if (history.length === 0) return { ok: false, reason: 'NO_HISTORY' };

  /*
   * Терминальный статус проверяется ПЕРВЫМ: это самая частая попытка и самая
   * опасная. Сообщение о ней должно быть про закрытый заказ, а не про то, что
   * статус не найден в истории.
   */
  if (isFinal) return { ok: false, reason: 'ORDER_FINAL' };
  if (target === currentStatus) return { ok: false, reason: 'SAME_STATUS' };

  // Целевой статус обязан встречаться в истории ЭТОГО заказа.
  const known = history.some((entry) => entry.toStatus === target);
  if (!known) return { ok: false, reason: 'NOT_IN_HISTORY' };

  return { ok: true, fromStatus: currentStatus };
}

/** Объяснение отказа сотруднику. */
export function rollbackRejectMessage(reason: RollbackRejectReason): string {
  switch (reason) {
    case 'ORDER_FINAL':
      return 'Заказ закрыт: откат невозможен. Выдача подтверждена подписью и оплатой, отказ и отмена — документами';
    case 'SAME_STATUS':
      return 'Заказ уже находится в этом состоянии';
    case 'NO_HISTORY':
      return 'У заказа нет истории состояний — откатывать некуда';
    case 'NOT_IN_HISTORY':
    default:
      return 'Этого состояния не было в истории заказа: откат возможен только к пройденным состояниям';
  }
}

/**
 * Состояния, доступные для отката: то, что заказ уже проходил.
 *
 * Возвращаются в порядке от новых к старым — так их показывает вкладка истории.
 * Текущий статус исключён: откат в него бессмыслен.
 */
export function rollbackTargets(
  history: readonly RollbackTarget[],
  currentStatus: string,
): readonly RollbackTarget[] {
  const seen = new Set<string>();
  const result: RollbackTarget[] = [];

  for (const entry of [...history].sort((a, b) => b.at.getTime() - a.at.getTime())) {
    if (entry.toStatus === currentStatus) continue;
    if (seen.has(entry.toStatus)) continue;
    seen.add(entry.toStatus);
    result.push(entry);
  }

  return result;
}

/**
 * Пометка, которой запись об откате отличается от обычной смены статуса.
 *
 * Причина отката хранится в `OrderStatusHistory.reason` строкой, и по ней лента
 * событий понимает, что произошёл откат. Отдельного поля для этого нет
 * намеренно: откат — это редкое событие, и заводить под него колонку значило бы
 * менять схему ради одной подписи. Но формат строки становится КОНТРАКТОМ между
 * сервисом отката и лентой, поэтому он объявлен здесь: расхождение (например,
 * «Откат.» вместо «Откат:») не сломает запись, но лента перестанет различать
 * откаты, и заметить это будет нечем.
 */
export const ROLLBACK_REASON_PREFIX = 'Откат:';

/** Причина для записи в историю: одна форма на все откаты. */
export function rollbackReasonText(reason: string): string {
  return `${ROLLBACK_REASON_PREFIX} ${reason.trim()}`;
}

/** Это запись об откате, а не о штатном переходе? */
export function isRollbackReason(reason: string | null | undefined): boolean {
  return reason !== null && reason !== undefined && reason.startsWith(ROLLBACK_REASON_PREFIX);
}
