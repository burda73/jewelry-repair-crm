/**
 * Тесты логики подписи клиента при выдаче (дефект 66).
 *
 * ДЕФЕКТ 66: поле `Order.pickupSignatureFileId` не заполнялось ничем, поэтому
 * переход в «Выдан» всегда отклонялся с `409 PICKUP_SIGNATURE_REQUIRED` — выдача
 * заказа, основной сценарий приложения, была невыполнима.
 *
 * Здесь проверяются правила интерфейса, от которых зависит выполнимость выдачи:
 * когда подпись обязана быть приложена, а когда её требование только мешает.
 */

import { describe, expect, it } from 'vitest';
import {
  canSubmitTransition,
  needsPickupSignature,
  signatureHint,
  validateSignatureFile,
} from './pickup-signature';

/** Двойник `File`: в окружении `node` конструктора `File` нет. */
function fakeFile(size: number, type: string): File {
  return { size, type, name: 'sign.png' } as unknown as File;
}

describe('Требуется ли подпись клиента (дефект 66)', () => {
  it('для выдачи без подписи — требуется', () => {
    /*
     * Главная проверка. Переход в «Выдан» охраняется условием
     * `PICKUP_SIGNATURE`; если интерфейс не попросит подпись заранее, сотрудник
     * получит 409 в момент, когда клиент уже стоит у стойки.
     */
    expect(needsPickupSignature('COMPLETED', false)).toBe(true);
  });

  it('для выдачи с уже приложенной подписью — не требуется', () => {
    // Повторная загрузка при каждой попытке перехода была бы бессмысленной
    // работой и раздражала бы сотрудника.
    expect(needsPickupSignature('COMPLETED', true)).toBe(false);
  });

  it('для остальных переходов подпись не требуется', () => {
    /*
     * Обратная ошибка — просить подпись при каждой смене статуса. Проверяются
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
      expect(needsPickupSignature(status, false), status).toBe(false);
    }
  });

  it('при переданной подписи подсказка не показывается', () => {
    expect(signatureHint('COMPLETED', true)).toBeNull();
  });

  it('без подписи подсказка объясняет причину', () => {
    // Недоступное действие без объяснения читается как поломка интерфейса.
    const hint = signatureHint('COMPLETED', false);
    expect(hint).not.toBeNull();
    expect(hint).toContain('подпись');
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

  it('выдача без подписи не отправляется', () => {
    // Отправка привела бы к 409 — и сотрудник решил бы, что система сломана.
    expect(
      canSubmitTransition({
        to: 'COMPLETED',
        hasSignature: false,
        signatureFile: null,
        signatureUploading: false,
      }),
    ).toBe(false);
  });

  it('выдача с выбранным файлом отправляется, даже если подпись ещё не загружена', () => {
    /*
     * Файл загружается ДО перехода: guard проверяет уже записанный
     * идентификатор, поэтому порядок «сначала файл, потом переход» обязателен.
     */
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
    // Иначе переход ушёл бы до записи файла и получил бы 409.
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
