import { Body, Controller, Get, Put, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSION, type OrganizationRequisites } from '@app/shared';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { SettingsService } from './settings.service';

/**
 * Настройки системы (требование заказчика).
 *
 * Право `settings:manage` есть только у администратора: здесь лежат реквизиты
 * организации, от имени которой печатаются квитанции и акты. Их правка меняет
 * то, что покупатель видит на бумаге, поэтому доступ не выдаётся ни приёмщику,
 * ни руководителю.
 *
 * Пути объявлены полностью в каждом методе (`@Controller()` без префикса) — как
 * в остальных модулях проекта: иначе глобальный префикс `api/v1` склеивался бы
 * с путём контроллера незаметно для читателя.
 */
@ApiTags('settings')
@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Прочитать реквизиты организации.
   *
   * Доступно с правом управления: читать их незачем никому другому, а печать
   * документов берёт название на сервере, не запрашивая его у клиента.
   */
  @Get('settings/organization')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Реквизиты организации для документов' })
  getOrganization(): Promise<OrganizationRequisites> {
    return this.settings.getOrganizationRequisites();
  }

  /** Сохранить реквизиты организации. */
  @Put('settings/organization')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Сохранить реквизиты организации' })
  saveOrganization(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationRequisites> {
    return this.settings.saveOrganizationRequisites(body, user);
  }
}
