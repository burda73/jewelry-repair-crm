import { Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { NotificationsService } from './notifications.service';
import type { NotificationDto } from './notifications.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { PERMISSION } from '@app/shared';
import { NotificationSenderService } from '../../integrations/notifications/notification-sender.service';

/**
 * Уведомления сотрудника (задача 2.6, docs/07 §14).
 *
 * Права отдельным правом не закрываются намеренно: уведомления адресованы
 * лично сотруднику, а не роли. Их выдаёт система по событиям его работы, и
 * «нет права `notification:read`» лишило бы человека собственной ленты. Доступ
 * ограничен владельцем записи: чужие уведомления не видны и не читаются —
 * это проверяется в сервисе по `userId`, а не по роли.
 *
 * Внешняя отправка (EMAIL, SMS, MESSENGER) появится на этапе 5 (задача 5.9) и
 * работа через провайдера описана в docs/05 §3. Здесь — канал `IN_APP` и то,
 * что от него требуется интерфейсу: лента, счётчик и отметка о прочтении.
 */
@ApiTags('notifications')
@ApiCookieAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly sender: NotificationSenderService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Мои уведомления' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') limit?: string,
  ): Promise<NotificationDto[]> {
    // `unreadOnly` сравнивается с `'true'` явно: непустая строка `'false'`
    // истинна в JS, и фильтр включился бы вопреки запросу.
    const parsedLimit = limit !== undefined ? Number.parseInt(limit, 10) : undefined;
    return this.notifications.listMine(user, {
      unreadOnly: unreadOnly === 'true',
      ...(parsedLimit !== undefined && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Число непрочитанных уведомлений' })
  async unreadCount(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    return { count: await this.notifications.unreadCount(user) };
  }

  /**
   * Состояние внешних каналов (задача 5.10).
   *
   * ЗАЧЕМ ЭТОТ МАРШРУТ. Вопрос «почему клиент не получил SMS» имеет ответ
   * «канал выключен настройкой», и он должен быть виден администратору, а не
   * только в журнале сервера. Показать лишь факт `configured: false` значило бы
   * заставить искать причину в коде.
   *
   * Показываются ВСЕ каналы, включая выключенные: отсутствие канала в списке
   * выглядело бы как «канала не существует», а не как «канал выключен».
   *
   * Право `settings:manage`, а не «свои уведомления»: это состояние ИНТЕГРАЦИИ, а
   * не личная лента. Обычному сотруднику незачем знать, подключён ли SMS-шлюз.
   */
  @Get('channels')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Состояние каналов доставки уведомлений' })
  channels(): { channel: string; configured: boolean; reason: string }[] {
    return this.sender.channelsState();
  }

  /**
   * Уведомления, требующие вмешательства (задача 5.10).
   *
   * Без этого списка «письмо не ушло» обнаруживается только тогда, когда клиент
   * позвонит и спросит, почему его не предупредили.
   */
  @Get('exhausted')
  @RequirePermission(PERMISSION.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Уведомления с исчерпанными попытками отправки' })
  exhausted(@Query('limit') limit?: string): Promise<
    {
      id: string;
      templateCode: string;
      channel: string;
      recipient: string;
      attempts: number;
      error: string | null;
      createdAt: string;
    }[]
  > {
    const parsedLimit = limit !== undefined ? Number.parseInt(limit, 10) : undefined;
    return this.sender.listExhausted(
      parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : 100,
    );
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Отметить уведомление прочитанным' })
  async markRead(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NotificationDto> {
    return this.notifications.markRead(id, user);
  }

  @Post('read-all')
  // `POST` по умолчанию отвечает 201 «создано», но здесь ничего не создаётся:
  // отметка о прочтении — изменение состояния, и корректный ответ 200.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отметить прочитанными все уведомления' })
  async markAllRead(@CurrentUser() user: AuthenticatedUser): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(user) };
  }
}
