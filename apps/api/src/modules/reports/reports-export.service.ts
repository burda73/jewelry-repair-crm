/**
 * Экспорт отчётов в XLSX и CSV (задача 5.6, docs/06 §6.4).
 *
 * ЗАЧЕМ ЭТО. Отчёт читают на экране, но работают с ним в таблице: свести с
 * прошлым месяцем, отправить в бухгалтерию, построить свою сводную. Скриншот и
 * «сохранить как PDF» для этого не годятся — нужны числа, с которыми Excel
 * умеет считать.
 *
 * ПОЧЕМУ ВЫГРУЗКА ОБЩАЯ, А НЕ ПОД КАЖДЫЙ ОТЧЁТ. Все отчёты возвращают один
 * формат (`columns` + `rows` + `totals`). Значит и выгрузка одна: добавится
 * шестой отчёт — он выгрузится сразу, без нового кода. Это и было целью единого
 * формата (docs/06 §6.1).
 *
 * ДВА ВАЖНЫХ СВОЙСТВА:
 *
 *  1. ЧИСЛА ОСТАЮТСЯ ЧИСЛАМИ. Денежные суммы выгружаются в рублях, а не строкой
 *     «1 800,00 ₽»: строку Excel не просуммирует, и получатель будет складывать
 *     вручную. Часы и проценты — тоже числа; формат отображения задаёт Excel.
 *  2. ВЫГРУЗКА УВАЖАЕТ ПРАВА (docs/06 §6.4). Она строится из того же результата
 *     отчёта, что показан на экране, — то есть из уже отфильтрованного по роли.
 *     Отдельного запроса к базе у выгрузки нет, и обойти область видимости через
 *     `format=xlsx` нельзя.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import {
  REPORT_COLUMN_TYPE,
  type ReportCell,
  type ReportColumn,
  type ReportResult,
  type ReportRow,
} from '@app/shared';
import { ReportsService, type ReportQuery } from './reports.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Формат выгрузки.
 *
 * `CSV` отдаётся с точкой с запятой и BOM: Excel в русской локали ждёт именно
 * `;`, а без BOM кириллица превращается в набор знаков. Файл открывают двойным
 * щелчком, а не через «импорт данных», и открыться он должен читаемо.
 */
export const EXPORT_FORMAT = {
  JSON: 'json',
  XLSX: 'xlsx',
  CSV: 'csv',
} as const;

export type ExportFormat = (typeof EXPORT_FORMAT)[keyof typeof EXPORT_FORMAT];

/** Готовая выгрузка: содержимое и заголовки ответа. */
export interface ExportResult {
  body: Buffer | string;
  contentType: string;
  /** Имя файла для `Content-Disposition`. */
  filename: string;
}

/** Разделитель CSV для русской локали Excel. */
const CSV_DELIMITER = ';';

/**
 * Маркер UTF-8.
 *
 * Без него Excel открывает CSV в кодировке системы и показывает кириллицу
 * нечитаемыми знаками. Это не косметика: файл, который нельзя прочитать,
 * заставляет получателя искать обходные пути вместо работы с данными.
 */
const UTF8_BOM = '\ufeff';

@Injectable()
export class ReportsExportService {
  constructor(private readonly reports: ReportsService) {}

  /**
   * Построить выгрузку отчёта.
   *
   * Отчёт считается тем же сервисом, что и для экрана, — вместе с областью
   * видимости роли. Здесь только представление.
   */
  async export(
    name: string,
    format: ExportFormat,
    query: ReportQuery,
    actor: AuthenticatedUser,
  ): Promise<ExportResult> {
    const report = await this.reports.build(name, query, actor);
    const stamp = report.meta.to.replace(/-/g, '');

    switch (format) {
      case EXPORT_FORMAT.CSV:
        return {
          body: toCsv(report),
          contentType: 'text/csv; charset=utf-8',
          filename: `${name}-${stamp}.csv`,
        };
      case EXPORT_FORMAT.XLSX:
        return {
          body: await toXlsx(report, name),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: `${name}-${stamp}.xlsx`,
        };
      default:
        /*
         * Неизвестный формат — ошибка, а не молчаливый JSON. Клиент, попросивший
         * `format=pdf`, должен узнать, что формат не поддерживается, а не
         * получить JSON с расширением `.pdf`.
         */
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `Формат выгрузки «${format}» не поддерживается`,
          details: { supported: Object.values(EXPORT_FORMAT) },
        });
    }
  }
}

/**
 * Значение ячейки для выгрузки.
 *
 * ДЕНЬГИ ДЕЛЯТСЯ НА 100: в базе они в копейках, а в таблице человек ждёт рубли.
 * Выгрузить копейки значило бы завысить суммы в сто раз — и ошибку заметили бы
 * не сразу, а после сверки.
 *
 * `null` превращается в пустую строку, а не в ноль: «нет данных» и «ноль» в
 * таблице должны выглядеть по-разному, иначе пустой период сойдёт за нулевую
 * выручку.
 */
export function cellValue(column: ReportColumn, value: ReportCell | undefined): string | number {
  /*
   * Тип сужен до значений отчёта (`string | number | null`), а не `unknown`:
   * `String(unknown)` на объекте дал бы `[object Object]` — в таблице появилось бы
   * это вместо данных, и заметить это можно было бы только глазами в Excel.
   */
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return column.type === REPORT_COLUMN_TYPE.MONEY ? value / 100 : value;
  }
  return value;
}

/**
 * Заголовок колонки с единицей измерения.
 *
 * Единица дописывается в заголовок, потому что сама ячейка — число без
 * форматирования: получатель должен видеть, что 62.4 — это часы, а 0.87 — доля.
 * Без этого «0,87» прочитали бы как 87 копеек или 87 процентов.
 */
export function columnTitle(column: ReportColumn): string {
  switch (column.type) {
    case REPORT_COLUMN_TYPE.MONEY:
      return `${column.title}, ₽`;
    case REPORT_COLUMN_TYPE.PERCENT:
      return `${column.title}, доля`;
    default:
      return column.title;
  }
}

/** Собрать таблицу «заголовки + строки + итоги» — общую для CSV и XLSX. */
export function toTable(report: ReportResult): {
  header: string[];
  rows: (string | number)[][];
  totals: (string | number)[][];
} {
  const header = report.columns.map(columnTitle);
  const rows = report.rows.map((row: ReportRow) =>
    report.columns.map((column) => cellValue(column, row[column.key])),
  );

  /*
   * Итоги выводятся ПОД таблицей, а не отдельным листом: их читают вместе с
   * данными, и переключение листа ради одной строки только мешало бы. Значения
   * идут парами «показатель — значение», потому что набор итогов у отчётов
   * разный, и подгонять его под колонки значило бы выдумывать соответствия.
   */
  const totals: (string | number)[][] = Object.entries(report.totals).map(([key, value]) => [
    totalLabel(key),
    typeof value === 'number' ? value : (value ?? ''),
  ]);

  return { header, rows, totals };
}

/**
 * Экранировать значение для CSV.
 *
 * Кавычки, точка с запятой и переводы строк ломают структуру файла: без
 * экранирования название магазина с `;` разъехалось бы на две колонки, и вся
 * строка ниже сместилась бы. Значение в кавычках, а кавычки внутри удваиваются —
 * так требует RFC 4180.
 */
export function csvEscape(value: string | number): string {
  const text = String(value);
  if (text.includes(CSV_DELIMITER) || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Собрать CSV-выгрузку. */
export function toCsv(report: ReportResult): string {
  const { header, rows, totals } = toTable(report);
  const lines: string[] = [];

  // Шапка отчёта: без периода файл, найденный через месяц, ничего не говорит.
  lines.push(csvEscape(`Отчёт: ${report.meta.from} — ${report.meta.to}`));
  lines.push('');
  lines.push(header.map(csvEscape).join(CSV_DELIMITER));
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(CSV_DELIMITER));
  }
  if (totals.length > 0) {
    lines.push('');
    for (const total of totals) {
      lines.push(total.map(csvEscape).join(CSV_DELIMITER));
    }
  }

  /*
   * Перевод строки — CRLF: этого требует RFC 4180, и Excel под Windows иначе
   * показывает весь файл одной строкой.
   */
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

/** Собрать XLSX-выгрузку. */
export async function toXlsx(report: ReportResult, name: string): Promise<Buffer> {
  /*
   * Библиотека подключается динамически: она нужна только на выгрузке, а API
   * обслуживает и обычные запросы. Статический импорт грузил бы её при каждом
   * старте сервиса, включая воркер.
   */
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  workbook.creator = 'Система управления ремонтом';
  workbook.created = new Date(report.meta.generatedAt);

  const sheet = workbook.addWorksheet(name.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const { header, rows, totals } = toTable(report);

  /*
   * Заголовок берётся из первой колонки, а не из `header`: у отчётов о выручке и
   * предоплатах первая колонка называется «Магазин» или «День», и общее имя
   * «Показатель» скрыло бы разрез.
   */
  sheet.addRow(header);
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) sheet.addRow(row);

  if (totals.length > 0) {
    sheet.addRow([]);
    const startRow = sheet.rowCount + 1;
    for (const total of totals) sheet.addRow(total);
    // Итоги выделяются, чтобы их не приняли за строку данных.
    for (let index = startRow; index <= sheet.rowCount; index += 1) {
      sheet.getRow(index).font = { bold: true };
    }
  }

  /*
   * Формат денежных колонок — числовой с двумя знаками. Значение при этом
   * остаётся числом, поэтому по столбцу можно считать сумму; формат задаёт
   * только отображение.
   */
  report.columns.forEach((column, index) => {
    if (column.type !== REPORT_COLUMN_TYPE.MONEY) return;
    sheet.getColumn(index + 1).numFmt = '#,##0.00';
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Русское название показателя итогов. */
const TOTAL_LABELS: Record<string, string> = {
  transitions: 'Всего переходов',
  avgHours: 'Среднее, ч',
  medianHours: 'Медиана, ч',
  p90Hours: '90-й перцентиль, ч',
  performers: 'Исполнителей',
  performersBusy: 'Исполнителей с работой',
  queue: 'В очереди на отправку',
  plannedHours: 'Плановые часы',
  factHours: 'Фактические часы',
  overdueNow: 'Просрочено сейчас',
  avgDelayHours: 'Средняя просрочка, ч',
  maxDelayHours: 'Максимальная просрочка, ч',
  overdueInPeriod: 'Просрочено за период',
  ordersInPeriod: 'Заказов за период',
  overdueShare: 'Доля просроченных, доля',
  revenueMinor: 'Выручка, ₽',
  refundsMinor: 'Возвраты, ₽',
  netRevenueMinor: 'Чистая выручка, ₽',
  ordersCount: 'Заказов',
  paymentsCount: 'Платежей',
  avgCheckMinor: 'Средний чек, ₽',
  methodCashMinor: 'Оплата наличными, ₽',
  methodCardMinor: 'Оплата картой, ₽',
  methodBankTransferMinor: 'Оплата переводом, ₽',
  methodOnlineMinor: 'Оплата онлайн, ₽',
  prepaidMinor: 'Внесено предоплат, ₽',
  avgPrepaymentMinor: 'Средняя предоплата, ₽',
  creditedMinor: 'Зачтено, ₽',
  inWorkMinor: 'В работе, ₽',
  refundedMinor: 'Возвращено, ₽',
  stuckCount: 'Зависших предоплат',
  stuckMinor: 'Зависло, ₽',
  stuckOrders: 'Заказы с зависшей предоплатой',
};

function totalLabel(key: string): string {
  // Незнакомый ключ показывается как есть: лучше техническое имя, чем потерянный
  // показатель — новый отчёт не должен требовать правки словаря, чтобы выгрузиться.
  return TOTAL_LABELS[key] ?? key;
}

export { totalLabel };
