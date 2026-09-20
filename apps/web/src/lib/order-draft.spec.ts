/**
 * Тесты признака «в черновике есть что сохранять» (задача 1.7.3).
 *
 * ЧТО ЗАЩИЩАЕТ. Этот признак решает, создавать ли черновик. Если он ошибочно
 * говорит «есть данные» на пустой форме, то приёмщик, открывший и закрывший
 * мастер, оставляет черновик — и при следующем входе система предлагает
 * восстановить пустоту. Если ошибочно говорит «пусто» на заполненной форме,
 * теряется работа, ради сохранения которой автосохранение и делалось.
 *
 * Отдельно проверяется, что признаки, выставленные СИСТЕМОЙ (шаг, магазин по
 * умолчанию, приоритет по умолчанию, согласия), не считаются введёнными
 * данными: иначе форма считалась бы заполненной сразу после открытия.
 */

import { describe, expect, it } from 'vitest';
import { orderDraftHasContent, type OrderDraftContent } from './order-draft';

/** Пустой черновик — ровно то, что видит приёмщик сразу после открытия мастера. */
function emptyDraft(overrides: Partial<OrderDraftContent> = {}): OrderDraftContent {
  return {
    term: '',
    selectedCustomer: null,
    isNewCustomer: false,
    newCustomer: { fullName: '', phone: '', address: '', email: '', notes: '' },
    item: {
      name: '',
      metal: '',
      weightGram: '',
      size: '',
      hallmark: '',
      defects: '',
      completeness: '',
    },
    works: [],
    description: '',
    prepayment: '',
    requiresPrepayment: false,
    ...overrides,
  };
}

describe('Черновик: пустая форма', () => {
  it('на пустой форме данных нет', () => {
    // Иначе пустой черновик появлялся бы от одного открытия мастера.
    expect(orderDraftHasContent(emptyDraft())).toBe(false);
  });

  it('отметки согласия сами по себе данными не считаются', () => {
    // Согласия — это галочки, которые ставят уже при осмысленном заполнении;
    // отдельно от остального они не означают незавершённый заказ.
    const draft = emptyDraft();
    expect(orderDraftHasContent(draft)).toBe(false);
  });

  it('признаки системы данными не считаются', () => {
    // Шаг, магазин по умолчанию и приоритет по умолчанию выставляются сами.
    // Если бы они считались данными, черновик создавался бы сразу после
    // открытия формы — и система предлагала бы восстановить пустоту.
    // Лишние поля передаются намеренно: функция обязана смотреть только на
    // поля, которые заполняет человек.
    const withSystemFields = {
      ...emptyDraft(),
      step: 2,
      createdStoreId: 'store-1',
      pickupStoreId: 'store-2',
      workshopId: 'workshop-1',
      priority: 'NORMAL',
      consentCallRecording: true,
      consentMarketing: true,
    };

    expect(orderDraftHasContent(withSystemFields)).toBe(false);
  });
});

describe('Черновик: что считается введёнными данными', () => {
  it('поисковый запрос по клиенту', () => {
    expect(orderDraftHasContent(emptyDraft({ term: 'Иванов' }))).toBe(true);
  });

  it('выбранный существующий клиент', () => {
    expect(orderDraftHasContent(emptyDraft({ selectedCustomer: { id: 'c1' } }))).toBe(true);
  });

  it('новый клиент: любое заполненное поле', () => {
    const cases: Array<Partial<OrderDraftContent['newCustomer']>> = [
      { fullName: 'Иванов Иван' },
      { phone: '+79001112233' },
      { email: 'a@b.ru' },
      { notes: 'постоянный клиент' },
      /*
       * Адрес участвует наравне с остальными: он печатается в квитанции, и
       * черновик, в котором заполнили ТОЛЬКО адрес, не должен теряться при
       * закрытии страницы.
       */
      { address: 'гор. Красноярск ул. Гусарова д.27 кв.36' },
    ];

    for (const patch of cases) {
      const draft = emptyDraft({
        isNewCustomer: true,
        newCustomer: { fullName: '', phone: '', address: '', email: '', notes: '', ...patch },
      });
      expect(orderDraftHasContent(draft), JSON.stringify(patch)).toBe(true);
    }
  });

  it('новый клиент без единого поля не считается данными', () => {
    // Отметка «новый клиент» сама по себе ничего не значит: приёмщик мог
    // нажать её и передумать.
    expect(orderDraftHasContent(emptyDraft({ isNewCustomer: true }))).toBe(false);
  });

  it('изделие: любое заполненное поле', () => {
    const fields = [
      'name',
      'metal',
      'weightGram',
      'size',
      'hallmark',
      'defects',
      'completeness',
    ] as const;

    for (const field of fields) {
      const draft = emptyDraft();
      draft.item[field] = 'значение';
      expect(orderDraftHasContent(draft), field).toBe(true);
    }
  });

  it('добавленные работы', () => {
    expect(orderDraftHasContent(emptyDraft({ works: [{ id: 'w1' }] }))).toBe(true);
  });

  it('описание и предоплата', () => {
    expect(orderDraftHasContent(emptyDraft({ description: 'срочно' }))).toBe(true);
    expect(orderDraftHasContent(emptyDraft({ prepayment: '5000' }))).toBe(true);
    expect(orderDraftHasContent(emptyDraft({ requiresPrepayment: true }))).toBe(true);
  });

  it('пробелы не считаются вводом', () => {
    // Пробел в поле — это не данные: иначе черновик появлялся бы от одного
    // нажатия пробела.
    expect(orderDraftHasContent(emptyDraft({ term: '   ' }))).toBe(false);
    expect(orderDraftHasContent(emptyDraft({ description: '  ' }))).toBe(false);
    expect(orderDraftHasContent(emptyDraft({ prepayment: ' ' }))).toBe(false);

    const draft = emptyDraft();
    draft.item.name = '   ';
    expect(orderDraftHasContent(draft)).toBe(false);
  });
});
