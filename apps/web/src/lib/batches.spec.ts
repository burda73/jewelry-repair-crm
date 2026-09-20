/**
 * Тесты логики экрана партий (задача 7.6, дефект 58).
 *
 * ДЕФЕКТ 58: раздела партий в веб-приложении не было вообще. Партии можно было
 * создавать только через API, поэтому согласованная схема «магазин →
 * производство → магазин» на практике не выполнялась: приёмщик не мог отправить
 * изделия в цех, а менеджер — вернуть их в магазин.
 *
 * Почему проверяется ЛОГИКА, а не разметка. Веб-тесты работают в окружении
 * `node` и React не рендерят. Правила, от которых зависит корректность
 * операции, вынесены в чистые функции, и проверяются здесь. Ошибка в них стоит
 * дорого: кнопка «Отправить» на черновике без акта отправила бы партию без
 * передаточного документа, а потерянное предупреждение о чужом магазине —
 * изделие не в тот магазин.
 */

import { describe, expect, it } from 'vitest';
import { BATCH_DIRECTION } from '@app/shared';
import {
  BATCH_REJECTION_LABELS,
  BATCH_STATUS_LABELS,
  batchActions,
  batchActPdfPath,
  batchFiltersToQuery,
  batchRoute,
  batchStatusTone,
  candidateViews,
  dispatchConsequences,
  hasWarnings,
  isCreateBatchValid,
  receiveConsequences,
  validateCreateBatch,
} from './batches';
import type { BatchCandidateGroup } from './api-types';

const STORE_1 = 'cmu47z0xq0000ampvqypjgtrd';

describe('Действия по статусу партии (задача 7.6)', () => {
  it('в черновике можно менять состав и загружать фото, но нельзя отправить', () => {
    /*
     * Главная проверка безопасности операции. Отправка черновика означала бы
     * партию в пути БЕЗ акта приёма-передачи — то есть изделия уехали, а
     * документа о передаче нет. Именно это ограничение и должен выражать
     * интерфейс.
     */
    const actions = batchActions('DRAFT');
    expect(actions.canEditComposition).toBe(true);
    expect(actions.canUploadPhoto).toBe(true);
    expect(actions.canDispatch).toBe(false);
    expect(actions.canReceive).toBe(false);
    // Причина недоступности обязана быть: серая кнопка без объяснения
    // заставляет сотрудника гадать, чего не хватает.
    expect(actions.dispatchLockReason).not.toBeNull();
  });

  it('после формирования акта можно отправить, но состав уже не меняется', () => {
    const actions = batchActions('ACT_FORMED');
    expect(actions.canDispatch).toBe(true);
    expect(actions.canEditComposition).toBe(false);
    expect(actions.compositionLockReason).not.toBeNull();
  });

  it('в пути можно принять, но не отправить повторно', () => {
    const actions = batchActions('IN_TRANSIT');
    expect(actions.canReceive).toBe(true);
    expect(actions.canDispatch).toBe(false);
  });

  it('принятую партию нельзя ни отправить, ни принять повторно', () => {
    // Повторный приём перевёл бы заказы в «Готов к выдаче» второй раз.
    const actions = batchActions('RECEIVED');
    expect(actions.canDispatch).toBe(false);
    expect(actions.canReceive).toBe(false);
  });

  it('каждая недоступная операция объясняет причину', () => {
    // Обход всех статусов: новый статус не должен дать «немую» серую кнопку.
    for (const status of ['DRAFT', 'ACT_FORMED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED']) {
      const actions = batchActions(status);
      if (!actions.canDispatch) expect(actions.dispatchLockReason, status).not.toBeNull();
      if (!actions.canReceive) expect(actions.receiveLockReason, status).not.toBeNull();
      if (!actions.canEditComposition) {
        expect(actions.compositionLockReason, status).not.toBeNull();
      }
    }
  });
});

describe('Подписи и маршрут партии', () => {
  it('направления подписаны по-русски', () => {
    expect(BATCH_STATUS_LABELS.DRAFT).toBe('Черновик');
    expect(BATCH_STATUS_LABELS.ACT_FORMED).toBe('Акт сформирован');
    expect(BATCH_STATUS_LABELS.IN_TRANSIT).toBe('В пути');
    expect(BATCH_STATUS_LABELS.RECEIVED).toBe('Принята');
  });

  it('статус получает тон бейджа, а неизвестный — нейтральный', () => {
    expect(batchStatusTone('RECEIVED')).toBe('green');
    expect(batchStatusTone('IN_TRANSIT')).toBe('blue');
    expect(batchStatusTone('CANCELLED')).toBe('red');
    // Неизвестный статус не должен выглядеть как успех: новая версия API со
    // статусом, которого нет в старом клиенте, не соврёт о состоянии.
    expect(batchStatusTone('SOMETHING_NEW')).toBe('slate');
  });

  it('маршрут показывает магазин и получателя, а пустое — прочерком', () => {
    expect(
      batchRoute({
        fromStoreName: 'Магазин на Тверской',
        toStoreName: null,
        toWorkshopName: 'Центральный цех',
      }),
    ).toBe('Магазин на Тверской → Центральный цех');

    // Пустая строка читалась бы как «данные не загрузились».
    expect(batchRoute({ fromStoreName: null, toStoreName: null, toWorkshopName: null })).toBe(
      '— → —',
    );
  });
});

describe('Последствия массовой операции', () => {
  it('отправка сообщает, сколько заказов уедет и куда', () => {
    /*
     * Одно нажатие переводит десятки заказов, и отменить это одним действием
     * нельзя — сотрудник обязан видеть масштаб до подтверждения.
     */
    const text = dispatchConsequences(
      { itemsCount: 12, direction: BATCH_DIRECTION.TO_PRODUCTION },
      'В пути в цех',
    );
    expect(text).toContain('12');
    expect(text).toContain('в цех');
    expect(text).toContain('В пути в цех');
  });

  it('обратная партия говорит «в магазин», а не «в цех»', () => {
    // Перепутанное направление в подтверждении читалось бы как ошибка выбора.
    const text = dispatchConsequences(
      { itemsCount: 3, direction: BATCH_DIRECTION.TO_STORE },
      'В пути в магазин',
    );
    expect(text).toContain('в магазин');
    expect(text).not.toContain('в цех');
  });

  it('приём сообщает целевой статус заказов', () => {
    const text = receiveConsequences(
      {
        itemsCount: 2,
        items: [{ returnedWithoutWork: false }, { returnedWithoutWork: false }],
      },
      'Готов к выдаче',
      'Отказ до начала работ',
    );
    expect(text).toContain('Готов к выдаче');
    expect(text).not.toContain('Отказ до начала работ');
  });

  it('без состава приём не обещает конкретный статус (дефект 67)', () => {
    /*
     * Список партий приходит без состава, и в нём нельзя знать, вернулся ли
     * заказ без работ. Обещание «все перейдут в «Готов к выдаче»» было бы
     * неверным для отказа — а сотрудник, увидевший другое, решил бы, что
     * система сломалась.
     */
    const text = receiveConsequences({ itemsCount: 5 }, 'Готов к выдаче', 'Отказ до начала работ');
    expect(text).not.toContain('Готов к выдаче');
  });

  it('смешанный рейс честно говорит, сколько заказов закроется отказом (дефект 67)', () => {
    /*
     * Главная проверка текста: в одном рейсе едут изделия после работы и
     * возвращённые без работ. Молчание об отказе означало бы, что приёмка
     * «неожиданно» закрывает часть заказов.
     */
    const text = receiveConsequences(
      {
        itemsCount: 3,
        items: [
          { returnedWithoutWork: false },
          { returnedWithoutWork: true },
          { returnedWithoutWork: true },
        ],
      },
      'Готов к выдаче',
      'Отказ до начала работ',
    );
    expect(text).toContain('1 заказ(ов) сменит статус на «Готов к выдаче»');
    expect(text).toContain('2 — будет закрыто статусом «Отказ до начала работ»');
  });

  it('рейс только из отказов не упоминает «Готов к выдаче» (дефект 67)', () => {
    const text = receiveConsequences(
      { itemsCount: 1, items: [{ returnedWithoutWork: true }] },
      'Готов к выдаче',
      'Отказ до начала работ',
    );
    expect(text).not.toContain('Готов к выдаче');
    expect(text).toContain('Отказ до начала работ');
  });
});

describe('Подбор заказов: предупреждения и причины отказа (задача 7.4)', () => {
  const group: BatchCandidateGroup = {
    eligible: [
      { id: 'o-1', orderNo: 'MSK1-000001', status: 'WORK_COMPLETED' },
      {
        id: 'o-2',
        orderNo: 'MSK1-000002',
        status: 'WORK_COMPLETED',
        warning: 'Заказ принят в другом магазине — выдача будет в магазине, куда едет партия',
      },
    ],
    rejected: [
      {
        id: 'o-3',
        orderNo: 'MSK1-000003',
        reason: 'WRONG_DELIVERY_STORE',
        message: 'Заказ должен быть выдан в другом магазине',
      },
    ],
  };

  it('подходящие и отклонённые идут одним списком с разными отметками', () => {
    /*
     * Иначе сотрудник видит «заказ пропал» и не понимает, что он отклонён.
     * Отклонённый показывается с причиной, а не исчезает из списка.
     */
    const views = candidateViews(group);
    expect(views).toHaveLength(3);
    expect(views[0]?.rejectionLabel).toBeNull();
    expect(views[2]?.rejectionLabel).toBe(BATCH_REJECTION_LABELS.WRONG_DELIVERY_STORE);
  });

  it('предупреждение не превращается в отказ', () => {
    /*
     * Решение заказчика: контроль «где приняли, там и выдаём» — зона
     * ответственности менеджера, поэтому несовпадение магазина СООБЩАЕТСЯ, но
     * не блокирует. Превращение замечания в отказ сломало бы основной сценарий
     * возврата «где приняли, там и выдаём».
     */
    const views = candidateViews(group);
    const warned = views.find((v) => v.orderId === 'o-2');
    expect(warned?.warning).not.toBeNull();
    expect(warned?.rejectionLabel).toBeNull();
  });

  it('подсветка предупреждений включается только при их наличии', () => {
    expect(hasWarnings(group)).toBe(true);
    expect(
      hasWarnings({ eligible: [{ id: 'o-1', orderNo: 'A', status: 'S' }], rejected: [] }),
    ).toBe(false);
  });

  it('неизвестная причина отказа показывает сообщение сервера', () => {
    // Новая причина в API не должна давать пустую строку на экране.
    const views = candidateViews({
      eligible: [],
      rejected: [{ id: 'o-9', orderNo: 'A', reason: 'NEW_REASON', message: 'Пояснение сервера' }],
    });
    expect(views[0]?.rejectionLabel).toBe('Пояснение сервера');
  });
});

describe('Форма создания партии', () => {
  const base = {
    direction: BATCH_DIRECTION.TO_PRODUCTION,
    fromStoreId: STORE_1,
    toStoreId: '',
    toWorkshopId: 'cmu47z0zc0003ampv8ndixmui',
    plannedAt: '2026-09-25',
    comment: '',
  };

  it('принимает заполненную форму для цеха', () => {
    expect(isCreateBatchValid(base)).toBe(true);
  });

  it('требует цех для партии в цех и магазин — для партии в магазин', () => {
    /*
     * Партия «в цех» без цеха и «в магазин» без магазина выглядит допустимой,
     * но выполнить её нельзя. Сервер это тоже проверяет, но заведомо обречённый
     * запрос лучше не отправлять.
     */
    const noWorkshop = validateCreateBatch({ ...base, toWorkshopId: '' });
    expect(noWorkshop.toWorkshopId).toBeDefined();

    const toStoreNoTarget = validateCreateBatch({
      ...base,
      direction: BATCH_DIRECTION.TO_STORE,
      toWorkshopId: '',
      toStoreId: '',
    });
    expect(toStoreNoTarget.toStoreId).toBeDefined();
  });

  it('требует магазин отправления и плановую дату', () => {
    const errors = validateCreateBatch({ ...base, fromStoreId: '', plannedAt: '' });
    expect(errors.fromStoreId).toBeDefined();
    expect(errors.plannedAt).toBeDefined();
  });

  it('отклоняет слишком длинный комментарий', () => {
    const errors = validateCreateBatch({ ...base, comment: 'я'.repeat(1001) });
    expect(errors.comment).toBeDefined();
  });

  it('не требует магазин назначения для партии в цех', () => {
    // Иначе форма требовала бы поле, которого нет на экране.
    const errors = validateCreateBatch({ ...base, toStoreId: '' });
    expect(errors.toStoreId).toBeUndefined();
  });
});

describe('Фильтры списка партий', () => {
  it('пропускает пустые значения', () => {
    /*
     * `direction=` сервер попытается разобрать как направление и ответит
     * ошибкой валидации — то есть пустой фильтр сломал бы весь список.
     */
    expect(
      batchFiltersToQuery({ direction: '', status: '', fromStoreId: '', plannedOn: '' }),
    ).toEqual({});
  });

  it('передаёт заполненные фильтры', () => {
    expect(
      batchFiltersToQuery({
        direction: 'TO_STORE',
        status: 'IN_TRANSIT',
        fromStoreId: STORE_1,
        plannedOn: '2026-09-25',
      }),
    ).toEqual({
      direction: 'TO_STORE',
      status: 'IN_TRANSIT',
      fromStoreId: STORE_1,
      plannedOn: '2026-09-25',
    });
  });
});

describe('Печать реестра (акт)', () => {
  it('ссылка на PDF ведёт на маршрут акта партии', () => {
    // Это и есть «реестр отправляемых документов» из схемы заказчика.
    expect(batchActPdfPath('cmu8p6fku0008amsd0jpm7j3r')).toBe(
      '/api/v1/batches/cmu8p6fku0008amsd0jpm7j3r/act/pdf',
    );
  });
});
