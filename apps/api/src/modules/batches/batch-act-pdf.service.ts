/**
 * Формирование PDF акта приёма-передачи партии (задача 2.3, ТЗ п. 2.6).
 *
 * Почему PDF, а не печать HTML-страницы: акт подписывают обе стороны, и он
 * должен выглядеть одинаково на любом рабочем месте, не зависеть от настроек
 * браузера (масштаб, колонтитулы, «печать фона») и сохраниться в неизменном
 * виде. Приёмщик и цех нажимают кнопку — драйверы и агенты печати не нужны.
 *
 * Шрифт встраивается в PDF. На сервере нет НИ ОДНОГО системного шрифта
 * (проверено: `/usr/share/fonts` отсутствует), поэтому кириллица вышла бы
 * пустыми квадратами. DejaVu Sans лежит в зависимостях (`dejavu-fonts-ttf`) и
 * попадает в сборку вместе с кодом — тот же приём, что в квитанции заказа.
 *
 * Документ печатается ИЗ СНИМКА (`BatchAct.itemsSnapshot`), а не из текущих
 * заказов: подписанный акт обязан оставаться тем же документом, даже если заказ
 * позже переименовали или клиент сменил ФИО.
 */

import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { formatDate, formatMoney, type BatchActSnapshot } from '@app/shared';

/** Путь к встроенному шрифту. Разрешается из `node_modules`, а не из системы. */
const FONT_REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const MARGIN = 40;
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#cbd5e1';

/** Данные акта вместе с названием организации. */
export interface BatchActPdfContext {
  /** Номер акта (`АПП-25-000118`). */
  actNo: string;
  /** Название организации в шапке. */
  companyName: string;
  snapshot: BatchActSnapshot;
  /** ФИО подписавших, если подпись уже стоит. */
  signedByFromName: string | null;
  signedByToName: string | null;
  signedFromAt: Date | null;
  signedToAt: Date | null;
}

@Injectable()
export class BatchActPdfService {
  /**
   * Собрать PDF акта и вернуть готовый буфер.
   *
   * PDFKit — поток: документ отдаёт куски по мере отрисовки, поэтому буфер
   * собирается по событию `end`. Промежуточных файлов не создаётся: акт
   * отдаётся потоком в ответе и не остаётся на диске сервера.
   */
  async buildActPdf(data: BatchActPdfContext): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font(FONT_BOLD);
      this.drawHeader(doc, data);
      this.drawParties(doc, data);
      this.drawItems(doc, data);
      this.drawTotals(doc, data);
      this.drawSignatures(doc, data);

      doc.end();
    });
  }

  /** Шапка: организация и заголовок документа. */
  private drawHeader(doc: PDFKit.PDFDocument, data: BatchActPdfContext): void {
    doc.fontSize(15).fillColor(INK).text(data.companyName);
    doc.moveDown(0.2);
    doc.font(FONT_REGULAR).fontSize(10).fillColor(MUTED).text('Акт приёма-передачи');
    doc.moveDown(0.6);

    doc.font(FONT_BOLD).fontSize(14).fillColor(INK);
    doc.text(`Акт № ${data.actNo}`);
    doc.font(FONT_REGULAR).fontSize(9).fillColor(MUTED);
    doc.text(`от ${formatDate(new Date(data.snapshot.formedAt))}`);
    doc.moveDown(0.8);
    this.rule(doc);
  }

  /** Стороны передачи: откуда и куда перемещается партия. */
  private drawParties(doc: PDFKit.PDFDocument, data: BatchActPdfContext): void {
    const { snapshot } = data;
    doc.font(FONT_BOLD).fontSize(10).fillColor(INK);
    doc.text('Передача партии');
    doc.moveDown(0.3);

    doc.font(FONT_REGULAR).fontSize(9.5).fillColor(INK);
    doc.text(`Партия: ${snapshot.batchNo}`);
    doc.text(`Направление: ${directionLabel(snapshot.direction)}`);
    doc.text(`Откуда: ${snapshot.fromLabel}`);
    doc.text(`Куда: ${snapshot.toLabel}`);
    doc.moveDown(0.8);
  }

  /** Таблица состава: номер заказа, клиент, сумма. */
  private drawItems(doc: PDFKit.PDFDocument, data: BatchActPdfContext): void {
    const { items } = data.snapshot;
    doc.font(FONT_BOLD).fontSize(10).fillColor(INK);
    doc.text(
      `Состав партии — ${items.length} ${plural(items.length, 'заказ', 'заказа', 'заказов')}`,
    );
    doc.moveDown(0.3);

    // Координаты колонок фиксированы: строки должны выравниваться, а `text`
    // с `continued` этого не даёт при разной длине значений.
    const left = MARGIN;
    const customerX = left + 150;
    const amountX = left + 420;

    const headerY = doc.y;
    doc.font(FONT_REGULAR).fontSize(8).fillColor(MUTED);
    doc.text('№ заказа', left, headerY, { width: 150 });
    doc.text('Клиент', customerX, headerY, { width: 260 });
    doc.text('Сумма', amountX, headerY, { width: 90, align: 'right' });
    doc.y = headerY + 14;
    this.rule(doc);

    doc.font(FONT_REGULAR).fontSize(9).fillColor(INK);
    let rowY = doc.y + 4;
    for (const item of items) {
      /*
       * Перенос строки по странице: партия может содержать десятки заказов, и
       * без переноса строки уходили бы за пределы листа — акт стал бы
       * нечитаемым, а изделия «потерялись» бы при печати.
       */
      if (rowY > doc.page.height - MARGIN - 140) {
        doc.addPage();
        rowY = MARGIN;
      }
      doc.text(item.orderNo, left, rowY, { width: 145 });
      // ФИО обрезается по ширине колонки: длинное имя не должно наезжать на сумму.
      doc.text(item.customerName, customerX, rowY, { width: 255, ellipsis: true, height: 12 });
      doc.text(formatMoney(item.totalAmountMinor), amountX, rowY, { width: 90, align: 'right' });
      rowY += 15;
    }

    doc.y = rowY + 4;
    this.rule(doc);
  }

  /** Итог по составу. */
  private drawTotals(doc: PDFKit.PDFDocument, data: BatchActPdfContext): void {
    doc.moveDown(0.5);
    doc.font(FONT_BOLD).fontSize(10).fillColor(INK);
    doc.text(
      `Итого: ${data.snapshot.itemsCount} ${plural(data.snapshot.itemsCount, 'заказ', 'заказа', 'заказов')} на сумму ${formatMoney(data.snapshot.totalAmountMinor)}`,
      { align: 'right' },
    );
    doc.moveDown(0.5);
  }

  /**
   * Строки для подписей сторон.
   *
   * Подписи рисуются всегда — и когда подпись уже стоит (с ФИО и датой), и
   * когда нет (пустые линии для подписи от руки). Акт без строк подписей
   * юридически бессмыслен, поэтому они часть документа, а не украшение.
   */
  private drawSignatures(doc: PDFKit.PDFDocument, data: BatchActPdfContext): void {
    const { snapshot } = data;

    // Если до низа листа мало места, строки подписей переносятся на новый лист
    // целиком: разорванная подпись недействительна.
    if (doc.y > doc.page.height - MARGIN - 150) doc.addPage();

    doc.moveDown(1.2);
    doc.font(FONT_BOLD).fontSize(10).fillColor(INK).text('Подписи сторон');
    doc.moveDown(0.8);

    const left = MARGIN;
    const right = doc.page.width / 2 + 10;
    const lineWidth = doc.page.width / 2 - MARGIN - 20;

    this.signatureBlock(doc, {
      x: left,
      y: doc.y,
      width: lineWidth,
      role: 'Сдал (отправитель)',
      party: snapshot.fromLabel,
      name: data.signedByFromName,
      at: data.signedFromAt,
    });
    this.signatureBlock(doc, {
      x: right,
      y: doc.y,
      width: lineWidth,
      role: 'Принял (получатель)',
      party: snapshot.toLabel,
      name: data.signedByToName,
      at: data.signedToAt,
    });
  }

  /** Один блок подписи: роль, сторона, линия, ФИО и дата. */
  private signatureBlock(
    doc: PDFKit.PDFDocument,
    params: {
      x: number;
      y: number;
      width: number;
      role: string;
      party: string;
      name: string | null;
      at: Date | null;
    },
  ): void {
    doc.font(FONT_REGULAR).fontSize(8.5).fillColor(MUTED);
    doc.text(params.role, params.x, params.y, { width: params.width });
    doc.text(params.party, params.x, params.y + 11, { width: params.width });

    const lineY = params.y + 40;
    doc
      .moveTo(params.x, lineY)
      .lineTo(params.x + params.width, lineY)
      .strokeColor(LINE)
      .lineWidth(0.7)
      .stroke();

    doc.font(FONT_REGULAR).fontSize(7.5).fillColor(MUTED);
    doc.text('подпись', params.x, lineY + 3, { width: params.width });

    /*
     * Если подпись уже поставлена, под линией печатается ФИО и дата. Если нет —
     * остаётся пустая линия: акт печатают ДО подписания, чтобы подписать на
     * бумаге, и пустое место здесь ожидаемо, а не дефект.
     */
    if (params.name !== null) {
      doc.font(FONT_REGULAR).fontSize(9).fillColor(INK);
      doc.text(params.name, params.x, lineY + 16, { width: params.width });
      if (params.at !== null) {
        doc.font(FONT_REGULAR).fontSize(7.5).fillColor(MUTED);
        doc.text(`подписано ${formatDate(params.at)}`, params.x, lineY + 28, {
          width: params.width,
        });
      }
    }
  }

  /** Горизонтальная линия на текущей позиции. */
  private rule(doc: PDFKit.PDFDocument): void {
    const y = doc.y;
    doc
      .moveTo(MARGIN, y)
      .lineTo(doc.page.width - MARGIN, y)
      .strokeColor(LINE)
      .lineWidth(0.7)
      .stroke();
    doc.y = y + 6;
  }
}

/** Направление партии словами. */
function directionLabel(direction: string): string {
  return direction === 'TO_PRODUCTION' ? 'в цех' : 'в магазин';
}

/**
 * Русское склонение существительного при числе.
 *
 * Нужно для читаемости документа: «1 заказ», «2 заказа», «5 заказов».
 * Неверная форма в акте выглядит как небрежность документа.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
