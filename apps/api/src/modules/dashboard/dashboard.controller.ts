import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSION, type Permission } from '@app/shared';

import { DashboardService, type DashboardSummary } from './dashboard.service';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Главный экран (задача 5.8, docs/07 §12, `GET /dashboard/summary`).
 *
 * Право объявлено «любое из», а конкретный набор блоков определяется правами
 * сотрудника внутри сервиса. Если бы маршрут требовал `order:read`, бухгалтер с
 * правом на выручку, но без доступа к заказам, не смог бы открыть главный экран
 * вообще. Дефект ровно такого рода уже был найден на отчётах (задача 5.6):
 * кассир с `report:revenue` не мог открыть выручку, потому что маршрут требовал
 * только `report:operational`.
 */
@ApiTags('dashboard')
@ApiCookieAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePermission(
    PERMISSION.ORDER_READ,
    PERMISSION.REPORT_OPERATIONAL,
    PERMISSION.REPORT_REVENUE,
    PERMISSION.CLAIM_READ,
  )
  @ApiOperation({ summary: 'Сводка для главного экрана (состав зависит от прав)' })
  summary(@CurrentUser() user: AuthenticatedUser): Promise<DashboardSummary> {
    return this.dashboard.build(user);
  }
}

/** Права маршрута — экспортируются для проверки в тестах. */
export const DASHBOARD_ROUTE_PERMISSIONS: readonly Permission[] = [
  PERMISSION.ORDER_READ,
  PERMISSION.REPORT_OPERATIONAL,
  PERMISSION.REPORT_REVENUE,
  PERMISSION.CLAIM_READ,
];
