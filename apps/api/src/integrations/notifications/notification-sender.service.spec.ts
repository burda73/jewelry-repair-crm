/**
 * Тесты отправки уведомлений (задача 5.9).
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ. Очередь отправки — это место, где ошибка не видна
 * пользователю: уведомление либо уходит, либо нет, и никто не замечает второго.
 * Поэтому проверяются все четыре исхода прогона: успех, временная ошибка с
 * сохранением попыток, исчерпание попыток и пропуск из-за задержки.
 *
 * ОТДЕЛЬНО ПРОВЕРЯЕТСЯ, ЧТО ПОСТОЯННАЯ ОШИБКА НЕ ПОВТОРЯЕТСЯ. Это был реальный
 * дефект первой версии: при постоянной ошибке счётчик попыток увеличивался на
 * единицу, `canRetry(1)` оставался истинным, и воркер возвращался к безнадёжному
 * уведомлению каждые полминуты до конца работы системы.
 */

import { describe, expect, it, vi } from 'vitest';
import { MAX_SEND_ATTEMPTS, retryDelayMs } from '@app/shared';

import { NotificationSenderService } from './notification-sender.service';
import type { NotificationDispatcher } from './notification-dispatcher.service';

const NOW = new Date('2025-09-15T12:00:00.000Z');

interface Row {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  templateCode: string;
  status: string;
  attempts: number;
  lastAttemptAt: Date | null;
  createdAt: Date;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'n-1',
    channel: 'EMAIL',
    recipient: 'client@example.com',
    subject: 'Заказ готов',
    body: 'Текст',
    templateCode: 'READY_FOR_PICKUP',
    status: 'PENDING',
    attempts: 0,
    lastAttemptAt: null,
    createdAt: new Date('2025-09-15T11:00:00.000Z'),
    ...overrides,
  };
}

function makeService(rows: Row[], dispatch: ReturnType<typeof vi.fn>) {
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const prisma = {
    notification: {
      findMany: vi.fn(async () => rows),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return { ...rows[0], ...args.data };
      }),
    },
  };
  const dispatcher = {
    supportedChannels: () => ['IN_APP', 'EMAIL'],
    dispatch,
  } as unknown as NotificationDispatcher;

  return { service: new NotificationSenderService(prisma as never, dispatcher), updates, prisma };
}

describe('Отправка уведомлений (задача 5.9)', () => {
  it('успешная отправка переводит в SENT и проставляет время', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const { service, updates } = makeService([row()], dispatch);

    const result = await service.run(NOW);

    expect(result.sent).toBe(1);
    expect(updates[0].data.status).toBe('SENT');
    expect(updates[0].data.sentAt).toEqual(NOW);
    // Время попытки нужно для задержки следующих: без него повтор ушёл бы сразу.
    expect(updates[0].data.lastAttemptAt).toEqual(NOW);
  });

  it('текст шаблона передаётся в канал', async () => {
    // Проверка, что диспетчер получает подготовленное сообщение: подмена тела на
    // пустую строку означала бы письмо без текста.
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const { service } = makeService([row({ body: 'Изделие можно забрать' })], dispatch);

    await service.run(NOW);

    expect(dispatch).toHaveBeenCalledWith(
      'EMAIL',
      expect.objectContaining({ recipient: 'client@example.com', body: 'Изделие можно забрать' }),
    );
  });

  it('временная ошибка сохраняет возможность повтора', async () => {
    /*
     * Недоступная почта — штатная ситуация. Уведомление остаётся в `FAILED` с
     * числом попыток, и воркер вернётся к нему позже.
     */
    const dispatch = vi.fn(async () => ({ ok: false, error: 'таймаут', retryable: true }));
    const { service, updates } = makeService([row()], dispatch);

    const result = await service.run(NOW);

    expect(result.failed).toBe(1);
    expect(result.exhausted).toBe(0);
    expect(updates[0].data.attempts).toBe(1);
    expect(updates[0].data.status).toBe('FAILED');
  });

  it('постоянная ошибка сразу исчерпывает попытки', async () => {
    /*
     * РЕАЛЬНЫЙ ДЕФЕКТ первой версии. При постоянной ошибке счётчик увеличивался
     * на единицу (`attempts = 1`), `canRetry(1)` оставался истинным, и воркер
     * возвращался к безнадёжному уведомлению каждые полминуты — очередь росла
     * вечно, а в журнале каждые полминуты появлялась одна и та же ошибка.
     *
     * `attempts` ставится в предел СРАЗУ: повтор не изменит результата.
     */
    const dispatch = vi.fn(async () => ({
      ok: false,
      error: '550 адрес отвергнут',
      retryable: false,
    }));
    const { service, updates } = makeService([row()], dispatch);

    const result = await service.run(NOW);

    expect(result.exhausted).toBe(1);
    expect(result.failed).toBe(0);
    expect(updates[0].data.attempts).toBe(MAX_SEND_ATTEMPTS);
    // Проверка, что воркер действительно не вернётся: это и был дефект.
    expect(updates[0].data.attempts).toBeGreaterThanOrEqual(MAX_SEND_ATTEMPTS);
  });

  it('исчерпавшее попытки уведомление не отправляется', async () => {
    /*
     * Такая запись остаётся в журнале для разбора, но воркер её не берёт: иначе
     * очередь никогда не опустеет.
     */
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const { service, updates } = makeService([row({ status: 'FAILED', attempts: 3 })], dispatch);

    const result = await service.run(NOW);

    expect(dispatch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.exhausted).toBe(1);
    expect(result.sent).toBe(0);
  });

  it('повтор откладывается на задержку', async () => {
    /*
     * Без задержки три попытки уложились бы в миллисекунды и все пришлись бы на
     * тот же момент недоступности. Смысл повтора — дождаться восстановления.
     */
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const justFailed = new Date(NOW.getTime() - 1_000);
    const { service } = makeService(
      [row({ status: 'FAILED', attempts: 1, lastAttemptAt: justFailed })],
      dispatch,
    );

    const result = await service.run(NOW);

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('по истечении задержки повтор выполняется', async () => {
    // Обратная проверка: задержка не должна превращаться в «никогда».
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const waited = new Date(NOW.getTime() - retryDelayMs(1));
    const { service } = makeService(
      [row({ status: 'FAILED', attempts: 1, lastAttemptAt: waited })],
      dispatch,
    );

    const result = await service.run(NOW);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('задержка считается от последней попытки, а не от создания', async () => {
    /*
     * Создание было час назад, но попытка — десять секунд назад. Если считать от
     * создания, повтор ушёл бы немедленно, и три попытки уложились бы в секунды:
     * вся политика повторов оказалась бы фиктивной.
     */
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const recent = new Date(NOW.getTime() - 10_000);
    const { service } = makeService(
      [
        row({
          status: 'FAILED',
          attempts: 2,
          createdAt: new Date(NOW.getTime() - 3_600_000),
          lastAttemptAt: recent,
        }),
      ],
      dispatch,
    );

    const result = await service.run(NOW);

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('первое уведомление отправляется сразу', async () => {
    // `lastAttemptAt` пуст, пока попыток не было: ждать нечего.
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const { service } = makeService([row({ attempts: 0, lastAttemptAt: null })], dispatch);

    await service.run(NOW);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('выбираются только своевременные каналы', async () => {
    /*
     * Уведомления SMS не должны попадать в выборку: адаптера для них нет, и
     * воркер только забивал бы очередь отказами каждые полминуты.
     */
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const { service, prisma } = makeService([row()], dispatch);

    await service.run(NOW);

    const where = prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.channel.in).toEqual(['IN_APP', 'EMAIL']);
    expect(where.channel.in).not.toContain('SMS');
  });

  it('прочитанные уведомления не отправляются', async () => {
    // `READ` — уведомление в приложении уже доставлено; письмо ему не нужно.
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const { service, prisma } = makeService([row()], dispatch);

    await service.run(NOW);

    const where = prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.status.in).toContain('PENDING');
    expect(where.status.in).toContain('FAILED');
    expect(where.status.in).not.toContain('READ');
    expect(where.status.in).not.toContain('SENT');
  });

  it('ошибка одного уведомления не мешает остальным', async () => {
    /*
     * Цикл отправки не должен прерываться на первой неудаче: иначе одно письмо с
     * неверным адресом лишало бы уведомлений всех остальных получателей.
     */
    const rows = [row({ id: 'n-1' }), row({ id: 'n-2', recipient: 'ok@example.com' })];
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: '550', retryable: false })
      .mockResolvedValueOnce({ ok: true, error: null, retryable: false });
    const { service, updates } = makeService(rows, dispatch);

    const result = await service.run(NOW);

    expect(result.exhausted).toBe(1);
    expect(result.sent).toBe(1);
    expect(updates).toHaveLength(2);
  });

  it('текст ошибки сохраняется для разбора', async () => {
    // Без него в журнале будет «ошибка отправки», а не причина: разбираться
    // придётся по логам почтового сервера.
    const dispatch = vi.fn(async () => ({
      ok: false,
      error: 'SMTP 550: адрес не существует',
      retryable: false,
    }));
    const { service, updates } = makeService([row()], dispatch);

    await service.run(NOW);

    expect(String(updates[0].data.error)).toContain('адрес не существует');
  });

  it('итог содержит число пропущенных и исчерпанных', async () => {
    // Эти числа попадают в журнал воркера: без них «обработано 0» не отличить от
    // «воркер не работает».
    const dispatch = vi.fn(async () => ({ ok: true, error: null, retryable: false }));
    const { service } = makeService(
      [
        row({
          id: 'a',
          status: 'FAILED',
          attempts: 1,
          lastAttemptAt: new Date(NOW.getTime() - 1000),
        }),
        row({ id: 'b', status: 'FAILED', attempts: 3 }),
      ],
      dispatch,
    );

    const result = await service.run(NOW);

    expect(result.skipped).toBe(1);
    expect(result.exhausted).toBe(1);
    expect(result.scanned).toBe(0);
  });
});
