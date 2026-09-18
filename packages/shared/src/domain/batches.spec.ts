/**
 * Тесты правил включения заказов в партию (задача 2.1).
 *
 * ЧТО ЗАЩИЩАЮТ ЭТИ ПРАВИЛА. Партия — это физическая перевозка изделий клиентов
 * с актом приёма-передачи. Ошибка в правилах приводит к тому, что в акт попадает
 * изделие, которого у отправителя нет, или один заказ уезжает в двух партиях
 * одновременно и его статус переводится дважды. Поэтому проверяется каждое
 * условие отказа по отдельности и то, что причина возвращается машиночитаемым
 * кодом (интерфейс показывает её приёмщику).
 */

import { describe, expect, it } from 'vitest';
import {
  BATCH_DIRECTION,
  BATCH_INELIGIBILITY,
  checkBatchEligibility,
  exceedsBatchLimit,
  isReadyForDispatch,
  isReadyForStoreDelivery,
  partitionBatchCandidates,
  type BatchCandidateOrder,
} from './batches.js';

/** Заказ, готовый к отправке в цех. */
function dispatchable(overrides: Partial<BatchCandidateOrder> = {}): BatchCandidateOrder {
  return {
    id: 'cmu4cpwbg000bdl0ubltmh740',
    orderNo: 'MSK1-2609-000001',
    status: 'QUEUED_FOR_DISPATCH',
    createdStoreId: 'store-msk1',
    pickupStoreId: 'store-msk1',
    workshopId: null,
    ...overrides,
  };
}

/** Заказ, готовый к возврату в магазин. */
function returnable(overrides: Partial<BatchCandidateOrder> = {}): BatchCandidateOrder {
  return {
    id: 'cmu4cpwbg000bdl0ubltmh741',
    orderNo: 'MSK1-2609-000002',
    status: 'IN_TRANSIT_TO_STORE',
    createdStoreId: 'store-msk1',
    pickupStoreId: 'store-msk1',
    workshopId: 'workshop-1',
    ...overrides,
  };
}

describe('Партия в цех: подходящий заказ', () => {
  it('заказ «в очереди на отправку» подходит', () => {
    const verdict = checkBatchEligibility({
      order: dispatchable(),
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      fromStoreId: 'store-msk1',
      toWorkshopId: 'workshop-1',
    });

    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.message).toBeNull();
  });

  it('заказ без назначенного цеха подходит в любой цех', () => {
    // Цех выбирает логист при формировании партии; отсутствие назначения —
    // не препятствие.
    const verdict = checkBatchEligibility({
      order: dispatchable({ workshopId: null }),
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      toWorkshopId: 'workshop-1',
    });

    expect(verdict.eligible).toBe(true);
  });
});

describe('Партия в цех: отказы', () => {
  it('отклоняет заказ в неподходящем статусе', () => {
    // В цех едет только то, что дождалось отправки: заказ в производстве уже
    // в цехе, а принятый ещё не прошёл предоплату.
    for (const status of ['ACCEPTED', 'IN_PRODUCTION', 'DRAFT', 'COMPLETED'] as const) {
      const verdict = checkBatchEligibility({
        order: dispatchable({ status }),
        direction: BATCH_DIRECTION.TO_PRODUCTION,
      });

      expect(verdict.eligible, status).toBe(false);
      expect(verdict.reason, status).toBe(BATCH_INELIGIBILITY.WRONG_STATUS);
      expect(verdict.message, status).toBeTruthy();
    }
  });

  it('отклоняет заказ, принятый в другом магазине', () => {
    // Машина забирает изделия с одной точки: заказ из другого магазина
    // физически лежит там, и в акте его быть не может.
    const verdict = checkBatchEligibility({
      order: dispatchable({ createdStoreId: 'store-spb1' }),
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      fromStoreId: 'store-msk1',
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(BATCH_INELIGIBILITY.WRONG_STORE);
  });

  it('отклоняет заказ, закреплённый за другим цехом', () => {
    const verdict = checkBatchEligibility({
      order: dispatchable({ workshopId: 'workshop-2' }),
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      fromStoreId: 'store-msk1',
      toWorkshopId: 'workshop-1',
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(BATCH_INELIGIBILITY.WRONG_WORKSHOP);
  });

  it('отклоняет заказ, уже лежащий в активной партии', () => {
    // Иначе заказ уехал бы в двух партиях, и статус перевели бы дважды.
    const order = dispatchable();
    const verdict = checkBatchEligibility({
      order,
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      alreadyInIds: new Set([order.id]),
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(BATCH_INELIGIBILITY.ALREADY_IN_BATCH);
  });

  it('проверка «уже в партии» выполняется раньше проверки статуса', () => {
    // Причина важна: «уже в партии» подсказывает логисту, где искать заказ,
    // тогда как «не тот статус» отправила бы его разбираться со статусами.
    const order = dispatchable({ status: 'COMPLETED' });
    const verdict = checkBatchEligibility({
      order,
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      alreadyInIds: new Set([order.id]),
    });

    expect(verdict.reason).toBe(BATCH_INELIGIBILITY.ALREADY_IN_BATCH);
  });
});

describe('Партия в магазин: отказы и допуски', () => {
  it('заказ «в пути в магазин» подходит', () => {
    const verdict = checkBatchEligibility({
      order: returnable(),
      direction: BATCH_DIRECTION.TO_STORE,
    });

    expect(verdict.eligible).toBe(true);
  });

  it('отклоняет заказ в неподходящем статусе', () => {
    for (const status of ['IN_PRODUCTION', 'READY_FOR_PICKUP', 'COMPLETED'] as const) {
      const verdict = checkBatchEligibility({
        order: returnable({ status }),
        direction: BATCH_DIRECTION.TO_STORE,
      });

      expect(verdict.eligible, status).toBe(false);
      expect(verdict.reason, status).toBe(BATCH_INELIGIBILITY.WRONG_STATUS);
    }
  });

  it('отклоняет возврат в тот же магазин', () => {
    // Изделие уже числится в этом магазине — везти нечего.
    const verdict = checkBatchEligibility({
      order: returnable({ createdStoreId: 'store-msk1' }),
      direction: BATCH_DIRECTION.TO_STORE,
      fromStoreId: 'store-msk1',
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(BATCH_INELIGIBILITY.SAME_STORE);
  });

  it('заказ, принятый в другом магазине, можно вернуть в магазин приёма', () => {
    // Приём в MSK1, выдача в MSK2: обратный рейс в MSK1 допустим.
    const verdict = checkBatchEligibility({
      order: returnable({ createdStoreId: 'store-spb1' }),
      direction: BATCH_DIRECTION.TO_STORE,
      fromStoreId: 'store-msk1',
    });

    expect(verdict.eligible).toBe(true);
  });
});

describe('Статусы готовности', () => {
  it('в цех готов только QUEUED_FOR_DISPATCH', () => {
    expect(isReadyForDispatch('QUEUED_FOR_DISPATCH')).toBe(true);
    expect(isReadyForDispatch('ACCEPTED')).toBe(false);
    expect(isReadyForDispatch('IN_PRODUCTION')).toBe(false);
  });

  it('в магазин готов только IN_TRANSIT_TO_STORE', () => {
    expect(isReadyForStoreDelivery('IN_TRANSIT_TO_STORE')).toBe(true);
    expect(isReadyForStoreDelivery('READY_FOR_PICKUP')).toBe(false);
    expect(isReadyForStoreDelivery('IN_PRODUCTION')).toBe(false);
  });
});

describe('Разбор списка заказов', () => {
  it('разделяет подходящие и отклонённые, сохраняя причину', () => {
    // Интерфейс обязан показать причину по каждому заказу: иначе приёмщик
    // видит, что «заказ не добавился», и не понимает почему.
    const good = dispatchable({ id: 'cmu4cpwbg000bdl0ubltmh742' });
    const badStatus = dispatchable({ id: 'cmu4cpwbg000bdl0ubltmh743', status: 'ACCEPTED' });
    const inBatch = dispatchable({ id: 'cmu4cpwbg000bdl0ubltmh744' });

    const result = partitionBatchCandidates({
      orders: [good, badStatus, inBatch],
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      fromStoreId: 'store-msk1',
      alreadyInIds: new Set([inBatch.id]),
    });

    expect(result.eligible.map((o) => o.id)).toEqual([good.id]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.map((r) => r.reason).sort()).toEqual([
      BATCH_INELIGIBILITY.ALREADY_IN_BATCH,
      BATCH_INELIGIBILITY.WRONG_STATUS,
    ]);
    expect(result.rejected.every((r) => r.message !== '')).toBe(true);
  });

  it('пустой список даёт пустой результат', () => {
    const result = partitionBatchCandidates({
      orders: [],
      direction: BATCH_DIRECTION.TO_PRODUCTION,
    });

    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe('Лимит партии', () => {
  it('по умолчанию лимита нет', () => {
    // Лимит не задан ни в ТЗ, ни в документации: включённый «на глазок» он
    // блокировал бы работу точки.
    expect(exceedsBatchLimit(1000, null)).toBe(false);
  });

  it('превышение лимита определяется', () => {
    expect(exceedsBatchLimit(51, 50)).toBe(true);
    expect(exceedsBatchLimit(50, 50)).toBe(false);
    expect(exceedsBatchLimit(49, 50)).toBe(false);
  });
});
