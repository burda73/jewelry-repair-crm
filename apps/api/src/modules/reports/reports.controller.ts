import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ANY_REPORT_PERMISSIONS,
  PERMISSION,
  ROLE,
  permissionForReport,
  type Permission,
  type ReportResult,
} from '@app/shared';

import { ReportsService, parseReportPeriod, type ReportQuery } from './reports.service';
import { EXPORT_FORMAT, ReportsExportService, type ExportFormat } from './reports-export.service';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Отчёты (задача 5.1, ТЗ п. 2.11, docs/07 §10).
 *
 * Один маршрут на все отчёты: `/reports/{name}`. Имя выбирает отчёт, а общие
 * параметры (период, магазины, разрез) одинаковы. Отдельный маршрут на каждый
 * отчёт означал бы, что общие проверки — период, права, область видимости —
 * повторяются пять раз, и в одном из пяти их однажды не окажется.
 *
 * Права: чтение отчётов — `report:operational`, выручка и предоплаты —
 * дополнительно `report:revenue`. Выгрузка — `report:export` (задача 5.6).
 *
 * Область видимости вычисляется в сервисе по роли: приёмщик видит свой магазин,
 * руководитель — всю сеть. Параметр `storeId` из строки запроса её только
 * СУЖАЕТ и не может расширить.
 */
@ApiTags('reports')
@ApiCookieAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly exportService: ReportsExportService,
  ) {}

  @Get(':name')
  /*
   * Маршрут принимает ЛЮБОЕ из прав на отчёты, а нужное для конкретного отчёта
   * проверяется ниже. Только `report:operational` здесь означало бы, что кассир с
   * правом `report:revenue` не может открыть выручку: право есть, доступа нет.
   * Дефект найден при сверке матрицы прав с docs/07 §12.
   */
  @RequirePermission(...(ANY_REPORT_PERMISSIONS as Permission[]))
  @ApiOperation({ summary: 'Отчёт по имени' })
  async build(
    @Param('name') name: string,
    @Query() rawQuery: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReportResult | undefined> {
    const query = parseReportQuery(rawQuery);
    const format = parseFormat(rawQuery.format);

    // Право на КОНКРЕТНЫЙ отчёт: операционные и денежные разведены.
    assertCanViewReport(name, user);

    if (format === EXPORT_FORMAT.JSON) {
      return this.reportsService.build(name, query, user);
    }

    /*
     * Выгрузка требует отдельного права (`report:export`), а чтение отчёта —
     * `report:operational`: видеть отчёт на экране и уносить данные файлом —
     * разные полномочия. Проверка делается здесь, а не декоратором, потому что
     * право зависит от ПАРАМЕТРА запроса, а декоратор видит только маршрут.
     * Отказ — тот же код `FORBIDDEN_ROLE`, что и у декоратора: иначе интерфейс
     * получил бы два разных сигнала об одном и том же.
     */
    assertCanExport(user);

    const result = await this.exportService.export(name, format, query, user);
    response.setHeader('Content-Type', result.contentType);
    /*
     * Имя файла отдаётся и в ASCII-варианте: старые браузеры и часть почтовых
     * клиентов не понимают `filename*` и сохранили бы файл под именем из
     * латиницы — вместо этого отдаётся осмысленное `report-20260930.xlsx`.
     */
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
    );
    response.send(result.body);
    return undefined;
  }
}

/**
 * Разобрать формат выгрузки.
 *
 * Отсутствие параметра — JSON: обычный запрос отчёта формата не указывает, и
 * значение по умолчанию не должно менять поведение маршрута.
 */
export function parseFormat(raw: unknown): ExportFormat {
  /*
   * Принимается только строка. Приведение через `String(raw)` на объекте дало бы
   * `[object Object]` в тексте ошибки, а на массиве — `json,xlsx`; параметр
   * приходит из строки запроса, и всё, что не строка, — это `undefined` или
   * повторённый параметр.
   */
  if (raw === undefined || raw === null || raw === '') return EXPORT_FORMAT.JSON;
  const value = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (value === EXPORT_FORMAT.JSON || value === EXPORT_FORMAT.XLSX || value === EXPORT_FORMAT.CSV) {
    return value;
  }
  /*
   * Неизвестный формат — ошибка, а не молчаливый JSON: клиент, попросивший
   * `format=pdf`, должен узнать, что формат не поддерживается, а не получить
   * JSON, сохранённый под именем `.pdf`.
   */
  throw new BadRequestException({
    code: 'VALIDATION_ERROR',
    // В сообщении — уже приведённая строка, а не исходное значение: подстановка
    // `unknown` в шаблон дала бы «[object Object]» в тексте ошибки.
    message: `Формат выгрузки «${value}» не поддерживается`,
    details: { supported: Object.values(EXPORT_FORMAT) },
  });
}

/**
 * Проверить право на конкретный отчёт.
 *
 * Право зависит от имени отчёта, а декоратор видит только маршрут, поэтому
 * проверка делается здесь. Код ошибки тот же, что у декоратора ролей: интерфейс
 * не должен разбирать два разных сигнала об одном и том же отказе.
 */
export function assertCanViewReport(name: string, actor: AuthenticatedUser): void {
  const required = permissionForReport(name);
  if (actor.roles.includes(ROLE.ADMIN)) return;
  if (!actor.permissions.includes(required)) {
    throw new ForbiddenException({
      code: 'FORBIDDEN_ROLE',
      message: 'Недостаточно прав для этого отчёта',
      details: { report: name, required },
    });
  }
}

/**
 * Проверить право на выгрузку.
 *
 * Отдельная функция, а не декоратор: право зависит от параметра запроса, а
 * декоратор видит только маршрут. Код ошибки тот же, что у декоратора ролей,
 * чтобы интерфейс не разбирал два разных сигнала об одном и том же отказе.
 */
export function assertCanExport(actor: AuthenticatedUser): void {
  if (!actor.permissions.includes(PERMISSION.REPORT_EXPORT)) {
    throw new ForbiddenException({
      code: 'FORBIDDEN_ROLE',
      message: 'Недостаточно прав для выгрузки отчёта',
      details: { required: PERMISSION.REPORT_EXPORT },
    });
  }
}

/**
 * Разобрать параметры строки запроса.
 *
 * ЗАЧЕМ ЯВНЫЙ РАЗБОР. `?storeId=a` и `?storeId[]=a` — это один и тот же
 * параметр, и Express отдаёт в первом случае строку, а во втором массив.
 * Принять только массив значило бы, что ссылка, скопированная из адресной
 * строки браузера, перестаёт работать.
 *
 * Значения, не прошедшие проверку формата, отбрасываются молча: пустой список
 * означает «все доступные магазины», а не «все магазины сети» — область
 * видимости всё равно накладывается в сервисе. Ошибку здесь показывать не за
 * что: параметр необязательный.
 */
export function parseReportQuery(raw: Record<string, unknown>): ReportQuery {
  const asArray = (value: unknown): string[] => {
    if (typeof value === 'string') return value.length === 0 ? [] : [value];
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === 'string');
    return [];
  };

  const period = parseReportPeriod({
    from: typeof raw.from === 'string' ? raw.from : undefined,
    to: typeof raw.to === 'string' ? raw.to : undefined,
  });

  const limitRaw = typeof raw.limit === 'string' ? Number(raw.limit) : Number.NaN;
  const groupBy = typeof raw.groupBy === 'string' ? raw.groupBy : null;

  return {
    from: period.from,
    to: period.to,
    storeIds: asArray(raw.storeId),
    workshopIds: asArray(raw.workshopId),
    groupBy: groupBy as ReportQuery['groupBy'],
    limit: Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : 500,
  };
}
