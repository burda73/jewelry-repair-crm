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
  buildReceiptRows,
  receiptNotice,
  formatReceiptDate,
  type ReceiptData,
} from '@app/shared';

/** Путь к встроенному шрифту. Разрешается из `node_modules`, а не из системы. */
const FONT_REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const MARGIN = 40;
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#cbd5e1';

/** Данные квитанции вместе с названием организации и магазина. */
export interface ReceiptContext extends ReceiptData {
  /** Название организации в шапке. */
  companyName: string;
  /** ФИО сотрудника, принявшего заказ. */
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

  /** Собрать документ из уже готовых изображений кодов. */
  private compose(data: ReceiptContext, qrPng: Buffer, code128Png: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font(FONT_BOLD);
      this.drawHeader(doc, data);
      this.drawCodes(doc, data, qrPng, code128Png);
      this.drawRows(doc, data);
      this.drawFooter(doc, data);

      doc.end();
    });
  }

  /** Шапка: организация, магазин и крупный номер заказа. */
  private drawHeader(doc: PDFKit.PDFDocument, data: ReceiptContext): void {
    doc.fontSize(16).fillColor(INK).text(data.companyName, { continued: false });
    doc.moveDown(0.2);
    doc.font(FONT_REGULAR).fontSize(10).fillColor(MUTED).text(data.storeName);

    doc.moveDown(0.6);
    doc.font(FONT_BOLD).fontSize(13).fillColor(INK).text('КВИТАНЦИЯ О ПРИЁМЕ ЗАКАЗА');
    doc.moveDown(0.3);

    /*
     * Номер заказа печатается крупным моноширинным текстом: это третий способ
     * ввода (после QR и Code128) — приёмщик может набрать его вручную, поэтому
     * он должен читаться без напряжения.
     */
    doc.font(FONT_BOLD).fontSize(22).fillColor(INK).text(data.orderNo, { characterSpacing: 1 });
    doc.moveDown(0.2);
    doc
      .font(FONT_REGULAR)
      .fontSize(10)
      .fillColor(MUTED)
      .text(`Принят: ${formatReceiptDate(data.createdAt)} · ${data.acceptedBy}`);

    doc.moveDown(0.8);
    this.horizontalLine(doc);
  }

  /** QR-код и линейный код рядом с номером. */
  private drawCodes(
    doc: PDFKit.PDFDocument,
    data: ReceiptContext,
    qrPng: Buffer,
    code128Png: Buffer,
  ): void {
    const top = doc.y;

    doc.image(qrPng, MARGIN, top, { width: 120 });
    // Подпись под QR: клиент и сотрудник должны понимать, что это для сканера.
    doc
      .font(FONT_REGULAR)
      .fontSize(8)
      .fillColor(MUTED)
      .text('Сканируйте для быстрого поиска заказа', MARGIN, top + 124, { width: 120 });

    const rightX = MARGIN + 130;
    doc.font(FONT_BOLD).fontSize(10).fillColor(INK).text('Резервный штрих-код', rightX, top);
    doc.image(code128Png, rightX, top + 16, { width: 200 });
    doc
      .font(FONT_REGULAR)
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        receiptNotice({ isWarranty: data.isWarranty, requiresPrepayment: data.requiresPrepayment }),
        rightX,
        top + 60,
        { width: 240 },
      );

    doc.y = top + 140;
    doc.x = MARGIN;
    doc.moveDown(0.4);
    this.horizontalLine(doc);
  }

  /** Таблица «подпись — значение»: состав берётся из домена, не дублируется. */
  private drawRows(doc: PDFKit.PDFDocument, data: ReceiptContext): void {
    const valueX = MARGIN + 150;
    const valueWidth = doc.page.width - MARGIN * 2 - 150;

    for (const row of buildReceiptRows(data)) {
      const labelY = doc.y;
      doc.font(FONT_BOLD).fontSize(10).fillColor(MUTED).text(`${row.label}:`, MARGIN, labelY, {
        width: 140,
      });
      const afterLabel = doc.y;

      doc.font(FONT_REGULAR).fontSize(10).fillColor(INK).text(row.value, valueX, labelY, {
        width: valueWidth,
      });
      const afterValue = doc.y;

      // Строка занимает высоту большей из колонок — иначе длинное значение
      // («Работы») наехало бы на следующую строку.
      doc.y = Math.max(afterLabel, afterValue) + 4;
      doc.x = MARGIN;
    }
  }

  /** Подписи сторон и отметка о копии. */
  private drawFooter(doc: PDFKit.PDFDocument, data: ReceiptContext): void {
    doc.moveDown(0.6);
    this.horizontalLine(doc);
    doc.moveDown(0.8);

    const half = (doc.page.width - MARGIN * 2) / 2;
    const lineY = doc.y + 22;

    doc.font(FONT_REGULAR).fontSize(9).fillColor(MUTED);
    doc.text('Изделие сдал (клиент)', MARGIN, doc.y, { width: half - 10 });
    doc.text('Изделие принял (сотрудник)', MARGIN + half + 10, doc.y - doc.currentLineHeight(), {
      width: half - 10,
    });

    // Линии для подписей рисуются отдельно: PDFKit не умеет «подчёркнутое поле».
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(MARGIN + half - 30, lineY)
      .strokeColor(LINE)
      .stroke();
    doc
      .moveTo(MARGIN + half + 10, lineY)
      .lineTo(MARGIN + half * 2 - 20, lineY)
      .strokeColor(LINE)
      .stroke();

    doc.y = lineY + 10;
    doc
      .font(FONT_REGULAR)
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `Копия № ${data.copyNumber}. Срок хранения квитанции — до получения изделия.`,
        MARGIN,
        doc.y,
      );
    doc.text(
      'Проверьте изделие и указанные сведения при получении. Претензии по внешнему виду принимаются при выдаче.',
      MARGIN,
      doc.y + 10,
      { width: doc.page.width - MARGIN * 2 },
    );
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
