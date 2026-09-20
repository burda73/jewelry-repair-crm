/**
 * Подпись клиента при выдаче заказа.
 *
 * ИСТОРИЯ ВОПРОСА. Сначала подпись была УСЛОВИЕМ выдачи: переход в «Выдан»
 * охранялся условием `PICKUP_SIGNATURE`, и без файла сервер отвечал `409
 * PICKUP_SIGNATURE_REQUIRED`. Потом заказчик решил, что подпись не должна
 * блокировать выдачу: требование снято, а возможность приложить подпись осталась
 * необязательной отметкой о получении.
 *
 * Проверки ниже охраняют именно это: подпись ПРЕДЛАГАЕТСЯ при выдаче, но НИКОГДА
 * не мешает её выполнить. Обратная ошибка — снова начать требовать росчерк —
 * была бы хуже прежней: сервер её не проверяет, значит отказ пришёл бы от
 * валидации в форме, и сотрудник не смог бы выдать заказ, не понимая почему.
 */

import { describe, expect, it } from 'vitest';
import {
  canSubmitTransition,
  offersPickupSignature,
  signatureHint,
  validateSignatureFile,
} from './pickup-signature';

/** Двойник `File`: в окружении `node` конструктора `File` нет. */
function fakeFile(size: number, type: string): File {
  return { size, type, name: 'sign.png' } as unknown as File;
}

describe('Подпись предлагается при выдаче, но не требуется', () => {
  it('при выдаче поле подписи показывается', () => {
    // Подпись осталась возможной как отметка о получении — но необязательной.
    expect(offersPickupSignature('COMPLETED', false)).toBe(true);
  });

  it('при уже приложенной подписи поле не показывается повторно', () => {
    // Предлагать загрузить второй росчерк бессмысленно.
    expect(offersPickupSignature('COMPLETED', true)).toBe(false);
  });

  it('при остальных переходах поле подписи не показывается', () => {
    /*
     * Обратная ошибка — предлагать подпись при каждой смене статуса. Проверяются
     * содержательные переходы: отправка в цех, приёмка, готовность к выдаче.
     */
    for (const status of [
      'QUEUED_FOR_DISPATCH',
      'IN_TRANSIT_TO_PRODUCTION',
      'ACCEPTED_BY_WORKSHOP',
      'IN_WORK',
      'WORK_COMPLETED',
      'IN_TRANSIT_TO_STORE',
      'READY_FOR_PICKUP',
      'CANCELLED',
    ]) {
      expect(offersPickupSignature(status, false), status).toBe(false);
    }
  });

  it('подсказки, требующей подпись, больше нет', () => {
    /*
     * ГЛАВНАЯ проверка снятия требования. Подсказка «приложите подпись»
     * заставила бы сотрудника искать, чем её приложить, вместо того чтобы выдать
     * заказ: переход и без неё пройдёт.
     */
    expect(signatureHint('COMPLETED', false)).toBeNull();
    expect(signatureHint('COMPLETED', true)).toBeNull();
  });
});

describe('Можно ли отправить переход', () => {
  it('переход без требования подписи отправляется сразу', () => {
    expect(
      canSubmitTransition({
        to: 'IN_WORK',
        hasSignature: false,
        signatureFile: null,
        signatureUploading: false,
      }),
    ).toBe(true);
  });

  it('ВЫДАЧА БЕЗ ПОДПИСИ отправляется', () => {
    /*
     * ГЛАВНАЯ проверка снятия требования: прежде выдача без файла блокировалась в
     * форме, теперь она не должна мешать — сервер подпись не проверяет.
     */
    expect(
      canSubmitTransition({
        to: 'COMPLETED',
        hasSignature: false,
        signatureFile: null,
        signatureUploading: false,
      }),
    ).toBe(true);
  });

  it('выдача с выбранным файлом тоже отправляется', () => {
    // Подпись прикладывают по желанию: её наличие ничего не меняет в отправке.
    expect(
      canSubmitTransition({
        to: 'COMPLETED',
        hasSignature: false,
        signatureFile: fakeFile(1024, 'image/png'),
        signatureUploading: false,
      }),
    ).toBe(true);
  });

  it('пока идёт загрузка, переход не отправляется', () => {
    /*
     * Единственное, что теперь задерживает отправку: если переход уйдёт раньше,
     * чем сохранится подпись, файл окажется не привязан к заказу, а сотрудник
     * будет уверен, что отметка о получении есть.
     */
    expect(
      canSubmitTransition({
        to: 'COMPLETED',
        hasSignature: true,
        signatureFile: null,
        signatureUploading: true,
      }),
    ).toBe(false);
  });

  it('без выбранного статуса отправлять нечего', () => {
    expect(
      canSubmitTransition({
        to: '',
        hasSignature: true,
        signatureFile: null,
        signatureUploading: false,
      }),
    ).toBe(false);
  });
});

describe('Проверка файла подписи', () => {
  const MAX = 10 * 1024 * 1024;

  it('принимает изображение и PDF', () => {
    // PDF допускается: подпись может прийти сканом с бумажного носителя.
    expect(validateSignatureFile(fakeFile(1024, 'image/png'), MAX)).toEqual({ ok: true });
    expect(validateSignatureFile(fakeFile(1024, 'image/jpeg'), MAX)).toEqual({ ok: true });
    expect(validateSignatureFile(fakeFile(1024, 'application/pdf'), MAX)).toEqual({ ok: true });
  });

  it('отклоняет пустой файл', () => {
    // Пустой файл прошёл бы проверку размера и «сохранился» бы как подпись,
    // которой нет.
    const result = validateSignatureFile(fakeFile(0, 'image/png'), MAX);
    expect(result.ok).toBe(false);
  });

  it('отклоняет слишком большой файл', () => {
    const result = validateSignatureFile(fakeFile(MAX + 1, 'image/png'), MAX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('МБ');
  });

  it('отклоняет посторонний формат', () => {
    // Произвольный файл в карточке заказа бесполезен при разбирательстве.
    const result = validateSignatureFile(fakeFile(1024, 'application/zip'), MAX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('изображение');
  });
});
