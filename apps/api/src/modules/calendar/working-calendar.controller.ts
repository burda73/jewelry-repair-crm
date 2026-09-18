import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';
import { WorkingCalendarService } from './working-calendar.service';
import type { CalendarDayDto, CalendarMonthSummaryDto } from './working-calendar.service';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Рабочий календарь (задача 1.3.3, ТЗ п. 2.7 и 2.9).
 *
 * Право — `SETTINGS_MANAGE` (только ADMIN): календарь определяет сроки всех
 * заказов, поэтому его изменение влияет на обещания клиентам, а не только на
 * работу одного подразделения.
 *
 * Здесь ЕСТЬ `DELETE`, и это осознанное исключение из правила «не удалять,
 * только отключать» (задача 1.3.1). На строку календаря не ссылается ни одна
 * таблица: внешних ключей на `working_calendar` нет, «отключить дату» смысла не
 * имеет, а накопление строк, повторяющих обычное правило, и было причиной
 * дефекта — такие строки перекрывали встроенные праздники. Прежнее значение
 * сохраняется в журнале, поэтому снятие обратимо.
 */
@ApiTags('working-calendar')
@ApiCookieAuth()
@Controller()
export class WorkingCalendarController {
  constructor(private readonly calendarService: WorkingCalendarService) {}

  @Get('working-calendar')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Календарь за период: записи-исключения и праздники' })
  list(@Query() query: unknown): Promise<{ days: CalendarDayDto[]; holidays: string[] }> {
    return this.calendarService.list(query);
  }

  @Get('working-calendar/summary')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Сводка по месяцам: рабочих дней и праздников' })
  summary(@Query() query: unknown): Promise<CalendarMonthSummaryDto[]> {
    return this.calendarService.summary(query);
  }

  @Post('working-calendar')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Отметить день: праздник, перенос или особые часы' })
  createDay(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CalendarDayDto> {
    return this.calendarService.createDay(body, user);
  }

  @Patch('working-calendar/:id')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Изменить запись календаря' })
  updateDay(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CalendarDayDto> {
    return this.calendarService.updateDay(id, body, user);
  }

  @Delete('working-calendar/:id')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Снять отметку — день возвращается к обычному правилу' })
  deleteDay(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ removed: true }> {
    return this.calendarService.deleteDay(id, user);
  }
}
