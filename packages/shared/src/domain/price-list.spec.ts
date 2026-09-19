/**
 * Правила жизненного цикла прейскуранта (задачи 1.4.2–1.4.3).
 *
 * Проверяется главное обещание: УТВЕРЖДЁННУЮ версию нельзя править. Ошибка здесь
 * не косметическая — по утверждённому прейскуранту посчитаны заказы, и правка
 * цены задним числом сделала бы историю недостоверной. При этом расхождение
 * всплыло бы не сразу: суммы заказов хранятся копией, поэтому заказ выглядел бы
 * верным, а цена — «уточнённой».
 *
 * Проверяется и обратное: отклонённую версию править МОЖНО. Иначе отклонение
 * наказывало бы за исправление — администратор создавал бы версию с нуля, теряя
 * набранные позиции.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PRICE_LIST_STATUSES,
  EDITABLE_PRICE_LIST_STATUSES,
  PRICE_LIST_ACTION_TARGET,
  PRICE_LIST_STATUS,
  PRICE_LIST_STATUS_LABELS,
  PRICE_LIST_TRANSITIONS,
  availablePriceListActions,
  canApplyPriceListAction,
  isPriceListEditable,
  isPriceListStatus,
} from './price-list.js';

describe('Статусы прейскуранта', () => {
  it('распознаёт известные статусы', () => {
    for (const status of ALL_PRICE_LIST_STATUSES) {
      expect(isPriceListStatus(status), status).toBe(true);
    }
  });

  it('не принимает чужие значения', () => {
    // Значение приходит из query-строки и из тела запроса, поэтому проверка
    // обязана отвергать всё, что не статус, а не приводить к undefined.
    expect(isPriceListStatus('УТВЕРЖДЁН')).toBe(false);
    expect(isPriceListStatus('approved')).toBe(false);
    expect(isPriceListStatus('')).toBe(false);
    expect(isPriceListStatus(null)).toBe(false);
    expect(isPriceListStatus(undefined)).toBe(false);
    expect(isPriceListStatus(42)).toBe(false);
  });

  it('у каждого статуса есть русское название', () => {
    for (const status of ALL_PRICE_LIST_STATUSES) {
      expect(PRICE_LIST_STATUS_LABELS[status].trim(), status).not.toBe('');
    }
  });
});

describe('Правка версии прейскуранта', () => {
  it('УТВЕРЖДЁННУЮ версию править нельзя', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА ЗАДАЧИ 1.4.3. Это не удобство, а достоверность истории:
     * цены утверждённой версии уже применены в заказах.
     */
    expect(isPriceListEditable(PRICE_LIST_STATUS.APPROVED)).toBe(false);
  });

  it('архив править нельзя', () => {
    // Архив существует ровно для того, чтобы объяснять цены прошлых заказов.
    expect(isPriceListEditable(PRICE_LIST_STATUS.ARCHIVED)).toBe(false);
  });

  it('версию на утверждении править нельзя', () => {
    /*
     * Иначе администратор менял бы цены под руками у утверждающего: руководитель
     * утвердил бы одну сумму, а в документе стояла бы другая.
     */
    expect(isPriceListEditable(PRICE_LIST_STATUS.PENDING_APPROVAL)).toBe(false);
  });

  it('черновик править можно', () => {
    expect(isPriceListEditable(PRICE_LIST_STATUS.DRAFT)).toBe(true);
  });

  it('ОТКЛОНЁННУЮ версию править можно', () => {
    /*
     * Отклонение — это «исправьте и пришлите снова». Запрет правки заставлял бы
     * создавать версию с нуля, теряя уже набранные позиции.
     */
    expect(isPriceListEditable(PRICE_LIST_STATUS.REJECTED)).toBe(true);
  });

  it('редактируемых статусов ровно два', () => {
    // Список задан явно; расширение его требует осознанного решения, и тест
    // заставляет это решение заметить.
    expect([...EDITABLE_PRICE_LIST_STATUSES]).toEqual([
      PRICE_LIST_STATUS.DRAFT,
      PRICE_LIST_STATUS.REJECTED,
    ]);
  });
});

describe('Переходы статусов', () => {
  it('утвердить можно только отправленную версию', () => {
    /*
     * `DRAFT → APPROVED` напрямую отсутствует намеренно: утверждение без явной
     * отправки означало бы, что руководитель подписал то, что не видел.
     */
    expect(canApplyPriceListAction('APPROVE', PRICE_LIST_STATUS.PENDING_APPROVAL)).toBe(true);
    expect(canApplyPriceListAction('APPROVE', PRICE_LIST_STATUS.DRAFT)).toBe(false);
    expect(canApplyPriceListAction('APPROVE', PRICE_LIST_STATUS.APPROVED)).toBe(false);
  });

  it('отправить можно черновик и отклонённую версию', () => {
    expect(canApplyPriceListAction('SUBMIT', PRICE_LIST_STATUS.DRAFT)).toBe(true);
    expect(canApplyPriceListAction('SUBMIT', PRICE_LIST_STATUS.REJECTED)).toBe(true);
    expect(canApplyPriceListAction('SUBMIT', PRICE_LIST_STATUS.APPROVED)).toBe(false);
  });

  it('архив не тупик: из него создаётся новая версия', () => {
    /*
     * Утверждённую версию не правят, а заменяют новой. Архивная объясняет цены
     * прошлых заказов и потому тоже не правится — но именно на её основе удобнее
     * всего собрать следующую версию, ведь позиции уже набраны.
     */
    expect(canApplyPriceListAction('COPY', PRICE_LIST_STATUS.ARCHIVED)).toBe(true);
    expect(canApplyPriceListAction('COPY', PRICE_LIST_STATUS.APPROVED)).toBe(true);
    // Копировать черновик незачем: он и так правится.
    expect(canApplyPriceListAction('COPY', PRICE_LIST_STATUS.DRAFT)).toBe(false);
  });

  it('в архив уходит только утверждённая версия', () => {
    expect(canApplyPriceListAction('ARCHIVE', PRICE_LIST_STATUS.APPROVED)).toBe(true);
    expect(canApplyPriceListAction('ARCHIVE', PRICE_LIST_STATUS.DRAFT)).toBe(false);
    expect(canApplyPriceListAction('ARCHIVE', PRICE_LIST_STATUS.ARCHIVED)).toBe(false);
  });

  it('отклонить можно только отправленную версию', () => {
    expect(canApplyPriceListAction('REJECT', PRICE_LIST_STATUS.PENDING_APPROVAL)).toBe(true);
    expect(canApplyPriceListAction('REJECT', PRICE_LIST_STATUS.APPROVED)).toBe(false);
  });

  it('вернуть в черновик можно только отправленную версию', () => {
    // Отозвать утверждённую версию нельзя — её уже примененили в заказах.
    expect(canApplyPriceListAction('RESTORE_TO_DRAFT', PRICE_LIST_STATUS.PENDING_APPROVAL)).toBe(
      true,
    );
    expect(canApplyPriceListAction('RESTORE_TO_DRAFT', PRICE_LIST_STATUS.APPROVED)).toBe(false);
  });

  it('правка доступна ровно там, где статус редактируемый', () => {
    // Согласованность: `EDIT` и `isPriceListEditable` — одно правило, описанное
    // дважды. Разойдись они, интерфейс предлагал бы правку, которую сервер
    // отклоняет.
    for (const status of ALL_PRICE_LIST_STATUSES) {
      expect(canApplyPriceListAction('EDIT', status), status).toBe(isPriceListEditable(status));
    }
  });

  it('у каждого перехода есть целевой статус', () => {
    for (const action of Object.keys(
      PRICE_LIST_TRANSITIONS,
    ) as (keyof typeof PRICE_LIST_TRANSITIONS)[]) {
      const target = PRICE_LIST_ACTION_TARGET[action];
      // `EDIT` статус не меняет, а `COPY` создаёт ДРУГУЮ запись — у обоих
      // целевого статуса нет.
      if (action === 'EDIT' || action === 'COPY') {
        expect(target).toBeNull();
        continue;
      }
      expect(target, action).not.toBeNull();
      expect(isPriceListStatus(target), action).toBe(true);
    }
  });

  it('из любого статуса есть хотя бы один доступный шаг', () => {
    /*
     * Тупик означал бы, что версия «застряла» и починить её можно только через
     * базу. Именно на этом тесте обнаружилось, что архив был тупиком: у него не
     * оставалось ни одного шага. Добавлено действие `COPY` — создание новой
     * версии на основе архивной; так цены и меняют.
     */
    for (const status of ALL_PRICE_LIST_STATUSES) {
      expect(availablePriceListActions(status).length, status).toBeGreaterThan(0);
    }
  });

  it('подсказка действий согласована с переходами', () => {
    for (const status of ALL_PRICE_LIST_STATUSES) {
      for (const action of availablePriceListActions(status)) {
        expect(canApplyPriceListAction(action, status), `${action} при ${status}`).toBe(true);
      }
    }
  });
});
