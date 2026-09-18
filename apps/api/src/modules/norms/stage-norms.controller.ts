import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';
import { StageNormsService } from './stage-norms.service';
import type { NormVersionDto } from './stage-norms.service';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Нормативы этапов (задача 1.3.4, ТЗ п. 2.7).
 *
 * Право — `settings:manage` (только ADMIN). По матрице ролей (docs/02 §4)
 * нормативы не выделены в отдельную строку, а относятся к настройкам системы:
 * они задают сроки, которые система обещает клиенту, и по ним считается
 * просрочка исполнителей.
 *
 * `PATCH` и `DELETE` здесь нет намеренно. Норматив версионируется: правка — это
 * новая версия, а не изменение строки, потому что по прежней версии нужно
 * объяснить сроки уже принятых заказов. Удалить отдельный норматив тоже нельзя:
 * набор версии самодостаточен, и «дырка» в нём означала бы этап без срока.
 */
@ApiTags('stage-norms')
@ApiCookieAuth()
@Controller()
export class StageNormsController {
  constructor(private readonly normsService: StageNormsService) {}

  @Get('stage-norms')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Действующие нормативы этапов' })
  current(): Promise<NormVersionDto | null> {
    return this.normsService.current();
  }

  /**
   * История версий.
   *
   * Объявлен ДО маршрутов с параметром (как `search` у клиентов): иначе
   * «versions» было бы принято за идентификатор.
   */
  @Get('stage-norms/versions')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'История версий нормативов' })
  versions(): Promise<NormVersionDto[]> {
    return this.normsService.versions();
  }

  @Post('stage-norms/versions')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать новую версию нормативов и сделать её действующей' })
  createVersion(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NormVersionDto> {
    return this.normsService.createVersion(body, user);
  }
}
