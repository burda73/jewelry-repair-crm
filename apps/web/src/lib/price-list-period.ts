/**
 * Срок действия версии прейскуранта: черновик и вычисление изменения.
 *
 * ПОЧЕМУ ЭТО НЕ В КОМПОНЕНТЕ. До этой правки даты версии можно было только
 * увидеть: `effectiveFrom` показывалась в строке списка, `effectiveTo` не
 * показывался вовсе, а задать их получалось лишь при копировании версии.
 * Сервер при этом принимает обе даты в `PATCH /price-lists/:id`
 * (`updatePriceListSchema`), то есть возможность была, а пути к ней — нет.
 *
 * Даты — источник ошибок, которые сервер отвергает, а администратор не может
 * объяснить: дата в формате `<input type="date">` приходит как `ГГГГ-ММ-ДД`
 * без времени, и наивное `new Date(value)` читает её как полночь UTC, тогда как
 * сравнение периодов должно быть устойчивым к часовому поясу. Здесь это
 * собрано в одном месте и покрыто тестами.
 */

/** Поля версии, которые администратор правит в карточке. */
export interface PriceListPeriodFields {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Частичное изменение для `PATCH /price-lists/:id`: только тронутые поля. */
export interface PriceListPeriodPayload {
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

/**
 * Дата из `<input type="date">` в ISO.
 *
 * Полночь UTC, а не местная: сервер сравнивает периоды между собой, и сдвиг на
 * часовой пояс сдвинул бы границу действия прейскуранта на день.
 */
export function dateInputToIso(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

/** ISO в значение для `<input type="date">` — обратное преобразование. */
export function isoToDateInput(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Собрать частичное изменение срока действия. `null` — администратор ничего не
 * изменил.
 *
 * Обе даты сравниваются по значению дня, а не по исходной строке ISO: сервер
 * отдаёт `2026-09-16T17:05:08.846Z`, и сравнение со строкой `2026-09-16`
 * объявило бы изменение там, где администратор лишь открыл карточку.
 */
export function buildPriceListPeriodInput(
  original: PriceListPeriodFields,
  draft: PriceListPeriodFields,
): PriceListPeriodPayload | null {
  const payload: PriceListPeriodPayload = {};

  // Обе стороны приводятся к значению поля `<input type="date">`: сервер отдаёт
  // полный ISO, форма — только день, и сравнивать их напрямую нельзя.
  const originalFrom = isoToDateInput(original.effectiveFrom);
  if (draft.effectiveFrom !== originalFrom) {
    payload.effectiveFrom = dateInputToIso(draft.effectiveFrom);
  }

  const originalTo = original.effectiveTo === null ? '' : isoToDateInput(original.effectiveTo);
  const draftTo = draft.effectiveTo === null ? '' : isoToDateInput(draft.effectiveTo);
  if (draftTo !== originalTo) {
    // Пустая дата окончания означает «бессрочно», а не «не трогать»: сервер
    // принимает `null`, и без этого поля снять срок действия было бы нельзя.
    payload.effectiveTo = draftTo === '' ? null : dateInputToIso(draftTo);
  }

  return Object.keys(payload).length === 0 ? null : payload;
}

/**
 * Проверить период до отправки.
 *
 * Повторяет правило `updatePriceListSchema` («дата окончания позже даты
 * начала»), но сообщает об этом рядом с полями: сервер вернул бы
 * `VALIDATION_ERROR` на поле, которого администратор не касался.
 */
export function describePriceListPeriodError(draft: PriceListPeriodFields): string | null {
  if (draft.effectiveFrom === '') return 'Укажите дату начала действия';
  if (Number.isNaN(new Date(`${draft.effectiveFrom}T00:00:00.000Z`).getTime())) {
    return 'Некорректная дата начала';
  }
  if (draft.effectiveTo === null) return null;
  if (Number.isNaN(new Date(`${draft.effectiveTo}T00:00:00.000Z`).getTime())) {
    return 'Некорректная дата окончания';
  }
  if (dateInputToIso(draft.effectiveTo) <= dateInputToIso(draft.effectiveFrom)) {
    return 'Дата окончания должна быть позже даты начала';
  }
  return null;
}
