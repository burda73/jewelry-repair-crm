/**
 * Автостатус «Невостребовано» (задача 2.10, ТЗ п. 2.8).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Заказ готов к выдаче, клиент не приходит — и заказ остаётся
 * «готов к выдаче» навсегда. Через год таких заказов десятки, и понять, какие
 * изделия занимают место и чьи они, можно только пересмотрев всё. Статус
 * «невостребовано» отделяет «ждём клиента, который вот-вот придёт» от
 * «изделие лежит на хранении, и с ним надо что-то решать».
 *
 * ПОЧЕМУ ЧЕРЕЗ ПЕРЕХОД, А НЕ `UPDATE status`. Переход 19 несёт проверку порога
 * (`UNCLAIMED_THRESHOLD`), запись в историю статусов и роль `SYSTEM`. Прямая
 * запись обошла бы проверку: заказ перешёл бы в «невостребовано» раньше 30 дней
 * из-за сбоя в данных или ручной правки, и объяснить это было бы нечем.
 *
 * ПОЧЕМУ УВЕДОМЛЕНИЕ ЗДЕСЬ, А НЕ В ПЕРЕХОДЕ. Эффект `NOTIFY_RECEIVER` объявлен
 * в таблице переходов, но у `OrderWorkflowService` нет сервиса уведомлений, и
 * заводить его туда значило бы связать таблицу переходов с каналами доставки.
 * Воркер, который уже знает и о событии, и о получателе, отправляет уведомление
 * сам.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import { ORDER_STATUS } from '@app/shared';
import { NotificationsService, TEMPLATE_CODE } from '../notifications/notifications.service';

/** Сколько календарных дней заказ ждёт клиента до «невостребовано» (ТЗ п. 2.8). */
export const DEFAULT_UNCLAIMED_AFTER_DAYS = 30;

/** Итог прогона. */
export interface UnclaimedRunResult {
  /** Сколько готовых к выдаче заказов просмотрено. */
  scanned: number;
  /** Сколько переведено в «невостребовано». */
  unclaimed: number;
  /** Сколько пропущено, потому что порог ещё не наступил. */
  skipped: number;
}

@Injectable()
export class UnclaimedService {
  private readonly logger = new Logger(UnclaimedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: OrderWorkflowService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Прогон перевода в «невостребовано».
   *
   * @param now момент проверки; передаётся явно, чтобы прогон был проверяемым
   */
  async run(now: Date = new Date()): Promise<UnclaimedRunResult> {
    const thresholdDays = await this.thresholdDays();

    /*
     * Верхняя граница отсекается в запросе: заказ, готовый меньше 30 дней назад,
     * переводить не нужно, и отбирать его в память незачем. Индекс
     * `Order(status, readyAt)` покрывает условие.
     */
    const cutoff = new Date(now.getTime() - thresholdDays * 86_400_000);

    const orders = await this.prisma.order.findMany({
      where: {
        status: ORDER_STATUS.READY_FOR_PICKUP,
        readyAt: { not: null, lt: cutoff },
      },
      select: {
        id: true,
        orderNo: true,
        status: true,
        readyAt: true,
        version: true,
        createdStoreId: true,
      },
      take: 500,
    });

    const result: UnclaimedRunResult = { scanned: orders.length, unclaimed: 0, skipped: 0 };
    if (orders.length === 0) return result;

    for (const order of orders) {
      try {
        /*
         * Перевод идёт через общую таблицу переходов: она несёт проверку порога,
         * запись в историю и роль `SYSTEM`. Прямой `UPDATE status` обошёл бы
         * проверку, и заказ стал бы «невостребованным» раньше срока.
         */
        await this.workflow.transition({
          orderId: order.id,
          to: ORDER_STATUS.UNCLAIMED,
          actorId: 'system',
          actorRole: 'SYSTEM',
          version: order.version,
          scope: 'ALL_STORES',
          storeIds: [],
        });
        result.unclaimed += 1;
      } catch (error: unknown) {
        /*
         * Один заказ не должен останавливать прогон: остальные ждут своей
         * очереди, и падение на первом оставило бы их «готовыми к выдаче»
         * навсегда.
         */
        result.skipped += 1;
        this.logger.warn(`Заказ ${order.orderNo}: не переведён — ${String(error)}`);
        continue;
      }

      await this.notifyReceiver(order.orderNo, order.createdStoreId, order.id);
    }

    return result;
  }

  /**
   * Сообщить приёмщику магазина (ТЗ п. 2.8).
   *
   * Уведомление отправляется ПОСЛЕ перевода и не отменяет его: статус уже
   * изменён, и откатывать его из-за недоступной почты нельзя. Сбой уведомления
   * только пишется в журнал.
   */
  private async notifyReceiver(orderNo: string, storeId: string, orderId: string): Promise<void> {
    try {
      const receivers = await this.prisma.user.findMany({
        where: { isActive: true, roles: { some: { role: 'RECEIVER', storeId } } },
        select: { id: true },
        take: 5,
      });

      for (const receiver of receivers) {
        await this.notifications.notifyByTemplate({
          code: TEMPLATE_CODE.ORDER_UNCLAIMED,
          userId: receiver.id,
          orderId,
          recipient: receiver.id,
          values: { orderNo },
          fallbackSubject: `Заказ ${orderNo} невостребован`,
          fallbackBody: `Заказ ${orderNo} ожидает клиента более ${DEFAULT_UNCLAIMED_AFTER_DAYS} дней.`,
        });
      }
    } catch (error: unknown) {
      this.logger.warn(`Заказ ${orderNo}: уведомление приёмщику не отправлено — ${String(error)}`);
    }
  }

  /**
   * Порог в днях.
   *
   * Читается из настройки, а не из переменной окружения: срок хранения —
   * договорное условие, и менять его должен администратор без перезапуска
   * сервиса. Значение бессмысленное — берётся значение по умолчанию: ноль
   * перевёл бы в «невостребовано» заказ, готовый час назад.
   */
  private async thresholdDays(): Promise<number> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: 'orders.unclaimedAfterDays' },
    });
    if (setting === null) return DEFAULT_UNCLAIMED_AFTER_DAYS;

    const value: unknown = setting.value;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'object' && value !== null && 'value' in value) {
      const inner: unknown = value.value;
      if (typeof inner === 'number' && Number.isFinite(inner) && inner > 0) return inner;
    }
    return DEFAULT_UNCLAIMED_AFTER_DAYS;
  }
}
