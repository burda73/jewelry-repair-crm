/**
 * Формирование PDF-квитанции приёма заказа (ответ A4, docs/08-ui-ux.md §4.1).
 *
 * Почему PDF, а не печать HTML-страницы: квитанция должна выглядеть одинаково
 * на любом рабочем месте и не зависеть от настроек браузера (масштаб, колонтитулы,
 * «печать фона»). Приёмщик открывает карточку и нажимает кнопку — драйверы и
 * агенты печати не нужны.
 *
 * Шрифт встраивается в PDF: на сервере нет НИ ОДНОГО системного шрифта
 * (проверено: `/usr/share/fonts` отсутствует), поэтому полагаться на системный
 * шрифт нельзя — кириллица вышла бы пустыми квадратами. DejaVu Sans лежит в
 * зависимостях (`dejavu-fonts-ttf`) и попадает в сборку вместе с кодом.
 *
 * QR-код и линейный код рисуются `bwip-js` в PNG и вставляются картинкой:
 * так PDF остаётся векторным для текста (можно выделить и скопировать номер),
 * а коды читаются сканером с бумаги при печати на обычном A4.
 */

import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import {
  buildReceiptBarcode,
  buildReceiptQr,
  buildReceiptSignatures,
  buildReceiptTotals,
  formatMoney,
  formatReceiptDate,
  isFilled,
  metalTableColumns,
  type ReceiptData,
} from '@app/shared';

/** Путь к встроенному шрифту. Разрешается из `node_modules`, а не из системы. */
const FONT_REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const MARGIN = 40;
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#cbd5e1';
/** Фон шапок таблиц: отделяет подписи колонок от данных. */
const HEADER_BG = '#f1f5f9';

/** Данные квитанции вместе с реквизитами для шапки и подвала. */
export interface ReceiptContext extends ReceiptData {
  /** ФИО сотрудника, принявшего заказ (автор заказа). */
  acceptedBy: string;
  /** Номер печатаемой копии — считает сервер. */
  copyNumber: number;
}

@Injectable()
export class ReceiptService {
  /**
   * Собрать PDF-квитанцию и вернуть готовый буфер.
   *
   * Метод асинхронный только из-за генерации кодов (`bwip-js`): сам PDFKit
   * собирается в памяти синхронно. Промежуточных файлов не создаётся —
   * квитанция не должна оставаться на диске сервера.
   */
  async buildReceiptPdf(data: ReceiptContext): Promise<Buffer> {
    const qrPng = await this.renderBarcode({
      bcid: 'qrcode',
      text: buildReceiptQr({ orderNo: data.orderNo }),
      // Крупный масштаб: код печатается на A4 и должен читаться сканером
      // с расстояния, а не только вплотную.
      scale: 8,
    });
    const code128Png = await this.renderBarcode({
      bcid: 'code128',
      text: buildReceiptBarcode({ orderNo: data.orderNo }),
      scale: 2,
      height: 12,
    });

    return this.compose(data, qrPng, code128Png);
  }

  /** Отрисовать код в PNG. */
  private async renderBarcode(options: {
    bcid: string;
    text: string;
    scale: number;
    height?: number;
  }): Promise<Buffer> {
    return bwipjs.toBuffer({
      bcid: options.bcid,
      text: options.text,
      scale: options.scale,
      /*
       * Белый фон обязателен. По умолчанию `bwip-js` делает фон ПРОЗРАЧНЫМ,
       * и такой код не читается: декодер (и часть сканеров) не видит границы
       * модулей. Проверено декодированием — при прозрачном фоне QR не
       * распознаётся ни на одном масштабе, при белом читается сразу.
       * На бумаге прозрачность дала бы серый код на сером фоне после печати.
       */
      backgroundcolor: 'FFFFFF',
      includetext: false,
      // Поля вокруг кода: сканеру нужен «тихий» край, иначе он не поймает код
      // при печати вплотную к тексту.
      paddingwidth: 2,
      paddingheight: 2,
      ...(options.height === undefined ? {} : { height: options.height }),
    });
  }

  /**
   * Собрать документ по образцу заказчика.
   *
   * ПОРЯДОК БЛОКОВ повторяет бумажную форму: шапка с QR, данные заказчика,
   * таблица принятого металла, таблица работ, денежный блок, подписи. Отступать
   * от него нельзя — приёмщик и клиент читают документ слева направо сверху
   * вниз, и переставленный блок ищут не там.
   */
  private compose(data: ReceiptContext, qrPng: Buffer, code128Png: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.drawHeader(doc, data, qrPng);
      this.drawCustomer(doc, data);
      this.drawMetal(doc, data);
      this.drawWorks(doc, data);
      this.drawTotals(doc, data);
      this.drawSignatures(doc, data);
      this.drawCodes(doc, code128Png);

      doc.end();
    });
  }

  /**
   * Шапка: организация, номер заказа с датой, магазин с телефоном и QR-код.
   *
   * QR в правом верхнем углу, как в образце: это первое, что находит взгляд
   * сотрудника, когда он берёт квитанцию, чтобы отсканировать её.
   */
  private drawHeader(doc: PDFKit.PDFDocument, data: ReceiptContext, qrPng: Buffer): void {
    const qrSize = 88;
    const textWidth = doc.page.width - MARGIN * 2 - qrSize - 12;

    const top = doc.y;
    doc.image(qrPng, doc.page.width - MARGIN - qrSize, top, { width: qrSize });

    doc.font(FONT_BOLD).fontSize(13).fillColor(INK);
    doc.text(data.organizationName, MARGIN, top, { width: textWidth });
    doc.moveDown(0.35);

    /*
     * Номер и дата одной строкой, как «Заказ клиента № BB0000625 от 20.09.2026».
     * Дата из `createdAt` — момент приёма, а не печати: перепечатанная копия
     * должна показывать исходную дату, иначе по ней нельзя сверить срок.
     */
    doc
      .font(FONT_BOLD)
      .fontSize(14)
      .fillColor(INK)
      .text(`Заказ № ${data.orderNo} от ${formatReceiptDate(data.createdAt)}`, MARGIN, doc.y, {
        width: textWidth,
      });
    doc.moveDown(0.3);

    doc.font(FONT_REGULAR).fontSize(10).fillColor(MUTED);
    doc.text(
      isFilled(data.storePhone)
        ? `Магазин: ${data.storeName}, тел. ${data.storePhone}`
        : `Магазин: ${data.storeName}`,
      MARGIN,
      doc.y,
      { width: textWidth },
    );

    // Высота шапки — не меньше QR: иначе картинка наехала бы на следующий блок.
    doc.y = Math.max(doc.y, top + qrSize) + 10;
    doc.x = MARGIN;
    this.horizontalLine(doc);
  }

  /** Заказчик: ФИО, адрес и телефон. */
  private drawCustomer(doc: PDFKit.PDFDocument, data: ReceiptContext): void {
    const valueX = MARGIN + 70;
    const valueWidth = doc.page.width - MARGIN - valueX;

    /** Строка «подпись: значение»; пустые значения не печатаются. */
    const row = (label: string, value: string | null): void => {
      if (!isFilled(value)) return;
      const y = doc.y;
      doc.font(FONT_REGULAR).fontSize(10).fillColor(MUTED).text(`${label}:`, MARGIN, y, {
        width: 66,
      });
      doc
        .font(FONT_REGULAR)
        .fontSize(10)
        .fillColor(INK)
        .text(value ?? '', valueX, y, {
          width: valueWidth,
        });
      doc.x = MARGIN;
    };

    row('Заказчик', data.customerName);
    /*
     * Адрес необязателен: у разового клиента его может не быть. Пустая строка
     * «Адрес: » в документе выглядит как незаполненный бланк.
     */
    row('Адрес', data.customerAddress);
    row('Телефон', data.customerPhone);

    doc.moveDown(0.5);
  }

  /**
   * Таблица принятого металла: наименование, проба, вес.
   *
   * Печатается ТОЛЬКО графа «Принято»: выдача, расход и потери относятся к
   * изготовлению изделия из металла клиента, а при ремонте вещь возвращается
   * владельцу целиком. Дефекты идут строкой под таблицей — в образце они стоят
   * отдельной колонкой, но текст бывает длинным и растянул бы таблицу.
   */
  private drawMetal(doc: PDFKit.PDFDocument, data: ReceiptContext): void {
    if (data.items.length === 0) return;

    /*
     * Наименование металла вчетверо шире каждой из колонок «Проба» и «Принято».
     * Пропорция живёт в домене (`metalTableColumns`), потому что это требование
     * к документу, а не деталь отрисовки: там её можно проверить тестом без
     * сборки PDF.
     */
    const usable = doc.page.width - MARGIN * 2;
    const columns = metalTableColumns(usable);

    this.tableHeader(doc, ['Наименование металла', 'Проба', 'Принято, г'], columns, [
      'left',
      'center',
      'center',
    ]);

    for (const item of data.items) {
      /*
       * Наименование принятой ценности: «Кольцо золото 585». Металл отдельной
       * колонкой не дублируется — он уже назван в наименовании, а в образце
       * колонка называется «Наименование металла».
       */
      const metal = [item.metal, item.name].filter((part) => isFilled(part)).join(', ');
      this.tableRow(
        doc,
        [metal === '' ? '—' : metal, item.hallmark ?? '—', formatGram(item.weightGram)],
        columns,
        ['left', 'center', 'center'],
      );
    }

    /*
     * Дефекты — одной строкой под таблицей с указанием изделия: в заказе их
     * может быть несколько, и «Разрыв шинки» без названия вещи непонятно к чему
     * относится, а в споре о повреждении это решает.
     */
    const defects = data.items
      .filter((item) => isFilled(item.defects))
      .map((item) => `${item.name}: ${(item.defects ?? '').trim()}`);
    if (defects.length > 0) {
      doc.moveDown(0.3);
      doc.font(FONT_REGULAR).fontSize(9).fillColor(MUTED);
      doc.text(`Описание дефектов и ценностей: ${defects.join('; ')}`, MARGIN, doc.y, {
        width: usable,
      });
    }

    doc.moveDown(0.6);
  }

  /** Таблица работ: наименование и стоимость — как в калькуляции заказа. */
  private drawWorks(doc: PDFKit.PDFDocument, data: ReceiptContext): void {
    const usable = doc.page.width - MARGIN * 2;
    const columns = [0, usable - 110, 110];

    this.tableHeader(doc, ['Наименование работ и видов оплат', '', 'Стоимость'], columns, [
      'left',
      'left',
      'right',
    ]);

    if (data.works.length === 0 && data.stones.length === 0) {
      this.tableRow(doc, ['—', '', '—'], columns, ['left', 'left', 'right']);
      doc.moveDown(0.6);
      return;
    }

    for (const work of data.works) {
      this.tableRow(doc, [work.name, '', formatMoney(work.amountMinor)], columns, [
        'left',
        'left',
        'right',
      ]);
    }
    for (const stone of data.stones) {
      this.tableRow(doc, [`Камень: ${stone.name}`, '', formatMoney(stone.amountMinor)], columns, [
        'left',
        'left',
        'right',
      ]);
    }

    doc.moveDown(0.6);
  }

  /** Денежный блок: итог и, при предоплате, расчёт с клиентом. */
  private drawTotals(doc: PDFKit.PDFDocument, data: ReceiptContext): void {
    const usable = doc.page.width - MARGIN * 2;
    const labelWidth = usable - 130;
    const valueX = MARGIN + labelWidth;
    const valueWidth = 130;

    for (const row of buildReceiptTotals(data)) {
      const y = doc.y;
      // Итоговая строка набрана жирным: признак `emphasis` приходит из домена,
      // поэтому «Итого» нельзя случайно потерять среди расчётов.
      doc
        .font(row.emphasis ? FONT_BOLD : FONT_REGULAR)
        .fontSize(row.emphasis ? 12 : 10)
        .fillColor(row.emphasis ? INK : MUTED)
        .text(row.label, MARGIN, y, { width: labelWidth });

      doc
        .font(row.emphasis ? FONT_BOLD : FONT_REGULAR)
        .fontSize(row.emphasis ? 12 : 10)
        .fillColor(INK)
        .text(row.value, valueX, y, { width: valueWidth, align: 'right' });

      doc.x = MARGIN;
      doc.y = Math.max(doc.y, y + (row.emphasis ? 16 : 13)) + 2;
    }

    doc.moveDown(0.6);
  }

  /** Юридическая строка и место для подписей сторон. */
  private drawSignatures(doc: PDFKit.PDFDocument, data: ReceiptContext): void {
    const signatures = buildReceiptSignatures({ acceptorName: data.acceptedBy });

    this.horizontalLine(doc);
    doc.moveDown(0.5);

    doc
      .font(FONT_REGULAR)
      .fontSize(10)
      .fillColor(INK)
      .text(signatures.agreement, MARGIN, doc.y, { width: doc.page.width - MARGIN * 2 });

    doc.moveDown(1.6);

    const usable = doc.page.width - MARGIN * 2;
    const half = usable / 2;
    const lineY = doc.y;
    const lineWidth = half - 40;

    // Линии рисуются отдельно: PDFKit не умеет «подчёркнутое поле».
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(MARGIN + lineWidth, lineY)
      .strokeColor(LINE)
      .stroke();
    doc
      .moveTo(MARGIN + half + 20, lineY)
      .lineTo(MARGIN + half + 20 + lineWidth, lineY)
      .strokeColor(LINE)
      .stroke();

    doc.font(FONT_REGULAR).fontSize(9).fillColor(MUTED);
    doc.text(signatures.customerCaption, MARGIN, lineY + 4, { width: lineWidth, align: 'center' });
    /*
     * ФИО приёмщика — из автора заказа, а не из того, кто печатает: квитанцию
     * может перепечатать администратор, и его подпись под чужим приёмом создала
     * бы документ, где подписант не принимал изделие.
     */
    doc.text(
      signatures.acceptorName === null
        ? signatures.acceptorCaption
        : `${signatures.acceptorCaption} ${signatures.acceptorName}`,
      MARGIN + half + 20,
      lineY + 4,
      { width: lineWidth, align: 'center' },
    );

    doc.y = lineY + 26;
    doc.x = MARGIN;
  }

  /** Линейный код и отметка о копии — под подписями. */
  private drawCodes(doc: PDFKit.PDFDocument, code128Png: Buffer): void {
    doc.image(code128Png, MARGIN, doc.y, { width: 200 });
    doc.y += 38;
    doc.font(FONT_REGULAR).fontSize(8).fillColor(MUTED);
    doc.text(
      'Проверьте изделие и указанные сведения при получении. Претензии по внешнему виду принимаются при выдаче.',
      MARGIN,
      doc.y,
      { width: doc.page.width - MARGIN * 2 },
    );
  }

  /** Шапка таблицы: подписи колонок на сером фоне. */
  private tableHeader(
    doc: PDFKit.PDFDocument,
    labels: readonly string[],
    columns: readonly number[],
    aligns: readonly ('left' | 'center' | 'right')[],
  ): void {
    const y = doc.y;
    const height = 16;

    doc
      .rect(
        MARGIN,
        y,
        columns.reduce((a, b) => a + b, 0),
        height,
      )
      .fillColor(HEADER_BG)
      .fill();

    let x = MARGIN;
    for (let i = 0; i < labels.length; i += 1) {
      doc
        .font(FONT_BOLD)
        .fontSize(8)
        .fillColor(MUTED)
        .text(labels[i] ?? '', x + 4, y + 4, { width: (columns[i] ?? 0) - 8, align: aligns[i] });
      x += columns[i] ?? 0;
    }

    doc.y = y + height + 2;
    doc.x = MARGIN;
    doc.fillColor(INK);
  }

  /** Строка таблицы с переносом длинного текста и линией под ней. */
  private tableRow(
    doc: PDFKit.PDFDocument,
    values: readonly string[],
    columns: readonly number[],
    aligns: readonly ('left' | 'center' | 'right')[],
  ): void {
    const y = doc.y;
    let x = MARGIN;
    let bottom = y;

    for (let i = 0; i < values.length; i += 1) {
      doc.font(FONT_REGULAR).fontSize(9).fillColor(INK);
      doc.text(values[i] ?? '', x + 4, y + 3, {
        width: (columns[i] ?? 0) - 8,
        align: aligns[i],
      });
      bottom = Math.max(bottom, doc.y);
      x += columns[i] ?? 0;
    }

    const lineY = bottom + 2;
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(MARGIN + columns.reduce((a, b) => a + b, 0), lineY)
      .strokeColor(LINE)
      .stroke();

    doc.y = lineY + 3;
    doc.x = MARGIN;
  }

  private horizontalLine(doc: PDFKit.PDFDocument): void {
    const y = doc.y;
    doc
      .moveTo(MARGIN, y)
      .lineTo(doc.page.width - MARGIN, y)
      .strokeColor(LINE)
      .stroke();
    doc.y = y + 6;
  }
}

/**
 * Вес в виде «13,200» — с запятой и тремя знаками.
 *
 * Точность приёма сохраняется: `13,2` вместо `13,200` читается как другое
 * измерение, а при споре о недостаче металла значение имеет каждый знак.
 * `null` печатается прочерком: пустая ячейка выглядит как пропуск в документе.
 */
function formatGram(value: string | null): string {
  if (value === null || value.trim() === '') return '—';
  return value.replace('.', ',');
}
