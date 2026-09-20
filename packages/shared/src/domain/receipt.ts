/**
 * Состав квитанции приёма заказа (ответ A4, docs/08-ui-ux.md §4.1).
 *
 * Квитанция — документ, который остаётся у клиента, поэтому её состав
 * фиксирован и не зависит от того, кто и где печатает. Здесь описано
 * СОДЕРЖИМОЕ (что печатать), а не вёрстка: сборка PDF и предпросмотр в
 * интерфейсе пользуются одной и той же функцией, иначе бумага и экран
 * разошлись бы — клиент увидел бы на экране одно, а получил другое.
 *
 * Персональных данных в QR-коде нет: только номер заказа (см.
 * `buildOrderQrPayload`). Сама квитанция печатается для клиента и содержит
 * его телефон и ФИО — это документ приёма, без них он бесполезен.
 */

import { formatMoney, isPaidInFull } from '../utils/money.js';
import { buildOrderQrPayload } from './order-number.js';

/** Готовая строка квитанции: подпись и значение. */
export interface ReceiptRow {
  label: string;
  value: string;
}

/** Данные, необходимые для печати квитанции. Собирается сервером. */
export interface ReceiptData {
  orderNo: string;
  createdAt: Date;
  dueAt: Date | null;
  status: string;
  statusLabel: string;
  storeName: string;
  /** Телефон магазина приёма — печатается в шапке рядом с названием. */
  storePhone: string | null;
  /**
   * Наименование организации-изготовителя (ИП Бурда В. В.).
   *
   * Печатается в шапке: квитанция — документ, а документ называет исполнителя.
   */
  organizationName: string;
  customerName: string;
  customerPhone: string;
  /** Адрес заказчика; `null`, если не заполнен. */
  customerAddress: string | null;
  /**
   * Изделия с ВЕСОМ и ПРОБОЙ — для блока «Принято от заказчика».
   *
   * Вес приёма берётся из карточки изделия: его указывают при приёме. Это
   * единственная графа блока металла, которая заполняется: выдача, расход и
   * потери относятся к изготовлению из металла клиента, а в ремонте изделие
   * возвращается владельцу целиком.
   */
  items: {
    /** Наименование принятой ценности: «Кольцо золото 585». */
    name: string;
    /** Металл уже приведён к русскому названию (`metalDisplayName`). */
    metal: string | null;
    /** Вес в граммах строкой: точность хранится до третьего знака. */
    weightGram: string | null;
    /** Проба изделия. */
    hallmark: string | null;
    /**
     * Описание дефектов — печатается строкой под таблицей металла.
     *
     * Необязательное: поле добавлено после того, как квитанция уже
     * существовала, и вызывающий код мог не успеть его заполнить. Отсутствие
     * означает «дефекты не описаны», а не ошибку.
     */
    defects?: string | null;
  }[];
  works: { name: string; amountMinor: number }[];
  stones: { name: string; amountMinor: number }[];
  worksTotalMinor: number;
  stonesTotalMinor: number;
  /** Скидка (положительная) или надбавка (отрицательная) — см. `describeDiscount`. */
  discountMinor: number;
  totalAmountMinor: number;
  paidAmountMinor: number;
  prepaymentRequiredMinor: number;
  requiresPrepayment: boolean;
  isWarranty: boolean;
  /** Причина ремонта / описание неисправности, если приёмщик её записал. */
  description: string | null;
}

/** Строка «металл» для перечня изделий. */
function metalLabel(metal: string | null): string {
  if (metal === null || metal.trim() === '') return '';
  // Значение приходит либо кодом (`Au585`, `Ag925`), либо свободным текстом.
  return metal.trim();
}

/** Дата в виде ДД.ММ.ГГГГ — формат, привычный для бумажных документов. */
export function formatReceiptDate(date: Date | null): string {
  if (date === null) return '—';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

/**
 * Строки квитанции в порядке печати.
 *
 * Возвращает именно список подписей и значений, а не готовый текст: так
 * вёрстка PDF и предпросмотр на экране расставляют их по-своему, но
 * подписи и порядок остаются едиными, и тест проверяет их один раз.
 */
export function buildReceiptRows(data: ReceiptData): ReceiptRow[] {
  const rows: ReceiptRow[] = [
    { label: 'Изделие', value: data.items.map((i) => i.name).join('; ') || '—' },
  ];

  const metals = data.items.map((i) => metalLabel(i.metal)).filter((m) => m !== '');
  if (metals.length > 0) {
    rows.push({ label: 'Металл', value: [...new Set(metals)].join(', ') });
  }

  rows.push({
    label: 'Работы',
    value:
      data.works.length > 0
        ? data.works.map((w) => `${w.name} — ${formatMoney(w.amountMinor)}`).join('; ')
        : '—',
  });

  if (data.stones.length > 0) {
    rows.push({
      label: 'Камни',
      value: data.stones.map((s) => `${s.name} — ${formatMoney(s.amountMinor)}`).join('; '),
    });
  }

  /*
   * Дефекты печатаются ОТДЕЛЬНОЙ строкой, а не колонкой в таблице металла
   * (решение заказчика): текст бывает длинным, и колонка растянула бы таблицу по
   * высоте. Название изделия входит в строку: в заказе их может быть несколько,
   * и «Разрыв шинки» без названия вещи непонятно к чему относится — а в споре о
   * повреждении это решает.
   */
  const defects = data.items
    /*
     * `?? ''` — не перестраховка ради тестов: поле добавлено позже, и данные
     * могут прийти без него (старый кэш, чужой вызывающий код). Обращение
     * `item.defects.trim()` без этого уронило бы печать ВСЕЙ квитанции из-за
     * одного отсутствующего поля — документ, который нужен клиенту на руки.
     */
    .filter((item) => (item.defects ?? '').trim() !== '')
    .map((item) => `${item.name}: ${(item.defects ?? '').trim()}`);
  if (defects.length > 0) {
    rows.push({ label: 'Описание дефектов', value: defects.join('; ') });
  }

  if (data.description !== null && data.description.trim() !== '') {
    rows.push({ label: 'Описание', value: data.description.trim() });
  }

  rows.push({ label: 'Сумма', value: formatMoney(data.totalAmountMinor) });

  if (data.discountMinor > 0) {
    rows.push({ label: 'Скидка', value: `−${formatMoney(data.discountMinor)}` });
  }
  if (data.discountMinor < 0) {
    // Надбавка: согласованная сумма больше суммы строк (срочность, сложность).
    rows.push({ label: 'Надбавка', value: `+${formatMoney(-data.discountMinor)}` });
  }

  if (data.requiresPrepayment && data.prepaymentRequiredMinor > 0) {
    rows.push({
      label: 'Предоплата к внесению',
      value: formatMoney(data.prepaymentRequiredMinor),
    });
  }

  rows.push({ label: 'Внесено', value: formatMoney(data.paidAmountMinor) });
  rows.push({ label: 'Срок готовности', value: formatReceiptDate(data.dueAt) });
  rows.push({ label: 'Телефон', value: data.customerPhone });
  rows.push({ label: 'Статус', value: data.statusLabel });

  return rows;
}

/**
 * Что печатать в QR-коде квитанции.
 *
 * Отдельная функция, потому что это единственное поле квитанции, которое
 * читает оборудование, и его формат зафиксирован ответом A4: сканер вводит
 * `repair://order/{номер}` в поле поиска.
 */
export function buildReceiptQr(data: { orderNo: string }): string {
  return buildOrderQrPayload(data.orderNo);
}

/**
 * Что печатать линейным кодом `Code128` — резерв для сканеров, читающих
 * только линейные коды. Только номер: URI в линейный код не влезает,
 * да и сканеру нужен именно номер.
 */
export function buildReceiptBarcode(data: { orderNo: string }): string {
  return data.orderNo.trim().toUpperCase();
}

/**
 * Веса колонок таблицы металла: «Наименование металла», «Проба», «Принято, г».
 *
 * Наименование вчетверо шире каждой из двух других колонок (требование
 * заказчика). Это единственная колонка с текстом произвольной длины — в неё
 * попадает «Золото, Цепь (Au585)», — тогда как «Проба» и «Принято» содержат
 * три-четыре знака. При равных долях наименование переносилось бы на вторую
 * строку на пустом месте, а узкие колонки оставались бы полупустыми.
 *
 * Вынесено из вёрстки в домен, потому что пропорция — это требование к
 * документу, а не деталь отрисовки: её нужно проверять тестом, не собирая PDF.
 */
export const METAL_TABLE_WEIGHTS = [4, 1, 1] as const;

/**
 * Ширины колонок таблицы металла в точках.
 *
 * `usableWidth` — ширина полосы набора (страница минус поля). Возвращаются
 * абсолютные ширины, сумма которых равна `usableWidth`: вёрстка не должна
 * терять или накапливать доли от округления.
 */
export function metalTableColumns(usableWidth: number): number[] {
  const total = METAL_TABLE_WEIGHTS.reduce((sum, w) => sum + w, 0);
  return METAL_TABLE_WEIGHTS.map((w) => (usableWidth * w) / total);
}

/**
 * Текст-предупреждение под шапкой квитанции.
 *
 * Гарантийный заказ печатается без денег: клиент не платит за повторный
 * ремонт по гарантии, и приёмщик не должен вписывать сумму от руки.
 */
export function receiptNotice(data: { isWarranty: boolean; requiresPrepayment: boolean }): string {
  if (data.isWarranty) {
    return 'Гарантийный ремонт — выполняется без оплаты.';
  }
  if (data.requiresPrepayment) {
    return 'Работы начинаются после внесения предоплаты.';
  }
  return 'Работы начинаются после согласования стоимости.';
}

/**
 * Строка денежного блока квитанции.
 *
 * `emphasis` помечает итоговую строку: в форме она отделена и набрана жирным.
 * Признак в данных, а не в вёрстке, чтобы «Итого» нельзя было случайно набрать
 * как обычную строку — тест проверяет именно его.
 */
export interface ReceiptTotalRow {
  label: string;
  value: string;
  emphasis: boolean;
}

/**
 * Денежный блок квитанции: итог и, если была предоплата, расчёт с клиентом.
 *
 * ## Почему «Оплачено» и «К доплате» показываются не всегда
 *
 * В образце заказчика есть только «Итого». Но у заказа может быть внесённая
 * предоплата, и тогда одна строка «Итого» вводит клиента в заблуждение: он
 * видит полную сумму и не понимает, что часть уже оплачена. Поэтому при
 * ненулевой предоплате печатаются ещё две строки, а при её отсутствии форма
 * остаётся ровно такой, как в образце.
 *
 * «К доплате» НЕ печатается, когда заказ оплачен полностью: строка «0,00 ₽»
 * выглядит как требование и заставляет клиента искать, что он ещё должен.
 * Вместо неё — «Оплачено полностью».
 *
 * Полная оплата определяется той же функцией `isPaidInFull`, что и условие
 * выдачи: своя проверка здесь разошлась бы с ней, и квитанция могла бы
 * утверждать «оплачено полностью» там, где система выдачу не разрешает.
 */
export function buildReceiptTotals(data: {
  totalAmountMinor: number;
  paidAmountMinor: number;
  isWarranty: boolean;
}): ReceiptTotalRow[] {
  const rows: ReceiptTotalRow[] = [
    { label: 'Итого', value: formatMoney(data.totalAmountMinor), emphasis: true },
  ];

  /*
   * Гарантийный ремонт печатается без денег: клиент не платит за повторный
   * ремонт по гарантии, и «Итого: 0,00 ₽» рядом с суммой работ читалось бы как
   * «бесплатно», хотя работа выполнена по ранее оплаченному заказу.
   */
  if (data.isWarranty) {
    return [{ label: 'Гарантийный ремонт', value: 'без оплаты', emphasis: true }];
  }

  if (data.paidAmountMinor === 0) return rows;

  rows.push({ label: 'Оплачено', value: formatMoney(data.paidAmountMinor), emphasis: false });

  if (isPaidInFull(data.totalAmountMinor, data.paidAmountMinor)) {
    rows.push({ label: 'К доплате', value: 'оплачено полностью', emphasis: false });
    return rows;
  }

  const remaining = Math.max(0, data.totalAmountMinor - data.paidAmountMinor);
  rows.push({ label: 'К доплате', value: formatMoney(remaining), emphasis: false });

  return rows;
}

/**
 * Подписи и юридическая строка подвала квитанции.
 *
 * ## Почему приёмщик берётся из автора заказа
 *
 * Подпись приёмщика ставится под документом, а не «у того, кто печатает»:
 * квитанцию может перепечатать администратор или сотрудник другого магазина, и
 * печать его ФИО под чужим приёмом создала бы документ, где подписант не
 * принимал изделие. Поэтому печатается ФИО СОЗДАТЕЛЯ заказа — того, кто внёс
 * его в систему под своей учётной записью.
 *
 * Строка о согласии — юридический текст: клиент подтверждает, что согласен со
 * стоимостью работ и условиями. Она набрана текстом, а не картинкой, чтобы её
 * можно было прочитать вслух и скопировать.
 */
export interface ReceiptSignatures {
  /** Строка согласия над подписями. */
  agreement: string;
  /** Подпись заказчика — от руки, поэтому только подпись подписи. */
  customerCaption: string;
  /** ФИО приёмщика для подписи; `null`, если автор заказа неизвестен. */
  acceptorName: string | null;
  /** Подпись приёмщика. */
  acceptorCaption: string;
}

/** Текст, который клиент подтверждает подписью (по образцу заказчика). */
export const RECEIPT_AGREEMENT = 'Со стоимостью работ и условиями выполнения заказа согласен';

/** Подписи сторон в квитанции. */
export function buildReceiptSignatures(params: { acceptorName: string | null }): ReceiptSignatures {
  const name = params.acceptorName?.trim() ?? '';
  return {
    agreement: RECEIPT_AGREEMENT,
    customerCaption: '(Заказчик)',
    // Пустое ФИО означало бы подпись без подписанта: в документе остался бы
    // пробел, и предъявить его было бы некому.
    acceptorName: name === '' ? null : name,
    acceptorCaption: '(Приемщик)',
  };
}
