import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSION, type ReportResult } from '@app/shared';

import { ReportsService, parseReportPeriod, type ReportQuery } from './reports.service';
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
  constructor(private readonly reportsService: ReportsService) {}

  @Get(':name')
  @RequirePermission(PERMISSION.REPORT_OPERATIONAL)
  @ApiOperation({ summary: 'Отчёт по имени' })
  build(
    @Param('name') name: string,
    @Query() rawQuery: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReportResult> {
    return this.reportsService.build(name, parseReportQuery(rawQuery), user);
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
