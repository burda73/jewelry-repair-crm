import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';

import { EscalationsService } from './escalations.service';
import type { EscalationRunResult } from './escalations.service';
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
  constructor(private readonly escalations: EscalationsService) {}

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
