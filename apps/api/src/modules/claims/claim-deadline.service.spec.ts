/**
 * Тесты предупреждения о сроке рекламации (задача 6.6, ТЗ п. 2.9).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Ошибка здесь тихая: воркер ничего не ломает, просто
 * предупреждение не уходит — и срок 10 рабочих дней истекает незамеченным.
 * Проверяются правила, которых не видно в схеме:
 *
 *  * отметка ставится ПОСЛЕ успешной рассылки: иначе сбой отправки оставил бы
 *    рекламацию без предупреждения навсегда, потому что повторный прогон её уже
 *    не выберет;
 *  * рекламация без рассматривающего не считается предупреждённой: отметка на
 *    ней скрыла бы её от следующего прогона, когда рассматривающий появится;
 *  * предупреждение уходит адресату-рассматривающему, а не всем менеджерам.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimDeadlineService } from './claim-deadline.service';

const CLAIM_ID = 'cmu5p70yu0001bm7pzqlcawsw';
const REVIEWER_ID = 'cmu4cpwbg000bdl0ubltmh740';
const ORDER_ID = 'cmu5p70yu0002bm7pzqlcawsw';
const DUE_AT = new Date('2025-09-29T09:00:00.000Z');

function createHarness() {
  const prisma = {
    warrantyClaim: {
      findUnique: vi.fn(async () => ({
        reviewerId: REVIEWER_ID,
        reviewer: { id: REVIEWER_ID, email: 'manager@remixgold.ru' },
      })),
    },
  };

  const claims = {
    findNeedingWarning: vi.fn(async () => [
      { id: CLAIM_ID, claimNo: 'РЕК-25-00001', dueAt: DUE_AT, orderId: ORDER_ID },
    ]),
    markWarningSent: vi.fn(async () => undefined),
  };

  const notifications = { notifyStaff: vi.fn(async () => ({ inApp: null, email: null })) };

  const service = new ClaimDeadlineService(
    prisma as never,
    claims as never,
    notifications as never,
  );

  return { service, prisma, claims, notifications };
}

describe('Предупреждение о сроке рекламации', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    h = createHarness();
  });

  it('отправляет уведомление рассматривающему', async () => {
    const result = await h.service.run();

    expect(result.warned).toBe(1);
    expect(h.notifications.notifyStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CLAIM_DEADLINE',
        userId: REVIEWER_ID,
        email: 'manager@remixgold.ru',
      }),
    );
  });

  it('подставляет номер рекламации и дату срока', async () => {
    await h.service.run();

    const values = h.notifications.notifyStaff.mock.calls[0]![0].values;
    expect(values).toMatchObject({ claimNo: 'РЕК-25-00001', dueDate: '2025-09-29' });
  });

  it('ставит отметку после отправки', async () => {
    const order: string[] = [];
    h.notifications.notifyStaff.mockImplementation(async () => {
      order.push('notify');
      return { inApp: null, email: null };
    });
    h.claims.markWarningSent.mockImplementation(async () => {
      order.push('mark');
    });

    await h.service.run();

    // Отметка строго после: иначе сбой отправки скрыл бы рекламацию навсегда.
    expect(order).toEqual(['notify', 'mark']);
  });

  it('НЕ ставит отметку, если отправка упала', async () => {
    h.notifications.notifyStaff.mockRejectedValue(new Error('SMTP недоступен'));

    await expect(h.service.run()).rejects.toThrow('SMTP недоступен');
    expect(h.claims.markWarningSent).not.toHaveBeenCalled();
  });

  it('не ставит отметку рекламации без рассматривающего', async () => {
    h.prisma.warrantyClaim.findUnique.mockResolvedValue({ reviewerId: null, reviewer: null });

    const result = await h.service.run();

    expect(result.warned).toBe(0);
    expect(result.withoutReviewer).toBe(1);
    // Отметка скрыла бы рекламацию от следующего прогона, когда её возьмут.
    expect(h.claims.markWarningSent).not.toHaveBeenCalled();
    expect(h.notifications.notifyStaff).not.toHaveBeenCalled();
  });

  it('считает просмотренные рекламации', async () => {
    const result = await h.service.run();

    expect(result.scanned).toBe(1);
  });

  it('ничего не делает, когда срок далёк', async () => {
    h.claims.findNeedingWarning.mockResolvedValue([]);

    const result = await h.service.run();

    expect(result).toEqual({ scanned: 0, warned: 0, withoutReviewer: 0 });
    expect(h.notifications.notifyStaff).not.toHaveBeenCalled();
  });
});
