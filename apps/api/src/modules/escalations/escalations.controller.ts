import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';

import { EscalationsService } from './escalations.service';
import type { EscalationRunResult } from './escalations.service';
import { UnclaimedService } from './unclaimed.service';
import type { UnclaimedRunResult } from './unclaimed.service';
import { OverdueDashboardService } from './overdue-dashboard.service';
import type { OverdueDashboardDto } from './overdue-dashboard.service';
import { RequirePermission } from '../../common/auth/roles.decorator';

/**
 * Ручной запуск прогона эскалаций (задача 2.8).
 *
 * ЗАЧЕМ РУЧНОЙ ЗАПУСК, ЕСЛИ ЕСТЬ ВОРКЕР. Плановый прогон раз в 15 минут не
 * позволяет проверить, что эскалация настроена верно: ждать четверти часа после
 * каждой правки нормативов невозможно. Ручной запуск даёт администратору
 * немедленный результат, а сопровождению — способ повторить прогон после сбоя,
 * не дожидаясь расписания.
 *
 * Право `settings:manage`: эскалация рассылает уведомления сотрудникам, и
 * запускать её «просто посмотреть» не должен любой желающий.
 */
@ApiTags('escalations')
@ApiCookieAuth()
@Controller('escalations')
export class EscalationsController {
  constructor(
    private readonly escalations: EscalationsService,
    private readonly unclaimed: UnclaimedService,
    private readonly dashboard: OverdueDashboardService,
  ) {}

  @Get('overdue')
  @RequirePermission(PERMISSION.REPORT_OPERATIONAL)
  @ApiOperation({ summary: 'Дашборд просроченных заказов' })
  overdue(): Promise<OverdueDashboardDto> {
    return this.dashboard.build();
  }

  @Post('unclaimed/run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Перевести просроченные выдачи в «невостребовано»' })
  runUnclaimed(): Promise<UnclaimedRunResult> {
    return this.unclaimed.run();
  }

  @Post('run')
  // `POST` по умолчанию отвечает `201 Создано`, но прогон ничего не создаёт как
  // ресурс: это выполнение операции, и корректный ответ `200`.
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Запустить прогон эскалаций вручную' })
  run(): Promise<EscalationRunResult> {
    return this.escalations.run();
  }
}
