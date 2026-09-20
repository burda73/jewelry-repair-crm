/**
 * Логика подписи клиента при выдаче заказа (дефект 66).
 *
 * ## Зачем отдельный модуль
 *
 * Веб-тесты работают в окружении `node` и React не рендерят (см.
 * `apps/web/vitest.config.ts`), поэтому правило «нужно ли просить подпись перед
 * этим переходом» вынесено в чистую функцию и проверяется тестами.
 *
 * Цена ошибки здесь высокая. Переход в «Выдан» охраняется условием
 * `PICKUP_SIGNATURE`, и без подписи сервер отвечает `409
 * PICKUP_SIGNATURE_REQUIRED`. Если интерфейс не предложит загрузить подпись,
 * сотрудник упрётся в отказ на последнем шаге выдачи, когда клиент уже стоит у
 * стойки. Обратная ошибка — просить подпись там, где она не нужна, — заставляла
 * бы прикладывать файл при каждой смене статуса.
 */

/** Переходы, требующие подписи клиента (docs/04 §2, переходы 18 и 21). */
export const SIGNATURE_REQUIRED_STATUSES: readonly string[] = ['COMPLETED'];

/**
 * Нужно ли приложить подпись клиента перед переходом в этот статус.
 *
 * @param to целевой статус перехода
 * @param hasSignature уже приложена ли подпись
 */
export function needsPickupSignature(to: string, hasSignature: boolean): boolean {
  return SIGNATURE_REQUIRED_STATUSES.includes(to) && !hasSignature;
}

/**
 * Можно ли выполнить переход прямо сейчас.
 *
 * Подпись требуется только для выдачи, и только если её ещё нет. Здесь же
 * проверяется, что выбран статус: пустое значение означает «сотрудник ещё не
 * выбрал действие», и отправлять запрос нечего.
 */
export function canSubmitTransition(params: {
  to: string;
  hasSignature: boolean;
  signatureFile: File | null;
  signatureUploading: boolean;
}): boolean {
  if (params.to === '') return false;
  if (params.signatureUploading) return false;
  if (!needsPickupSignature(params.to, params.hasSignature)) return true;
  return params.signatureFile !== null;
}

/**
 * Подпись для перехода, требующего её, но отсутствующая.
 *
 * Возвращает текст подсказки — или `null`, если подсказка не нужна. Причина
 * объясняется заранее: серый недоступный переход без объяснения выглядит как
 * поломка интерфейса, и сотрудник идёт выяснять, почему кнопка не работает.
 */
export function signatureHint(to: string, hasSignature: boolean): string | null {
  if (!needsPickupSignature(to, hasSignature)) return null;
  return 'Для выдачи приложите подпись клиента о получении изделия';
}

/**
 * Проверка файла подписи до отправки.
 *
 * На клиенте проверяется только очевидное: тип и размер. Сервер проверяет те же
 * условия повторно — клиентская проверка лишь избавляет от заведомо обречённого
 * запроса и не заменяет серверную.
 *
 * @param file выбранный файл
 * @param maxBytes предельный размер (сервер ограничивает тем же значением)
 */
export function validateSignatureFile(
  file: File,
  maxBytes: number,
): { ok: true } | { ok: false; message: string } {
  if (file.size === 0) {
    return { ok: false, message: 'Файл пуст' };
  }
  if (file.size > maxBytes) {
    const mb = Math.round(maxBytes / 1024 / 1024);
    return { ok: false, message: `Файл больше ${mb} МБ` };
  }

  /*
   * Подпись — изображение или скан. PDF допускается: подпись может прийти
   * сканом с бумажного носителя. Прочие типы отклоняются, потому что файл
   * произвольного формата в карточке заказа будет бесполезен при разбирательстве.
   */
  const allowed = ['image/', 'application/pdf'];
  if (!allowed.some((prefix) => file.type.startsWith(prefix))) {
    return { ok: false, message: 'Допустимы изображение или PDF' };
  }

  return { ok: true };
}
