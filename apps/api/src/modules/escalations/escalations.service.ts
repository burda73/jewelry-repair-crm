/**
 * Воркер эскалаций (задача 2.8, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Просроченный заказ сам о себе не сообщает: приёмщик узнаёт о
 * нём, когда клиент позвонит и спросит, где изделие. Дашборд показывает
 * просрочки, но смотреть в него надо самому, и в занятой смене этого не делает
 * никто. Воркер переворачивает это: система замечает срок и говорит о нём
 * ответственному, а если тот не отреагировал — его руководителю.
 *
 * ПОЧЕМУ ЭТО НЕ ОЧЕРЕДЬ С ВНЕШНИМ БРОКЕРОМ. Решение о применении Redis+BullMQ
 * относится к этапу 5, когда появятся внешние каналы. Работа здесь короткая:
 * один запрос по индексу `Order(status, dueAt)` плюс запись. Планировщик внутри
 * процесса решает задачу без ещё одной инфраструктурной зависимости, которую
 * надо поднимать, мониторить и резервировать.
 *
 * ПОЧЕМУ ПРОГОН ИДЕМПОТЕНТЕН. Воркер может быть запущен дважды (перезапуск
 * сервиса, ручной прогон, два экземпляра приложения). Повторная эскалация того
 * же уровня не должна порождать второе уведомление: иначе лента превратится в
 * шум, и настоящее событие в ней потеряется.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import {
  ESCALATION_LEVEL,
  NORM_STAGE,
  ORDER_STATUS,
  assessEscalation,
  shouldEscalateAgain,
  stageForStatus,
  type EscalationLevel,
  type OrderStatus,
} from '@app/shared';
import { NotificationsService, TEMPLATE_CODE } from '../notifications/notifications.service';

/** Итог прогона — для журнала и ручного запуска. */
export interface EscalationRunResult {
  /** Сколько просроченных заказов просмотрено. */
  scanned: number;
  /** Сколько уведомлений создано. */
  notified: number;
  /** Сколько заказов повысили уровень. */
  escalated: number;
  /** Заказы, по которым не нашёлся ответственный. */
  withoutResponsible: number;
}

/**
 * Статусы, которые в эскалации не участвуют.
 *
 * Закрытые заказы просрочки не имеют, а `AWAITING_PREPAYMENT` ждёт клиента:
 * напоминать о нём ответственному бессмысленно — он ничего не может сделать,
 * пока клиент не заплатит. Такие заказы ведёт отдельный отчёт по предоплатам.
 */
const EXCLUDED_STATUSES: OrderStatus[] = [
  ORDER_STATUS.DRAFT,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.AWAITING_PREPAYMENT,
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.REFUSED,
  ORDER_STATUS.REFUSED_BEFORE_WORK,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.UNCLAIMED,
];

@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: OrderWorkflowService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Прогон эскалаций.
   *
   * @param now момент проверки; передаётся явно, чтобы прогон можно было
   *            воспроизвести и проверить
   */
  async run(now: Date = new Date()): Promise<EscalationRunResult> {
    /*
     * Выборка ограничена сроком И статусом. Индекс `Order(status, dueAt)`
     * покрывает оба условия, поэтому прогон не сканирует таблицу заказов
     * целиком — иначе на годовом объёме он стал бы самым тяжёлым запросом дня.
     */
    const orders = await this.prisma.order.findMany({
      where: {
        dueAt: { not: null, lt: now },
        status: { notIn: [...EXCLUDED_STATUSES] },
      },
      select: {
        id: true,
        orderNo: true,
        status: true,
        dueAt: true,
        escalatedAt: true,
        escalationLevel: true,
        createdById: true,
        productionManagerId: true,
        createdStoreId: true,
        // Имя ответственного нужно для текста письма руководителю
        // (`{{responsible}}`): без него шаблон подставил бы пустоту.
        /*
         * Почта берётся вместе с именем: уведомление сотруднику уходит по двум
         * каналам (задача 5.9), и адрес нужен для письма. Отдельный запрос за ним
         * был бы лишним обращением к базе на каждый просроченный заказ.
         */
        createdBy: { select: { fullName: true, email: true } },
        productionManager: { select: { fullName: true, email: true } },
      },
      /*
       * Ограничение прогона: если просроченных заказов аномально много (сбой
       * данных или сломанный календарь), воркер не должен рассылать тысячи
       * уведомлений за один проход.
       */
      take: 500,
    });

    const result: EscalationRunResult = {
      scanned: orders.length,
      notified: 0,
      escalated: 0,
      withoutResponsible: 0,
    };
    if (orders.length === 0) return result;

    const calendar = await this.workflow.loadCalendar();

    for (const order of orders) {
      const state = assessEscalation({
        dueAt: order.dueAt,
        now,
        calendar,
        escalatedAt: order.escalatedAt,
        currentLevel: order.escalationLevel,
      });

      /*
       * Уведомление отправляется только при ПОВЫШЕНИИ уровня. Ежедневное
       * повторение одного и того же сообщения превращает ленту в шум, и
       * настоящее событие в ней теряется.
       */
      if (!shouldEscalateAgain(state, order.escalationLevel)) continue;

      const recipients = await this.resolveRecipients(order, state.level as EscalationLevel);

      if (recipients.length === 0) {
        /*
         * Ответственного нет — уровень НЕ повышается. Иначе заказ «сгорел» бы
         * без единого уведомления: следующий прогон счёл бы уровень уже
         * достигнутым и молчал бы вечно. Лучше повторить попытку в следующий раз.
         *
         * По управлению этот выход ДУБЛИРУЕТ проверку `created === 0` ниже:
         * рассылка по пустому списку и так не создаст уведомлений. Он оставлен
         * ради отдельного счётчика `withoutResponsible` и отдельного сообщения в
         * журнале: «ответственного нет» — это проблема настройки ролей, а «сбой
         * рассылки» — проблема интеграции, и разбираются они по-разному.
         */
        result.withoutResponsible += 1;
        this.logger.warn(`Заказ ${order.orderNo}: не найден ответственный за этап`);
        continue;
      }

      const isManagerLevel = state.level >= ESCALATION_LEVEL.MANAGER;
      const created = await this.notify(
        recipients,
        order,
        state.overdueWorkingHours,
        isManagerLevel,
        // Руководителю сообщается, КТО отвечает за заказ: без имени письмо
        // требует вмешательства, не говоря, к кому идти.
        order.productionManager?.fullName ?? order.createdBy.fullName,
      );

      if (created === 0) {
        /*
         * Ни одно уведомление не создалось — уровень НЕ повышаем. Иначе заказ
         * считался бы оповещённым, хотя сообщения никто не получил, и следующая
         * попытка уже не состоялась бы.
         */
        this.logger.warn(`Заказ ${order.orderNo}: уведомления не созданы, уровень не повышен`);
        continue;
      }

      result.notified += created;
      await this.prisma.order.update({
        where: { id: order.id },
        data: { escalatedAt: now, escalationLevel: state.level },
      });
      result.escalated += 1;
    }

    return result;
  }

  /**
   * Создать уведомления получателям.
   *
   * Возвращает число СОЗДАННЫХ уведомлений. Сбой на одном получателе не
   * прерывает рассылку остальным: падение на первом оставило бы второго без
   * оповещения.
   */
  private async notify(
    recipients: Array<{ id: string; email: string }>,
    order: { id: string; orderNo: string; status: string },
    overdueWorkingHours: number,
    isManagerLevel: boolean,
    responsibleName: string,
  ): Promise<number> {
    let created = 0;
    for (const recipient of recipients) {
      try {
        /*
         * Оба канала: сообщение в интерфейсе и письмо (задача 5.9). Сотрудник
         * может не открыть систему сегодня, и тогда единственным способом узнать
         * о просрочке остаётся почта. Раньше почта не использовалась нигде:
         * уведомление появлялось в интерфейсе, а письмо не уходило.
         */
        const { inApp: notification } = await this.notifications.notifyStaff({
          // У руководителя СВОЙ шаблон: текст другой (нужно вмешательство, а не
          // напоминание) и переменная `responsible` вместо `stage`.
          code: isManagerLevel ? TEMPLATE_CODE.ESCALATION_MANAGER : TEMPLATE_CODE.ORDER_OVERDUE,
          userId: recipient.id,
          email: recipient.email,
          orderId: order.id,
          values: {
            orderNo: order.orderNo,
            // Просрочка показывается в рабочих днях (9 часов = день): «1,3 дня»
            // сотруднику ничего не говорит, а «1 день» — говорит.
            overdueDays: Math.floor(overdueWorkingHours / 9),
            stage: order.status,
            // Имя ОТВЕТСТВЕННОГО, а не номер заказа: шаблон спрашивает «кто
            // отвечает», и номер изделия на этот вопрос не отвечает. Подстановка
            // номера дала бы письмо «Ответственный: MSK1-2509-000001».
            responsible: responsibleName,
          },
          fallbackSubject: isManagerLevel
            ? `Эскалация: заказ ${order.orderNo} просрочен`
            : `Просрочка по заказу ${order.orderNo}`,
          fallbackBody: isManagerLevel
            ? `Заказ ${order.orderNo} просрочен более чем на рабочий день. Требуется вмешательство руководителя.`
            : `Заказ ${order.orderNo} просрочен. Этап: ${order.status}.`,
        });
        if (notification !== null) created += 1;
      } catch (error: unknown) {
        this.logger.error(`Заказ ${order.orderNo}: уведомление не создано — ${String(error)}`);
      }
    }
    return created;
  }

  /**
   * Кому адресована эскалация этого уровня.
   *
   * Ответственный зависит от ЭТАПА, а не от роли вообще: на производстве это
   * назначенный менеджер, на логистике — логист, на приёме — приёмщик,
   * оформивший заказ. Рассылка «всем приёмщикам» размывает ответственность:
   * каждый решает, что займётся кто-то другой.
   *
   * Резервный получатель нужен, потому что назначенный мог уволиться или быть в
   * отпуске: без него просрочка осталась бы без адресата.
   */
  private async resolveRecipients(
    order: {
      status: string;
      createdById: string;
      productionManagerId: string | null;
      createdStoreId: string;
      productionManager: { email: string } | null;
    },
    level: EscalationLevel,
  ): Promise<Array<{ id: string; email: string }>> {
    if (level >= ESCALATION_LEVEL.MANAGER) {
      /*
       * Руководитель — ОТДЕЛЬНАЯ ветка, а не «ответственный плюс руководитель»:
       * ответственного уже оповестили на первом уровне, и повторять ему то же
       * самое значит удваивать шум.
       */
      return this.findByRole('MANAGER');
    }

    const stage = stageForStatus(order.status as never);

    if (stage === NORM_STAGE.PRODUCTION) {
      // Назначенный менеджер производства отвечает за конкретный заказ.
      if (order.productionManagerId !== null) {
        /*
         * Назначенный менеджер уже загружен вместе с заказом — вместе с именем и
         * адресом. Отдельный запрос к базе здесь не нужен.
         */
        return [
          {
            id: order.productionManagerId,
            email: order.productionManager?.email ?? '',
          },
        ];
      }
      // Резерв: назначенного нет — берём менеджеров производства.
      return this.findByRole('PRODUCTION_MANAGER');
    }

    if (stage === NORM_STAGE.LOGISTICS_OUT || stage === NORM_STAGE.LOGISTICS_IN) {
      return this.findByRole('LOGISTICIAN');
    }

    if (stage === NORM_STAGE.QUEUE) {
      return this.findByRole('PRODUCTION_MANAGER');
    }

    /*
     * Приём, согласование, предоплата, выдача — ответственный приёмщик,
     * оформивший заказ. Если он недоступен, резерв — приёмщики магазина:
     * без резерва просрочка осталась бы без адресата.
     */
    const author = await this.prisma.user.findFirst({
      where: { id: order.createdById, isActive: true },
      select: { id: true, email: true },
    });
    if (author !== null) return [author];

    return this.prisma.user.findMany({
      where: {
        isActive: true,
        roles: { some: { role: 'RECEIVER' as never, storeId: order.createdStoreId } },
      },
      select: { id: true, email: true },
      take: 5,
    });
  }

  /**
   * Активные пользователи роли.
   *
   * Роль лежит в отдельной таблице `UserRole` (у сотрудника их может быть
   * несколько), поэтому фильтр идёт по связи `roles.some`. Ограничение в пять
   * человек — чтобы не разослать уведомление всему штату.
   */
  private async findByRole(role: string): Promise<Array<{ id: string; email: string }>> {
    return this.prisma.user.findMany({
      where: { isActive: true, roles: { some: { role: role as never } } },
      /*
       * Почта берётся здесь же: уведомление сотруднику уходит по ДВУМ каналам
       * (задача 5.9), а отдельный запрос за адресом был бы лишним обращением к
       * базе на каждого получателя.
       */
      select: { id: true, email: true },
      take: 5,
    });
  }
}
