/**
 * Тесты PDF акта приёма-передачи (задача 2.3, ТЗ п. 2.6).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Акт подписывают обе стороны, и он уходит на печать. Ошибка в
 * документе не видна в API — она видна только на бумаге, где её уже не
 * исправить:
 *
 *  * кириллица выходит пустыми квадратами, если шрифт не встроен: на сервере
 *    нет ни одного системного шрифта (проверено: `/usr/share/fonts`
 *    отсутствует), поэтому проверяется, что шрифт разрешается из `node_modules`
 *    и что русский текст реально попадает в документ;
 *  * строки подписей обязательны всегда: акт без них юридически бессмыслен,
 *    поэтому они проверяются и до подписания (пустые линии), и после (ФИО);
 *  * документ собирается из СНИМКА, а не из текущих заказов — иначе
 *    переименованный заказ менял бы уже подписанный акт.
 *
 * Проверяется извлечённый ТЕКСТ PDF, а не факт «файл непустой»: пустой PDF тоже
 * непустой файл, и такая проверка ничего не доказывала бы.
 */

import { describe, expect, it } from 'vitest';
import { BatchActPdfService, plural } from './batch-act-pdf.service';
import type { BatchActSnapshot } from '@app/shared';

const SNAPSHOT: BatchActSnapshot = {
  batchNo: 'П-250916-004',
  direction: 'TO_PRODUCTION',
  fromLabel: 'Магазин на Тверской',
  toLabel: 'Центральный цех',
  itemsCount: 2,
  totalAmountMinor: 150000,
  formedAt: '2025-09-16T07:00:00.000Z',
  items: [
    {
      orderId: 'o1',
      orderNo: 'MSK1-2609-000001',
      customerName: 'Иванов Иван Иванович',
      totalAmountMinor: 100000,
    },
    {
      orderId: 'o2',
      orderNo: 'MSK1-2609-000002',
      customerName: 'Петрова Анна Сергеевна',
      totalAmountMinor: 50000,
    },
  ],
};

const service = new BatchActPdfService();

/**
 * Извлечь текст из PDF.
 *
 * ПОЧЕМУ ЭТО НЕ «ПОИСК СТРОКИ В ФАЙЛЕ». PDFKit встраивает подмножество шрифта и
 * пишет текст ГЛИФАМИ (`[<0001 0002 ...>] TJ`), а соответствие глиф → Unicode
 * кладёт в CMap `/ToUnicode`. Русские слова в PDF байтами UTF-8 не встречаются,
 * поэтому проверка «строка есть в файле» не нашла бы ничего даже в правильном
 * документе.
 *
 * ПОЧЕМУ КАРТ ДВЕ. В акте два шрифта (обычный и полужирный), у каждого СВОЙ
 * CMap, и номера глифов в них совпадают, означая разные буквы. Если свести обе
 * карты в одну, текст превращается в кашу — именно так и получилось при первой
 * попытке. Поэтому карта выбирается по текущему шрифту (`/F2` или `/F3` из
 * оператора `Tf`).
 */
async function extractText(pdf: Buffer): Promise<string> {
  const zlib = await import('node:zlib');
  const raw = pdf.toString('latin1');

  /** Поток объекта по его номеру: `N 0 obj << ... >> stream ... endstream`. */
  const streamByObject = new Map<number, string>();
  const objectRe = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = objectRe.exec(raw)) !== null) {
    const number = Number(objectMatch[1]);
    const body = objectMatch[2] ?? '';
    const streamMatch = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(body);
    if (streamMatch === null) continue;
    const chunk = Buffer.from(streamMatch[1] ?? '', 'latin1');
    try {
      streamByObject.set(number, zlib.inflateSync(chunk).toString('latin1'));
    } catch {
      streamByObject.set(number, streamMatch[1] ?? '');
    }
  }

  /**
   * Разобрать CMap в карту «глиф → символ».
   *
   * Разбор идёт ПО БЛОКАМ `beginbfrange … endbfrange` и `beginbfchar … endbfchar`.
   * Это принципиально: если искать формы регулярками по всему тексту CMap,
   * «одиночная» форма `<0000> <0022> <0420>` совпадает с тройками ВНУТРИ
   * массивной формы `[<0000> <0420> <0435> …]`, и карта заполняется мусором —
   * проверено: текст превращался в «жзийкл» вместо «Ремонт».
   */
  const parseCMap = (cmap: string): Map<number, string> => {
    const map = new Map<number, string>();
    if (!cmap.includes('beginbfchar') && !cmap.includes('beginbfrange')) return map;

    // --- beginbfrange ---
    const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = bfrangeRe.exec(cmap)) !== null) {
      const block = blockMatch[1] ?? '';

      // Массивная форма: <0000> <0022> [<0420> <0435> …].
      const arrayRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
      let arrayMatch: RegExpExecArray | null;
      while ((arrayMatch = arrayRe.exec(block)) !== null) {
        const startGlyph = parseInt(arrayMatch[1] ?? '0', 16);
        const values = [...(arrayMatch[3] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g)];
        values.forEach((value, index) => {
          map.set(
            startGlyph + index,
            String.fromCharCode(parseInt((value[1] ?? '').slice(-4), 16)),
          );
        });
      }

      /*
       * Одиночная форма: <0000> <0022> <0420>. Из блока предварительно убраны
       * массивные формы — иначе тройки внутри массива снова принялись бы за
       * одиночные диапазоны.
       */
      const withoutArrays = block.replace(/<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\[[\s\S]*?\]/g, ' ');
      const singleRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let singleMatch: RegExpExecArray | null;
      while ((singleMatch = singleRe.exec(withoutArrays)) !== null) {
        const from = parseInt(singleMatch[1] ?? '0', 16);
        const to = parseInt(singleMatch[2] ?? '0', 16);
        const base = parseInt((singleMatch[3] ?? '').slice(-4), 16);
        for (let glyph = from; glyph <= to; glyph++) {
          map.set(glyph, String.fromCharCode(base + (glyph - from)));
        }
      }
    }

    // --- beginbfchar ---
    const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let charBlock: RegExpExecArray | null;
    while ((charBlock = bfcharRe.exec(cmap)) !== null) {
      const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let pair: RegExpExecArray | null;
      while ((pair = pairRe.exec(charBlock[1] ?? '')) !== null) {
        map.set(
          parseInt(pair[1] ?? '0', 16),
          String.fromCharCode(parseInt((pair[2] ?? '').slice(-4), 16)),
        );
      }
    }

    return map;
  };

  // Ресурсы страницы: `/Font << /F2 8 0 R /F3 9 0 R >>`.
  const fontObjectByAlias = new Map<string, number>();
  for (const fontMatch of raw.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
    fontObjectByAlias.set(fontMatch[1] ?? '', Number(fontMatch[2]));
  }

  // Для каждого шрифта: его объект → объект CMap → разобранная карта.
  const cmapByAlias = new Map<string, Map<number, string>>();
  for (const [alias, objectNumber] of fontObjectByAlias) {
    /*
     * Граница слева обязательна: без неё `9 0 obj` совпадает внутри
     * `19 0 obj` (FontDescriptor), у которого нет `/ToUnicode`, и карта
     * обычного шрифта не находится вовсе — текст, набранный им, пропадал из
     * результата.
     */
    const fontObject = raw.match(
      new RegExp(`(?<!\\d)${objectNumber}\\s+0\\s+obj([\\s\\S]*?)endobj`),
    );
    const toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontObject?.[1] ?? '');
    if (toUnicode === null) continue;
    const cmapStream = streamByObject.get(Number(toUnicode[1]));
    if (cmapStream === undefined) continue;
    cmapByAlias.set(alias, parseCMap(cmapStream));
  }

  /** Декодировать hex-строку глифов по карте текущего шрифта. */
  const decode = (hex: string, map: Map<number, string> | undefined): string => {
    let value = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      value += map?.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
    }
    return value;
  };

  /*
   * Текст собирается из потоков содержимого с отслеживанием текущего шрифта.
   * Hex-строки вне операторов показа игнорируются: иначе в результат попадают
   * числа цветов и матриц преобразования.
   */
  let text = '';
  for (const [number, stream] of streamByObject) {
    if (stream.includes('beginbfrange') || stream.includes('beginbfchar')) continue;
    if (!stream.includes('BT')) continue;
    void number;

    const tokenRe = /\/(F\d+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj/g;
    let currentMap: Map<number, string> | undefined;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenRe.exec(stream)) !== null) {
      if (tokenMatch[1] !== undefined) {
        currentMap = cmapByAlias.get(tokenMatch[1]);
        continue;
      }
      if (tokenMatch[2] !== undefined) {
        for (const hexMatch of tokenMatch[2].matchAll(/<([0-9A-Fa-f]+)>/g)) {
          text += decode(hexMatch[1] ?? '', currentMap);
        }
        text += '\n';
        continue;
      }
      text += decode(tokenMatch[3] ?? '', currentMap) + '\n';
    }
  }

  return text;
}

/** Собрать акт на `count` заказов — для проверки переноса строк. */
async function buildManyAct(count: number): Promise<Buffer> {
  const snapshot: BatchActSnapshot = {
    ...SNAPSHOT,
    itemsCount: count,
    totalAmountMinor: count * 1000,
    items: Array.from({ length: count }, (_, index) => ({
      orderId: `o${index}`,
      orderNo: `MSK1-2609-${String(index + 1).padStart(6, '0')}`,
      customerName: `Клиент ${index + 1}`,
      totalAmountMinor: 1000,
    })),
  };
  return service.buildActPdf({
    actNo: 'АПП-25-000118',
    companyName: 'Ремонт ювелирных изделий',
    snapshot,
    signedByFromName: null,
    signedByToName: null,
    signedFromAt: null,
    signedToAt: null,
  });
}

/**
 * Извлечь строки состава вместе с их координатой `y`.
 *
 * PDFKit перед показом текста пишет матрицу `1 0 0 1 x y Tm`. Координата `y`
 * считается от НИЗА листа в системе PDF, но PDFKit пишет документ с
 * перевёрнутой осью (`1 0 0 -1 0 841.89 cm`), поэтому значения `Tm` здесь
 * отсчитываются сверху вниз — то есть растут вниз, как `doc.y`. Проверка
 * «строка внутри листа» сравнивает их с высотой A4.
 */
async function extractRows(pdf: Buffer): Promise<Array<{ text: string; y: number }>> {
  const zlib = await import('node:zlib');
  const raw = pdf.toString('latin1');
  const rows: Array<{ text: string; y: number }> = [];

  const objectRe = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = objectRe.exec(raw)) !== null) {
    const body = objectMatch[2] ?? '';
    const streamMatch = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(body);
    if (streamMatch === null) continue;
    let stream: string;
    try {
      stream = zlib.inflateSync(Buffer.from(streamMatch[1] ?? '', 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    if (!stream.includes('BT') || stream.includes('beginbfrange')) continue;

    // Матрица `1 0 0 1 x y Tm` непосредственно перед показом текста.
    const re =
      /1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*(?:\/[\w.]+ [\d.]+ Tf\s*)?(?:\[([^\]]*)\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stream)) !== null) {
      const y = Number(match[2]);
      const hexes = [
        ...(match[3] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g),
        ...(match[4] === undefined ? [] : [{ 1: match[4] }]),
      ];
      const text = hexes.map((h) => h[1] ?? '').join('');
      rows.push({ text, y });
    }
  }

  return rows;
}

describe('BatchActPdfService: документ акта', () => {
  it('собирает непустой PDF', async () => {
    const pdf = await service.buildActPdf({
      actNo: 'АПП-25-000118',
      companyName: 'Ремонт ювелирных изделий',
      snapshot: SNAPSHOT,
      signedByFromName: null,
      signedByToName: null,
      signedFromAt: null,
      signedToAt: null,
    });

    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('содержит кириллицу, а не пустые квадраты', async () => {
    /*
     * Ключевая проверка: на сервере нет системных шрифтов, и без встроенного
     * DejaVu русский текст вышел бы нечитаемым. Проверяется, что русские слова
     * реально присутствуют в тексте документа.
     */
    const pdf = await service.buildActPdf({
      actNo: 'АПП-25-000118',
      companyName: 'Ремонт ювелирных изделий',
      snapshot: SNAPSHOT,
      signedByFromName: null,
      signedByToName: null,
      signedFromAt: null,
      signedToAt: null,
    });

    const text = await extractText(pdf);

    expect(text).toContain('Ремонт ювелирных изделий');
    expect(text).toContain('Подписи сторон');
    expect(text).toContain('Сдал (отправитель)');
    expect(text).toContain('Принял (получатель)');
  });

  it('печатает состав партии из снимка', async () => {
    const pdf = await service.buildActPdf({
      actNo: 'АПП-25-000118',
      companyName: 'Ремонт ювелирных изделий',
      snapshot: SNAPSHOT,
      signedByFromName: null,
      signedByToName: null,
      signedFromAt: null,
      signedToAt: null,
    });

    const text = await extractText(pdf);

    expect(text).toContain('MSK1-2609-000001');
    expect(text).toContain('MSK1-2609-000002');
    expect(text).toContain('Иванов Иван Иванович');
    expect(text).toContain('Петрова Анна Сергеевна');
    expect(text).toContain('П-250916-004');
  });

  it('печатает стороны передачи', async () => {
    const pdf = await service.buildActPdf({
      actNo: 'АПП-25-000118',
      companyName: 'Ремонт ювелирных изделий',
      snapshot: SNAPSHOT,
      signedByFromName: null,
      signedByToName: null,
      signedFromAt: null,
      signedToAt: null,
    });

    const text = await extractText(pdf);

    expect(text).toContain('Магазин на Тверской');
    expect(text).toContain('Центральный цех');
    expect(text).toContain('в цех');
  });

  it('печатает сумму и число заказов', async () => {
    const pdf = await service.buildActPdf({
      actNo: 'АПП-25-000118',
      companyName: 'Ремонт ювелирных изделий',
      snapshot: SNAPSHOT,
      signedByFromName: null,
      signedByToName: null,
      signedFromAt: null,
      signedToAt: null,
    });

    const text = await extractText(pdf);

    /*
     * 150000 копеек = 1 500,00 ₽. Разделитель разрядов — НЕразрывный пробел
     * (U+00A0), поэтому в проверке он задан явно: с обычным пробелом тест не
     * проходил, хотя документ был верным.
     */
    expect(text).toContain('1\u00a0500,00');
    expect(text).toContain('2 заказа');
  });

  it('печатает ФИО и дату, если акт подписан', async () => {
    // После подписания в документе должны быть ФИО и дата: иначе непонятно,
    // кто и когда подписал.
    const pdf = await service.buildActPdf({
      actNo: 'АПП-25-000118',
      companyName: 'Ремонт ювелирных изделий',
      snapshot: SNAPSHOT,
      signedByFromName: 'Волков Игорь Николаевич',
      signedByToName: 'Морозов Виктор Андреевич',
      signedFromAt: new Date('2025-09-16T10:00:00Z'),
      signedToAt: null,
    });

    const text = await extractText(pdf);

    expect(text).toContain('Волков Игорь Николаевич');
    expect(text).toContain('подписано');
  });

  it('до подписания оставляет пустые строки подписей', async () => {
    // Акт печатают ДО подписания, чтобы подписать на бумаге: строки подписей
    // обязаны быть в документе и без подписи.
    const pdf = await service.buildActPdf({
      actNo: 'АПП-25-000118',
      companyName: 'Ремонт ювелирных изделий',
      snapshot: SNAPSHOT,
      signedByFromName: null,
      signedByToName: null,
      signedFromAt: null,
      signedToAt: null,
    });

    const text = await extractText(pdf);

    expect(text).toContain('подпись');
    expect(text).not.toContain('подписано');
  });

  it('печатает номер акта', async () => {
    const pdf = await service.buildActPdf({
      actNo: 'АПП-25-000118',
      companyName: 'Ремонт ювелирных изделий',
      snapshot: SNAPSHOT,
      signedByFromName: null,
      signedByToName: null,
      signedFromAt: null,
      signedToAt: null,
    });

    expect(await extractText(pdf)).toContain('АПП-25-000118');
  });

  it('документ на 40 заказов переносится на несколько страниц', async () => {
    // Партия может содержать десятки заказов: без переноса строки они ушли бы
    // за пределы листа, и изделия «потерялись» бы при печати.
    const pdf = await buildManyAct(40);
    const pageCount = Number(/\/Count\s+(\d+)/.exec(pdf.toString('latin1'))?.[1] ?? '1');

    expect(pageCount).toBeGreaterThan(1);
  });

  it('строки состава размещаются компактно, а не по странице на строку', async () => {
    /*
     * ГЛАВНАЯ проверка переноса, и она не про «строки за листом». PDFKit сам
     * добавляет страницу, когда координата уходит ниже поля, поэтому при
     * отключённом переносе каждая строка получает СВОЮ страницу: 100 заказов
     * дают 126 страниц вместо трёх (измерено). Такой акт невозможно ни
     * напечатать, ни подписать.
     *
     * Поэтому проверяется число страниц: 40 заказов обязаны уложиться в
     * несколько листов, а не в полсотни.
     */
    const pdf = await buildManyAct(40);
    const pageCount = Number(/\/Count\s+(\d+)/.exec(pdf.toString('latin1'))?.[1] ?? '1');

    expect(pageCount).toBeGreaterThan(1); // акт не влезает на один лист
    expect(pageCount, `страниц: ${pageCount}`).toBeLessThanOrEqual(5);
  });

  it('ни одна строка состава не уходит за нижнее поле листа', async () => {
    // Дополняет проверку страниц: координата каждой строки обязана быть внутри
    // листа. Строка ниже поля на бумаге не печатается.
    const pdf = await buildManyAct(40);
    const rows = await extractRows(pdf);

    expect(rows.length).toBeGreaterThanOrEqual(40);

    const bottomLimit = 841.89 - 40;
    const offPage = rows.filter((row) => row.y > bottomLimit);
    expect(offPage, `за пределами листа: ${offPage.map((r) => r.y).join(', ')}`).toEqual([]);
  });

  it('все 40 заказов присутствуют в документе', async () => {
    const text = await extractText(await buildManyAct(40));

    expect(text).toContain('MSK1-2609-000001');
    expect(text).toContain('MSK1-2609-000040');
  });
});

describe('Склонение числа заказов', () => {
  it('выбирает правильную форму', () => {
    // Неверная форма в акте выглядит как небрежность документа.
    expect(plural(1, 'заказ', 'заказа', 'заказов')).toBe('заказ');
    expect(plural(2, 'заказ', 'заказа', 'заказов')).toBe('заказа');
    expect(plural(4, 'заказ', 'заказа', 'заказов')).toBe('заказа');
    expect(plural(5, 'заказ', 'заказа', 'заказов')).toBe('заказов');
    expect(plural(11, 'заказ', 'заказа', 'заказов')).toBe('заказов');
    expect(plural(21, 'заказ', 'заказа', 'заказов')).toBe('заказ');
    expect(plural(22, 'заказ', 'заказа', 'заказов')).toBe('заказа');
    expect(plural(25, 'заказ', 'заказа', 'заказов')).toBe('заказов');
    expect(plural(0, 'заказ', 'заказа', 'заказов')).toBe('заказов');
  });
});
