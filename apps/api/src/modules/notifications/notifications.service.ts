/**
 * Уведомления (задача 2.6, ТЗ п. 2.6 и 2.7; контракт — docs/05 §6).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Логист узнаёт о задержке рейса, только если сам откроет
 * список партий и посмотрит на время. Ответственный за просроченный заказ не
 * узнаёт ни о чём, пока клиент не позвонит. Уведомление переносит это на
 * систему: она замечает событие и говорит о нём человеку.
 *
 * ПОЧЕМУ УВЕДОМЛЕНИЕ СНАЧАЛА СОЗДАЁТСЯ, А ПОТОМ ОТПРАВЛЯЕТСЯ. Запись в базе
 * (`PENDING`) — это и есть очередь отправки. Если внешний провайдер недоступен,
 * уведомление не теряется: оно остаётся в базе с ошибкой и числом попыток, и
 * его можно повторить. Отправка «напрямую, без записи» означала бы, что при
 * сбое почты событие исчезает бесследно.
 *
 * ПОЧЕМУ ШАБЛОНЫ В БАЗЕ, А НЕ В КОДЕ. Текст уведомления меняет менеджер, а не
 * разработчик: «Ваш заказ готов» и «Изделие можно забрать в магазине на
 * Тверской» — это разные сообщения, и выбор между ними не техническое решение.
 * Если текст зашит в код, каждая правка требует выпуска новой версии.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/** Канал доставки уведомления. Значения совпадают с enum схемы. */
export const NOTIFICATION_CHANNEL = {
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
  SMS: 'SMS',
  MESSENGER: 'MESSENGER',
  PUSH: 'PUSH',
} as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNEL)[keyof typeof NOTIFICATION_CHANNEL];

/** Состояние уведомления. */
export const NOTIFICATION_STATUS = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  READ: 'READ',
} as const;

/** Уведомление так, как его видит интерфейс. */
export interface NotificationDto {
  id: string;
  templateCode: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  orderId: string | null;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Коды шаблонов, которые использует система. */
export const TEMPLATE_CODE = {
  /** Партия задерживается: доставка не подтверждена в срок. */
  BATCH_TRANSIT_LATE: 'BATCH_TRANSIT_LATE',
  /** Партия принята получателем. */
  BATCH_RECEIVED: 'BATCH_RECEIVED',
  /** Заказ просрочен по нормативу этапа. */
  ORDER_OVERDUE: 'ORDER_OVERDUE',
  /** Заказ готов к выдаче. */
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  /** Заказ невостребован 30 дней. */
  ORDER_UNCLAIMED: 'ORDER_UNCLAIMED',
} as const;

export type TemplateCode = (typeof TEMPLATE_CODE)[keyof typeof TEMPLATE_CODE];

/**
 * Подставить значения в шаблон.
 *
 * Плейсхолдеры вида `{{batchNo}}`. Отсутствующая переменная заменяется пустой
 * строкой, а не остаётся как `{{batchNo}}`: иначе получатель увидит в письме
 * техническую разметку, а «пусто» он воспримет как отсутствие данных.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Создать уведомление по шаблону.
   *
   * Возвращает `null`, если шаблон не найден или отключён: отсутствие шаблона —
   * это не ошибка бизнес-операции. Партия обязана отправиться даже тогда, когда
   * текст уведомления ещё не заполнен; иначе незаполненный справочник
   * блокировал бы перевозку.
   */
  async notifyByTemplate(params: {
    code: TemplateCode | (string & {});
    userId?: string | null;
    customerId?: string | null;
    orderId?: string | null;
    recipient: string;
    channel?: NotificationChannel;
    values?: Record<string, string | number | null | undefined>;
    /** Своя тема и текст вместо шаблона (для системных сообщений). */
    fallbackSubject?: string;
    fallbackBody?: string;
  }): Promise<NotificationDto | null> {
    const channel = params.channel ?? NOTIFICATION_CHANNEL.IN_APP;

    const template = await this.prisma.notificationTemplate.findFirst({
      where: { code: params.code, channel, isActive: true },
    });

    /*
     * Если шаблона нет, берётся запасной текст. Он не выдумывает данные: в нём
     * только то, что система знает точно (номер и факт события). Без него
     * уведомление просто не создалось бы, и о задержке никто не узнал бы.
     */
    const subject = template?.subject
      ? renderTemplate(template.subject, params.values ?? {})
      : (params.fallbackSubject ?? null);
    const body = template
      ? renderTemplate(template.body, params.values ?? {})
      : (params.fallbackBody ?? `Событие: ${params.code}`);

    const created = await this.prisma.notification.create({
      data: {
        userId: params.userId ?? null,
        customerId: params.customerId ?? null,
        orderId: params.orderId ?? null,
        templateCode: params.code,
        channel,
        recipient: params.recipient,
        subject,
        body,
        status: NOTIFICATION_STATUS.PENDING,
      },
    });

    return this.toDto(created);
  }

  /**
   * Уведомления текущего пользователя.
   *
   * Только свои: чужую ленту видеть нельзя, даже с правами на заказы — это
   * личные сообщения сотруднику, а не рабочий документ.
   */
  async listMine(
    user: AuthenticatedUser,
    params: { unreadOnly?: boolean; limit?: number } = {},
  ): Promise<NotificationDto[]> {
    const rows = await this.prisma.notification.findMany({
      where: {
        userId: user.id,
        channel: NOTIFICATION_CHANNEL.IN_APP,
        ...(params.unreadOnly === true
          ? { status: { in: [NOTIFICATION_STATUS.PENDING, NOTIFICATION_STATUS.SENT] } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 50,
    });

    return rows.map((row) => this.toDto(row));
  }

  /** Число непрочитанных — для колокольчика в интерфейсе. */
  async unreadCount(user: AuthenticatedUser): Promise<number> {
    return this.prisma.notification.count({
      where: {
        userId: user.id,
        channel: NOTIFICATION_CHANNEL.IN_APP,
        status: { in: [NOTIFICATION_STATUS.PENDING, NOTIFICATION_STATUS.SENT] },
      },
    });
  }

  /**
   * Отметить уведомление прочитанным.
   *
   * Проверяется владелец: без этого чужое уведомление можно было бы «прочитать»
   * по угадываемому идентификатору. Не «не найдено», а именно 404 — чтобы не
   * раскрывать существование чужих записей.
   */
  async markRead(id: string, user: AuthenticatedUser): Promise<NotificationDto> {
    const existing = await this.prisma.notification.findFirst({
      where: { id, userId: user.id },
    });
    if (existing === null) throw new NotFoundException('Уведомление не найдено');

    const updated = await this.prisma.notification.update({
      where: { id },
      data: { status: NOTIFICATION_STATUS.READ, readAt: new Date() },
    });

    return this.toDto(updated);
  }

  /** Отметить прочитанными все уведомления пользователя. */
  async markAllRead(user: AuthenticatedUser): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId: user.id,
        status: { in: [NOTIFICATION_STATUS.PENDING, NOTIFICATION_STATUS.SENT] },
      },
      data: { status: NOTIFICATION_STATUS.READ, readAt: new Date() },
    });

    return result.count;
  }

  /**
   * Отметить отправленным.
   *
   * Вызывается воркером отправки (этап 5, задача 5.9). До его появления
   * уведомления `IN_APP` видны в интерфейсе и без этой отметки: канал «в
   * приложении» не требует внешней доставки, а `PENDING` для него означает
   * «не прочитано».
   */
  async markSent(id: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { status: NOTIFICATION_STATUS.SENT, sentAt: new Date(), attempts: { increment: 1 } },
    });
  }

  /** Отметить ошибку отправки: уведомление остаётся для повторной попытки. */
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: NOTIFICATION_STATUS.FAILED,
        error: error.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
    this.logger.warn(`Уведомление ${id} не отправлено: ${error}`);
  }

  private toDto(row: {
    id: string;
    templateCode: string;
    channel: string;
    subject: string | null;
    body: string;
    status: string;
    orderId: string | null;
    sentAt: Date | null;
    readAt: Date | null;
    createdAt: Date;
  }): NotificationDto {
    return {
      id: row.id,
      templateCode: row.templateCode,
      channel: row.channel,
      subject: row.subject,
      body: row.body,
      status: row.status,
      orderId: row.orderId,
      sentAt: row.sentAt?.toISOString() ?? null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
