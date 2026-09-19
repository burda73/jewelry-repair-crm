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
import { ConfigService } from '@nestjs/config';
import { channelsFor } from '@app/shared';
import { envFlag } from '../../config/env.validation';
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
  /** Эскалация руководителю: просрочка больше рабочего дня (задача 2.8). */
  ESCALATION_MANAGER: 'ESCALATION_MANAGER',
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

  constructor(
    private readonly prisma: PrismaService,
    /*
     * Настройки нужны, чтобы решить, какие внешние каналы использовать
     * (задача 5.10). Решение принимается здесь, но НЕ здесь проверяется, доступен
     * ли шлюз: отправку выполняет воркер, и канал может быть выключен после
     * создания уведомления — тогда запись останется с понятной причиной отказа.
     */
    private readonly config: ConfigService,
  ) {}

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
   * Уведомить СОТРУДНИКА по обоим каналам: в интерфейсе и на почте (задача 5.9).
   *
   * ЗАЧЕМ ДВА УВЕДОМЛЕНИЯ, А НЕ ОДНО С ДВУМЯ АДРЕСАМИ. Записи разные по смыслу:
   * сообщение в интерфейсе человек прочитает, когда откроет систему (и оно
   * помечается прочитанным), а письмо должно уйти сразу, потому что сотрудник
   * может в систему сегодня не зайти. У них разные статусы, разные тексты (из
   * шаблонов разных каналов) и разные адресаты — идентификатор пользователя и
   * почтовый адрес.
   *
   * ЗАЧЕМ ЭТО ЗДЕСЬ, А НЕ В ВЫЗЫВАЮЩЕМ КОДЕ. Раньше каждая рассылка сама решала,
   * какие каналы использовать, и ни одна не использовала почту: в интерфейсе
   * уведомление появлялось, а письмо не уходило — то есть сотрудник, не открывший
   * систему, не узнавал о просрочке. Общий метод делает набор каналов единым
   * решением, а не повторяющимся в четырёх местах.
   *
   * Почта отправляется ТОЛЬКО если у сотрудника есть адрес: у приёмщика он есть
   * всегда (это учётная запись), но метод не должен падать, если адрес не задан.
   * Отсутствие адреса — не ошибка: сообщение в интерфейсе всё равно создаётся.
   */
  async notifyStaff(params: {
    code: TemplateCode | (string & {});
    userId: string;
    email: string | null;
    orderId?: string | null;
    values?: Record<string, string | number | null | undefined>;
    fallbackSubject?: string;
    fallbackBody?: string;
  }): Promise<{ inApp: NotificationDto | null; email: NotificationDto | null }> {
    const inApp = await this.notifyByTemplate({
      code: params.code,
      userId: params.userId,
      orderId: params.orderId ?? null,
      recipient: params.userId,
      channel: NOTIFICATION_CHANNEL.IN_APP,
      ...(params.values === undefined ? {} : { values: params.values }),
      ...(params.fallbackSubject === undefined ? {} : { fallbackSubject: params.fallbackSubject }),
      ...(params.fallbackBody === undefined ? {} : { fallbackBody: params.fallbackBody }),
    });

    /*
     * Почта создаётся ВТОРОЙ и не отменяет первую: если у сотрудника нет адреса,
     * уведомление в интерфейсе уже создано и терять его нельзя.
     */
    let email: NotificationDto | null = null;
    if (params.email !== null && params.email.trim() !== '') {
      email = await this.notifyByTemplate({
        code: params.code,
        userId: params.userId,
        orderId: params.orderId ?? null,
        recipient: params.email.trim(),
        channel: NOTIFICATION_CHANNEL.EMAIL,
        ...(params.values === undefined ? {} : { values: params.values }),
        ...(params.fallbackSubject === undefined
          ? {}
          : { fallbackSubject: params.fallbackSubject }),
        ...(params.fallbackBody === undefined ? {} : { fallbackBody: params.fallbackBody }),
      });
    }

    return { inApp, email };
  }

  /**
   * Уведомить КЛИЕНТА (задача 5.10).
   *
   * ОТЛИЧИЕ ОТ `notifyStaff` ПРИНЦИПИАЛЬНОЕ. У клиента нет учётной записи, поэтому
   * `IN_APP`-записи ему не создать: единственный способ что-то сообщить — внешний
   * канал. Если канал выключен, уведомление НЕ создаётся вовсе, и это осознанное
   * решение.
   *
   * ПОЧЕМУ НЕ СОЗДАВАТЬ ЗАПИСЬ ПРО ЗАПАС. Запись без получателя и без канала
   * навсегда осталась бы в статусе `FAILED` и копилась бы в списке «требует
   * вмешательства» — то есть превратилась бы в постоянный шум, на который
   * перестают смотреть. Отсутствие SMS-канала — это настройка, а не сбой
   * доставки, и место для неё — журнал воркера, а не очередь ошибок.
   *
   * ВАЖНО: уведомление СОЗДАЁТСЯ, а не отправляется. Отправка — дело воркера, в
   * отдельной транзакции. Иначе недоступный SMS-шлюз откатывал бы выдачу заказа.
   */
  async notifyCustomer(params: {
    code: TemplateCode | (string & {});
    customerId: string | null;
    orderId?: string | null;
    /** Телефон в любом формате: нормализация выполняется перед отправкой. */
    phone: string | null;
    values?: Record<string, string | number | null | undefined>;
  }): Promise<NotificationDto[]> {
    const phone = params.phone?.trim() ?? '';
    if (phone === '') return [];

    /*
     * Какие каналы реально будут использованы, решает домен
     * (`channelsFor`): там же учтено, включён ли канал настройкой. Здесь
     * остаётся только создать по уведомлению на каждый канал.
     */
    const channels = channelsFor(params.code, {
      smsEnabled: this.smsEnabled(),
      messengerEnabled: this.messengerEnabled(),
      hasPhone: true,
    });

    const created: NotificationDto[] = [];
    for (const channel of channels) {
      if (channel !== NOTIFICATION_CHANNEL.SMS && channel !== NOTIFICATION_CHANNEL.MESSENGER) {
        continue;
      }

      const notification = await this.notifyByTemplate({
        code: params.code,
        customerId: params.customerId,
        orderId: params.orderId ?? null,
        recipient: phone,
        channel,
        ...(params.values === undefined ? {} : { values: params.values }),
      });

      if (notification !== null) created.push(notification);
    }

    return created;
  }

  /**
   * Включён ли SMS-канал.
   *
   * Читается через `envFlag`, а не сравнением со строкой `'true'`: схема
   * окружения приводит флаг к булеву значению, и сравнение с булевым значением
   * строки НИКОГДА не даёт истины. Из-за этого SMS не отправлялись никогда, хотя
   * канал считался настроенным в состоянии интеграции.
   */
  private smsEnabled(): boolean {
    return envFlag(this.config.get('NOTIFICATIONS_SMS_ENABLED'));
  }

  /** Включён ли канал мессенджера. */
  private messengerEnabled(): boolean {
    return envFlag(this.config.get('NOTIFICATIONS_MESSENGER_ENABLED'));
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
