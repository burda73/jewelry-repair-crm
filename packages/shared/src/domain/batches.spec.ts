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
  BATCH_STATUS,
  batchCompositionLockReason,
  batchDispatchLockReason,
  batchOrderTargetStatus,
  batchPhotoDeleteLockReason,
  batchPhotoUploadLockReason,
  batchReceiveLockReason,
  buildBatchActSnapshot,
  canDeleteBatchPhoto,
  canDispatchBatch,
  canReceiveBatch,
  canUploadBatchPhoto,
  isBatchCompositionEditable,
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

  it('заказ, принятый и выдаваемый в магазине назначения, подходит', () => {
    // Основной сценарий «где приняли, там и выдаём»: изделие едет в тот же
    // магазин, где его приняли. Прежняя реализация отклоняла этот случай как
    // «заказ уже числится в этом магазине» — собрать обратную партию было
    // невозможно (дефект 62).
    const verdict = checkBatchEligibility({
      order: returnable({ createdStoreId: 'store-msk1', pickupStoreId: 'store-msk1' }),
      direction: BATCH_DIRECTION.TO_STORE,
      toStoreId: 'store-msk1',
    });

    expect(verdict.eligible).toBe(true);
    expect(verdict.warning).toBeNull();
  });

  it('заказ, принятый в другом магазине, подходит с замечанием', () => {
    // Приём в MSK2, выдача в MSK1: контроль «где приняли, там и выдаём» —
    // зона менеджера, поэтому расхождение показывается, но не блокирует.
    const verdict = checkBatchEligibility({
      order: returnable({ createdStoreId: 'store-spb1', pickupStoreId: 'store-msk1' }),
      direction: BATCH_DIRECTION.TO_STORE,
      toStoreId: 'store-msk1',
    });

    expect(verdict.eligible).toBe(true);
    expect(verdict.warning).toMatch(/принят в другом магазине/);
  });

  it('отклоняет заказ, выдаваемый не в том магазине, куда едет партия', () => {
    // Партия едет в MSK2, а изделие клиент забирает в MSK1: машина привезёт его
    // не туда, где его ждут. Это запрет, в отличие от расхождения магазина
    // приёма (см. следующий тест).
    const verdict = checkBatchEligibility({
      order: returnable({ createdStoreId: 'store-msk1', pickupStoreId: 'store-msk1' }),
      direction: BATCH_DIRECTION.TO_STORE,
      toStoreId: 'store-msk2',
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(BATCH_INELIGIBILITY.WRONG_DELIVERY_STORE);
  });

  it('заказ, принятый в другом магазине, можно вернуть в магазин приёма', () => {
    // Приём в MSK2, выдача в MSK2, рейс в MSK2: заказ доедет туда, где его
    // и принимали, и где будут выдавать. Направление задаётся `toStoreId`.
    const verdict = checkBatchEligibility({
      order: returnable({ createdStoreId: 'store-spb1', pickupStoreId: 'store-spb1' }),
      direction: BATCH_DIRECTION.TO_STORE,
      toStoreId: 'store-spb1',
    });

    expect(verdict.eligible).toBe(true);
    expect(verdict.warning).toBeNull();
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

describe('Замыкание состава партии (задача 2.2)', () => {
  it('состав правится только в черновике', () => {
    // После акта состав заморожен: акт — документ о передаче конкретных
    // изделий, и правка состава после подписания сделала бы его недостоверным.
    expect(isBatchCompositionEditable(BATCH_STATUS.DRAFT)).toBe(true);
    expect(isBatchCompositionEditable(BATCH_STATUS.ACT_FORMED)).toBe(false);
    expect(isBatchCompositionEditable(BATCH_STATUS.IN_TRANSIT)).toBe(false);
    expect(isBatchCompositionEditable(BATCH_STATUS.RECEIVED)).toBe(false);
    expect(isBatchCompositionEditable(BATCH_STATUS.CANCELLED)).toBe(false);
  });

  it('каждому закрытому статусу соответствует понятная причина', () => {
    // Текст показывается логисту: «нельзя» без объяснения заставляет искать
    // причину в другом месте.
    for (const status of [
      BATCH_STATUS.ACT_FORMED,
      BATCH_STATUS.IN_TRANSIT,
      BATCH_STATUS.RECEIVED,
      BATCH_STATUS.CANCELLED,
    ] as const) {
      const reason = batchCompositionLockReason(status);
      expect(reason, status).toBeTruthy();
      expect(reason, status).not.toBe('');
    }
  });

  it('для черновика причины отказа нет', () => {
    expect(batchCompositionLockReason(BATCH_STATUS.DRAFT)).toBeNull();
  });
});

describe('Снимок состава для акта (задача 2.2)', () => {
  const items = [
    {
      orderId: 'o2',
      orderNo: 'MSK1-2609-000002',
      customerName: 'Петров П.П.',
      totalAmountMinor: 5000,
    },
    {
      orderId: 'o1',
      orderNo: 'MSK1-2609-000001',
      customerName: 'Иванов И.И.',
      totalAmountMinor: 10000,
    },
  ];

  it('сортирует заказы по номеру', () => {
    // Порядок в акте должен быть предсказуем и одинаков при каждой печати:
    // иначе два экземпляра одного документа выглядели бы по-разному.
    const snapshot = buildBatchActSnapshot({
      batchNo: 'П-250916-004',
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      fromLabel: 'Магазин на Тверской',
      toLabel: 'Центральный цех',
      formedAt: new Date('2025-09-16T07:00:00Z'),
      items,
    });

    expect(snapshot.items.map((i) => i.orderNo)).toEqual(['MSK1-2609-000001', 'MSK1-2609-000002']);
  });

  it('считает число заказов и общую сумму', () => {
    const snapshot = buildBatchActSnapshot({
      batchNo: 'П-250916-004',
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      fromLabel: 'Магазин',
      toLabel: 'Цех',
      formedAt: new Date('2025-09-16T07:00:00Z'),
      items,
    });

    expect(snapshot.itemsCount).toBe(2);
    // Сумма в копейках: 10000 + 5000.
    expect(snapshot.totalAmountMinor).toBe(15000);
  });

  it('фиксирует момент формирования строкой ISO', () => {
    // Снимок уходит в `Json`-поле, поэтому дата хранится строкой: объект Date
    // сериализовался бы по-разному в зависимости от драйвера.
    const snapshot = buildBatchActSnapshot({
      batchNo: 'П-250916-004',
      direction: BATCH_DIRECTION.TO_STORE,
      fromLabel: 'Цех',
      toLabel: 'Магазин',
      formedAt: new Date('2025-09-16T07:00:00Z'),
      items,
    });

    expect(snapshot.formedAt).toBe('2025-09-16T07:00:00.000Z');
    expect(snapshot.direction).toBe(BATCH_DIRECTION.TO_STORE);
  });

  it('пустой состав даёт нулевую сумму, а не NaN', () => {
    // Пустой состав до акта не доходит (сервис запрещает), но функция не должна
    // возвращать NaN: это значение ушло бы в документ.
    const snapshot = buildBatchActSnapshot({
      batchNo: 'П-250916-004',
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      fromLabel: 'Магазин',
      toLabel: 'Цех',
      formedAt: new Date('2025-09-16T07:00:00Z'),
      items: [],
    });

    expect(snapshot.itemsCount).toBe(0);
    expect(snapshot.totalAmountMinor).toBe(0);
  });

  it('копирует строки, а не хранит ссылку на исходный массив', () => {
    // Снимок не должен меняться вслед за источником: иначе смысл снимка теряется.
    const source = [...items];
    const snapshot = buildBatchActSnapshot({
      batchNo: 'П-250916-004',
      direction: BATCH_DIRECTION.TO_PRODUCTION,
      fromLabel: 'Магазин',
      toLabel: 'Цех',
      formedAt: new Date('2025-09-16T07:00:00Z'),
      items: source,
    });

    source.push({
      orderId: 'o3',
      orderNo: 'MSK1-2609-000003',
      customerName: 'Сидоров',
      totalAmountMinor: 1,
    });

    expect(snapshot.itemsCount).toBe(2);
    expect(snapshot.totalAmountMinor).toBe(15000);
  });
});

describe('Фотофиксация партии (задача 2.4)', () => {
  /*
   * Снимок — доказательство состояния изделий и тары на момент передачи. При
   * споре решает не подпись (её ставят, не разглядывая каждый пакет), а
   * фотография с датой и автором. Поэтому важны обе границы: до отправки фото
   * можно и добавить, и убрать; после отправки — только добавить.
   */

  it('фото можно добавить в черновик и после акта', () => {
    // Основной случай: логист фотографирует партию перед отправкой.
    expect(canUploadBatchPhoto(BATCH_STATUS.DRAFT)).toBe(true);
    expect(canUploadBatchPhoto(BATCH_STATUS.ACT_FORMED)).toBe(true);
  });

  it('фото можно добавить в пути и при приёмке', () => {
    /*
     * Снимок при приёмке так же ценен, как при отправке: он фиксирует, в каком
     * виде партия доехала, и разбирает спор «повредили в дороге или сдали
     * такими». Запрет на загрузку лишил бы получателя возможности зафиксировать
     * расхождение.
     */
    expect(canUploadBatchPhoto(BATCH_STATUS.IN_TRANSIT)).toBe(true);
    expect(canUploadBatchPhoto(BATCH_STATUS.RECEIVED)).toBe(true);
  });

  it('в отменённой партии фото не добавляются', () => {
    // Перевозки не было — фиксировать нечего.
    expect(canUploadBatchPhoto(BATCH_STATUS.CANCELLED)).toBe(false);
    expect(batchPhotoUploadLockReason(BATCH_STATUS.CANCELLED)).toContain('отменена');
  });

  it('удалять фото можно только до отправки', () => {
    /*
     * После отъезда фото — часть записи о передаче. Пропавшее задним числом
     * доказательство хуже, чем его отсутствие: невозможно понять, было ли фото
     * вообще.
     */
    expect(canDeleteBatchPhoto(BATCH_STATUS.DRAFT)).toBe(true);
    expect(canDeleteBatchPhoto(BATCH_STATUS.ACT_FORMED)).toBe(true);
    expect(canDeleteBatchPhoto(BATCH_STATUS.IN_TRANSIT)).toBe(false);
    expect(canDeleteBatchPhoto(BATCH_STATUS.RECEIVED)).toBe(false);
  });

  it('причина запрета удаления различает «в пути» и «принята»', () => {
    // В пути фото ещё можно переснять и дополнить, после приёмки запись
    // закрыта. Одинаковый текст сбивал бы логиста с толку.
    expect(batchPhotoDeleteLockReason(BATCH_STATUS.IN_TRANSIT)).toContain('добавьте новое');
    expect(batchPhotoDeleteLockReason(BATCH_STATUS.RECEIVED)).toContain('принята');
  });

  it('разрешающие статусы не возвращают причину отказа', () => {
    // Иначе интерфейс показывал бы запрет там, где действие разрешено.
    for (const status of [BATCH_STATUS.DRAFT, BATCH_STATUS.ACT_FORMED]) {
      expect(batchPhotoUploadLockReason(status)).toBeNull();
      expect(batchPhotoDeleteLockReason(status)).toBeNull();
    }
    for (const status of [BATCH_STATUS.IN_TRANSIT, BATCH_STATUS.RECEIVED]) {
      expect(batchPhotoUploadLockReason(status)).toBeNull();
    }
  });

  it('удаление запрещено там, где загрузка запрещена', () => {
    // Отменённая партия: добавлять нельзя, значит и удалять нечего.
    expect(canDeleteBatchPhoto(BATCH_STATUS.CANCELLED)).toBe(false);
    expect(batchPhotoDeleteLockReason(BATCH_STATUS.CANCELLED)).toContain('отменена');
  });
});

describe('Отправка и приём партии (задача 2.5)', () => {
  /*
   * Отправка переводит СРАЗУ все заказы партии в «в пути», приём — в
   * «в производстве» или «готов к выдаче». Ошибка здесь означает, что изделия
   * клиентов уехали без документа или заказ попал в ветку встречного рейса.
   */

  it('отправить можно только сформированную партию', () => {
    /*
     * Отправка партии без акта — перевозка изделий клиентов без документа: при
     * утрате нечем подтвердить, что именно и в каком виде приняли.
     */
    expect(canDispatchBatch(BATCH_STATUS.ACT_FORMED)).toBe(true);
    expect(canDispatchBatch(BATCH_STATUS.DRAFT)).toBe(false);
    expect(batchDispatchLockReason(BATCH_STATUS.DRAFT)).toContain('акт');
  });

  it('повторная отправка отклоняется', () => {
    // Иначе заказы второй раз перешли бы в «в пути», а партия «уехала» дважды.
    expect(canDispatchBatch(BATCH_STATUS.IN_TRANSIT)).toBe(false);
    expect(batchDispatchLockReason(BATCH_STATUS.IN_TRANSIT)).toContain('уже отправлена');
  });

  it('принять можно только партию в пути', () => {
    // Приём партии, которая не уезжала, означал бы приём несуществующей
    // перевозки: заказы оказались бы «в производстве» без доставки.
    expect(canReceiveBatch(BATCH_STATUS.IN_TRANSIT)).toBe(true);
    expect(canReceiveBatch(BATCH_STATUS.DRAFT)).toBe(false);
    expect(canReceiveBatch(BATCH_STATUS.ACT_FORMED)).toBe(false);
    expect(batchReceiveLockReason(BATCH_STATUS.ACT_FORMED)).toContain('не отправлена');
  });

  it('повторный приём отклоняется', () => {
    expect(canReceiveBatch(BATCH_STATUS.RECEIVED)).toBe(false);
    expect(batchReceiveLockReason(BATCH_STATUS.RECEIVED)).toContain('уже принята');
  });

  it('отменённую партию нельзя ни отправить, ни принять', () => {
    expect(canDispatchBatch(BATCH_STATUS.CANCELLED)).toBe(false);
    expect(canReceiveBatch(BATCH_STATUS.CANCELLED)).toBe(false);
  });

  it('разрешающие статусы не возвращают причину отказа', () => {
    // Иначе интерфейс показывал бы запрет там, где действие разрешено.
    expect(batchDispatchLockReason(BATCH_STATUS.ACT_FORMED)).toBeNull();
    expect(batchReceiveLockReason(BATCH_STATUS.IN_TRANSIT)).toBeNull();
  });

  it('рейс в цех: отправка даёт IN_TRANSIT_TO_PRODUCTION, приём — ACCEPTED_BY_WORKSHOP', () => {
    /*
     * Ключевое различие: «в пути» для рейса в цех и из цеха — РАЗНЫЕ статусы, и
     * заказы этих рейсов движутся по разным веткам. Перепутать их значит
     * отправить заказ в цех, который ждёт его из цеха.
     *
     * Приём ведёт в «Принят цехом», а не в `IN_PRODUCTION` (задача 7.1): менеджер
     * должен видеть, какие заказы он получил, но ещё не распределил. Прежний
     * `IN_PRODUCTION` означал «в производстве вообще» и не различал «принят»,
     * «в работе» и «работа сдана» (дефект 63).
     */
    expect(batchOrderTargetStatus(BATCH_DIRECTION.TO_PRODUCTION, 'DISPATCH')).toBe(
      'IN_TRANSIT_TO_PRODUCTION',
    );
    expect(batchOrderTargetStatus(BATCH_DIRECTION.TO_PRODUCTION, 'RECEIVE')).toBe(
      'ACCEPTED_BY_WORKSHOP',
    );
  });

  it('рейс в магазин: отправка даёт IN_TRANSIT_TO_STORE, приём — READY_FOR_PICKUP', () => {
    expect(batchOrderTargetStatus(BATCH_DIRECTION.TO_STORE, 'DISPATCH')).toBe(
      'IN_TRANSIT_TO_STORE',
    );
    expect(batchOrderTargetStatus(BATCH_DIRECTION.TO_STORE, 'RECEIVE')).toBe('READY_FOR_PICKUP');
  });

  it('ветки направлений не пересекаются', () => {
    // Страховка от копипасты: четыре комбинации обязаны дать четыре разных
    // статуса, иначе одно из направлений ведёт не туда.
    const statuses = [
      batchOrderTargetStatus(BATCH_DIRECTION.TO_PRODUCTION, 'DISPATCH'),
      batchOrderTargetStatus(BATCH_DIRECTION.TO_PRODUCTION, 'RECEIVE'),
      batchOrderTargetStatus(BATCH_DIRECTION.TO_STORE, 'DISPATCH'),
      batchOrderTargetStatus(BATCH_DIRECTION.TO_STORE, 'RECEIVE'),
    ];
    expect(new Set(statuses).size).toBe(4);
  });
});
