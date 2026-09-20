import { describe, expect, it } from 'vitest';
import {
  buildReceiptRows,
  buildReceiptSignatures,
  buildReceiptTotals,
  RECEIPT_AGREEMENT,
} from './receipt.js';

/**
 * Денежный блок квитанции.
 *
 * РЕШЕНИЕ ЗАКАЗЧИКА. В образце квитанции есть только «Итого», но у заказа может
 * быть внесённая предоплата. Тогда одна строка «Итого» вводит клиента в
 * заблуждение: он видит полную сумму и не понимает, что часть уже оплачена.
 * Поэтому при ненулевой предоплате печатаются «Оплачено» и «К доплате», а без
 * неё форма остаётся ровно такой, как в образце.
 */
describe('Денежный блок квитанции', () => {
  it('без предоплаты — только «Итого», как в образце', () => {
    const rows = buildReceiptTotals({
      totalAmountMinor: 3_111_100,
      paidAmountMinor: 0,
      isWarranty: false,
    });

    /*
     * Сверяем СУММУ, а не начертание: `formatMoney` вставляет неразрывный
     * пробел между разрядами, и тест на точную строку проверял бы типографику
     * вместо содержания. Разряды разделены любым пробелом — этого достаточно.
     */
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Итого');
    expect(rows[0]?.value.replace(/\s/g, ' ')).toBe('31 111,00 ₽');
    expect(rows[0]?.emphasis).toBe(true);
  });

  it('с предоплатой — «Итого», «Оплачено» и «К доплате»', () => {
    /*
     * ГЛАВНАЯ проверка решения заказчика. Без этих строк клиент, внёсший часть
     * суммы, видит только полную стоимость.
     */
    const rows = buildReceiptTotals({
      totalAmountMinor: 3_111_100,
      paidAmountMinor: 1_000_000,
      isWarranty: false,
    });

    expect(rows.map((r) => r.label)).toEqual(['Итого', 'Оплачено', 'К доплате']);
    expect(rows[1]?.value.replace(/\s/g, ' ')).toBe('10 000,00 ₽');
    // Остаток считается из итога и внесённого, а не берётся из ниоткуда.
    expect(rows[2]?.value.replace(/\s/g, ' ')).toBe('21 111,00 ₽');
  });

  it('при полной оплате вместо нуля печатается «оплачено полностью»', () => {
    /*
     * «К доплате: 0 ₽» выглядит как требование и заставляет клиента искать, что
     * он ещё должен. Текст снимает вопрос.
     */
    const rows = buildReceiptTotals({
      totalAmountMinor: 3_111_100,
      paidAmountMinor: 3_111_100,
      isWarranty: false,
    });

    expect(rows.map((r) => r.label)).toEqual(['Итого', 'Оплачено', 'К доплате']);
    expect(rows[2]?.value).toBe('оплачено полностью');
  });

  it('переплата не показывается как долг', () => {
    /*
     * Аванс больше итога возможен (клиент доплатил заранее, потом сумма
     * уменьшилась корректировкой). Отрицательный остаток в документе читался бы
     * как «магазин должен», и это пришлось бы объяснять на месте.
     */
    const rows = buildReceiptTotals({
      totalAmountMinor: 1_000_000,
      paidAmountMinor: 1_500_000,
      isWarranty: false,
    });

    expect(rows[2]?.value).toBe('оплачено полностью');
    expect(rows[2]?.value).not.toContain('−');
  });

  it('«Итого» помечен как итоговая строка', () => {
    // Признак в данных, а не в вёрстке: иначе «Итого» можно случайно набрать
    // обычной строкой, и оно потеряется среди расчётов.
    const rows = buildReceiptTotals({
      totalAmountMinor: 100,
      paidAmountMinor: 0,
      isWarranty: false,
    });

    expect(rows[0]?.emphasis).toBe(true);
  });

  it('строки расчёта итоговыми НЕ помечены', () => {
    // Иначе в форме будет три «главных» строки и ни одной главной.
    const rows = buildReceiptTotals({
      totalAmountMinor: 3_111_100,
      paidAmountMinor: 1_000_000,
      isWarranty: false,
    });

    expect(rows.filter((r) => r.emphasis)).toHaveLength(1);
  });

  it('гарантийный ремонт печатается без денег', () => {
    /*
     * Клиент не платит за повторный ремонт по гарантии. «Итого: 0 ₽» рядом с
     * суммой работ читалось бы как «бесплатно», хотя работа выполнена по ранее
     * оплаченному заказу.
     */
    const rows = buildReceiptTotals({
      totalAmountMinor: 0,
      paidAmountMinor: 0,
      isWarranty: true,
    });

    expect(rows).toEqual([{ label: 'Гарантийный ремонт', value: 'без оплаты', emphasis: true }]);
  });

  it('гарантия важнее внесённой суммы', () => {
    /*
     * У гарантийного заказа может остаться ненулевая «оплата» от прошлого
     * ремонта. Печатать её в квитанции значило бы требовать деньги за то, что
     * делается бесплатно.
     */
    const rows = buildReceiptTotals({
      totalAmountMinor: 500_000,
      paidAmountMinor: 500_000,
      isWarranty: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('без оплаты');
  });
});

/**
 * Подписи в квитанции.
 *
 * РЕШЕНИЕ ЗАКАЗЧИКА: подписи ставятся от руки, печатается место для них и ФИО
 * приёмщика — того, под чьей учётной записью создан заказ.
 */
describe('Подписи квитанции', () => {
  it('печатается строка согласия заказчика', () => {
    // Юридический текст: клиент подтверждает согласие со стоимостью и условиями.
    const signatures = buildReceiptSignatures({ acceptorName: 'Филюнькина Н.В.' });

    expect(signatures.agreement).toBe(RECEIPT_AGREEMENT);
    expect(signatures.agreement).toContain('согласен');
  });

  it('приёмщик — из автора заказа', () => {
    /*
     * Квитанцию может перепечатать администратор или сотрудник другого магазина.
     * Печать его ФИО под чужим приёмом создала бы документ, где подписант не
     * принимал изделие.
     */
    const signatures = buildReceiptSignatures({ acceptorName: 'Филюнькина Н.В.' });

    expect(signatures.acceptorName).toBe('Филюнькина Н.В.');
    expect(signatures.acceptorCaption).toBe('(Приемщик)');
  });

  it('обе подписи имеют подпись-расшифровку', () => {
    // Линия подписи без пояснения, кто подписывает, не читается как документ.
    const signatures = buildReceiptSignatures({ acceptorName: 'Иванов И.И.' });

    expect(signatures.customerCaption).toBe('(Заказчик)');
    expect(signatures.acceptorCaption).toBe('(Приемщик)');
  });

  it('пустое ФИО приёмщика не печатается как пробел', () => {
    /*
     * У старых заказов автор может быть удалён, а у системных — отсутствовать.
     * Пустая строка оставила бы подпись без подписанта, и предъявить документ
     * было бы некому: лучше явный пропуск, который заметен.
     */
    expect(buildReceiptSignatures({ acceptorName: '' }).acceptorName).toBeNull();
    expect(buildReceiptSignatures({ acceptorName: '   ' }).acceptorName).toBeNull();
    expect(buildReceiptSignatures({ acceptorName: null }).acceptorName).toBeNull();
  });

  it('ФИО приёмщика обрезается от пробелов', () => {
    // Лишние пробелы в документе выглядят как небрежность ввода.
    expect(buildReceiptSignatures({ acceptorName: '  Иванов И.И.  ' }).acceptorName).toBe(
      'Иванов И.И.',
    );
  });
});

/**
 * Дефекты и наименование ценностей в квитанции (требование заказчика).
 *
 * Приёмщик описывает состояние изделия при приёме, и клиент должен видеть это в
 * своём экземпляре квитанции: именно этим описанием подтверждается, в каком
 * состоянии вещь была сдана. Без него в споре о повреждении предъявить нечего.
 */
describe('Квитанция: дефекты и наименование ценностей', () => {
  /** Минимальные данные изделия для проверки строк. */
  function item(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      name: 'Кольцо золото 585',
      metal: 'Золото',
      weightGram: '13.200',
      hallmark: '585',
      defects: null,
      ...overrides,
    };
  }

  function data(items: ReturnType<typeof item>[]) {
    return {
      orderNo: 'MSK1-2609-000001',
      createdAt: new Date('2026-09-20T10:00:00Z'),
      dueAt: null,
      status: 'DRAFT',
      statusLabel: 'Черновик',
      storeName: 'Магазин',
      storePhone: null,
      organizationName: 'ИП Бурда Виталий Валерьевич',
      customerName: 'Клиентов Иван Петрович',
      customerPhone: '+7 933 331-93-92',
      customerAddress: null,
      items,
      works: [],
      stones: [],
      worksTotalMinor: 0,
      stonesTotalMinor: 0,
      discountMinor: 0,
      totalAmountMinor: 0,
      paidAmountMinor: 0,
      prepaymentRequiredMinor: 0,
      requiresPrepayment: false,
      isWarranty: false,
      description: null,
    };
  }

  it('наименование принятой ценности попадает в строки', () => {
    // Именно по названию клиент узнаёт свою вещь в квитанции.
    const rows = buildReceiptRows(data([item({ name: 'Серьги серебряные 925' })]) as never);

    const изделие = rows.find((r) => r.label === 'Изделие');
    expect(изделие?.value).toContain('Серьги серебряные 925');
  });

  it('описание дефектов печатается отдельной строкой', () => {
    /*
     * Решение заказчика: строкой под таблицей, а не колонкой. Колонка растянула
     * бы таблицу по высоте — текст дефектов бывает длинным.
     */
    const rows = buildReceiptRows(data([item({ defects: 'Разрыв шинки у основания' })]) as never);

    const дефекты = rows.find((r) => r.label === 'Описание дефектов');
    expect(дефекты).toBeDefined();
    expect(дефекты?.value).toContain('Разрыв шинки у основания');
  });

  it('строка дефектов называет изделие, к которому относится', () => {
    /*
     * В заказе может быть несколько изделий, и «Разрыв шинки» без названия вещи
     * непонятно к чему относится — а в споре это решает.
     */
    const rows = buildReceiptRows(
      data([
        item({ name: 'Кольцо', defects: 'Разрыв шинки' }),
        item({ name: 'Серьги', defects: 'Скол эмали' }),
      ]) as never,
    );

    const дефекты = rows.find((r) => r.label === 'Описание дефектов');
    expect(дефекты?.value).toContain('Кольцо: Разрыв шинки');
    expect(дефекты?.value).toContain('Серьги: Скол эмали');
  });

  it('без дефектов строка не печатается вовсе', () => {
    // Пустая строка «Описание дефектов: » выглядит как незаполненный документ.
    const rows = buildReceiptRows(data([item({ defects: null })]) as never);

    expect(rows.find((r) => r.label === 'Описание дефектов')).toBeUndefined();
  });

  it('дефекты из одних пробелов не считаются заполненными', () => {
    // Иначе в документе появилась бы строка с пустым значением.
    const rows = buildReceiptRows(data([item({ defects: '   ' })]) as never);

    expect(rows.find((r) => r.label === 'Описание дефектов')).toBeUndefined();
  });

  it('в строках печатается РУССКОЕ название металла', () => {
    /*
     * Металл приходит уже приведённым (`metalDisplayName` на сервере). Тест
     * фиксирует, что квитанция не подставляет код: клиент не обязан понимать
     * `Au585`.
     */
    const rows = buildReceiptRows(data([item({ metal: 'Золото' })]) as never);

    const металл = rows.find((r) => r.label === 'Металл');
    expect(металл?.value).toBe('Золото');
  });
});
