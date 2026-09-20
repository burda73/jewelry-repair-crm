import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  checkOrderRollback,
  rollbackRejectMessage,
  rollbackReasonText,
  isTerminalStatus,
  stageForStatus,
  type OrderStatus,
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Откат заказа до любого состояния из его истории (инструмент администратора).
 *
 * ## Почему это отдельный сервис, а не ещё один переход
 *
 * Откат ОБХОДИТ таблицу переходов — в этом весь его смысл. Таблица описывает,
 * какие переходы допустимы при каких условиях, и именно она защищает от «выдали
 * изделие, а потом вернули в работу». Откат нужен для разбора ошибок, когда
 * заказ оказался в состоянии, куда его привела неверная операция, и вернуть его
 * штатным путём нельзя: обратного перехода может просто не быть.
 *
 * Провести это через `OrderWorkflowService.transition` нельзя: он проверяет
 * таблицу и откажет. Поэтому проверки вынесены в домен
 * (`checkOrderRollback`) и выполняются здесь заново — со своей ответственностью
 * за корректность.
 *
 * ## Что откат НЕ делает
 *
 * Он не трогает платежи, работы, согласования и документы. Откат меняет только
 * СОСТОЯНИЕ заказа, и это осознанно: возврат денег, отмена согласования и
 * аннулирование акта — отдельные операции со своими документами. Молчаливая
 * отмена их при откате статуса сделала бы расхождения с бухгалтерией
 * необъяснимыми.
 */
@Injectable()
export class OrderRollbackService {
  private readonly logger = new Logger(OrderRollbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Вернуть заказ в состояние из его истории.
   *
   * @param orderId заказ
   * @param targetStatus состояние, в которое откатываем
   * @param reason причина (обязательна — это след в документах)
   * @param user администратор
   */
  async rollback(
    orderId: string,
    targetStatus: string,
    reason: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    if (reason.trim().length < 3) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Укажите причину отката',
        details: { reason: ['Не менее 3 символов'] },
      });
    }

    await this.prisma.runInTransaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: {
          AND: [
            { id: orderId },
            this.prisma.buildOrderScopeFilter({
              scopes: user.scopes,
              storeIds: user.storeIds,
              userId: user.id,
            }),
          ],
        },
        select: {
          id: true,
          orderNo: true,
          status: true,
          dueAt: true,
          version: true,
        },
      });

      if (order === null) {
        // Не найдено ИЛИ вне области видимости → 404, не 403 (защита от IDOR).
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
      }

      /*
       * История читается целиком: целевой статус обязан быть среди ПРОЙДЕННЫХ
       * состояний этого заказа. Иначе опечатка или подделанный запрос перевели бы
       * заказ в состояние, которого у него никогда не было, и «откат» превратился
       * бы в произвольную смену статуса.
       */
      const history = await tx.orderStatusHistory.findMany({
        where: { orderId: order.id },
        select: { toStatus: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });

      const check = checkOrderRollback({
        currentStatus: order.status,
        history: history.map((entry) => ({ toStatus: entry.toStatus, at: entry.createdAt })),
        target: targetStatus,
        isFinal: isTerminalStatus(order.status),
      });

      if (!check.ok) {
        throw new ConflictException({
          code: 'ROLLBACK_REJECTED',
          message: rollbackRejectMessage(check.reason),
          details: { reason: check.reason, currentStatus: order.status },
        });
      }

      /*
       * Статус меняется с проверкой версии: если заказ одновременно изменил
       * другой сотрудник, откат затрёт его правку. Проверка обязательна именно
       * здесь — откат обходит штатный переход, а тот версию проверяет.
       */
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: {
          status: targetStatus as OrderStatus,
          version: { increment: 1 },
          /*
           * Срок пересчитывается как «неизвестен»: норматив целевого этапа
           * отсчитывался бы от СЕГОДНЯШНЕГО дня, и заказ, откаченный через
           * месяц, получил бы свежий дедлайн вместо давно истёкшего. Пустой
           * срок честнее: его назначит следующий штатный переход.
           */
          dueAt: null,
        },
      });

      if (updated.count === 0) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Заказ изменён другим сотрудником. Обновите страницу и повторите.',
        });
      }

      /*
       * Откат записывается НОВОЙ строкой истории, а не удалением прежних.
       *
       * Историю нельзя переписывать: она — документ о том, что происходило с
       * заказом, и «как будто этого не было» лишило бы разбора оснований.
       * Поэтому в истории остаётся и ошибочное состояние, и откат из него —
       * видно, кто и когда его сделал.
       */
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: targetStatus as OrderStatus,
          stage: stageForStatus(targetStatus as OrderStatus),
          changedById: user.id,
          isSystem: false,
          reason: rollbackReasonText(reason),
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'ORDER_ROLLBACK',
          entity: 'Order',
          entityId: order.id,
          reason: reason.trim(),
          before: { status: order.status, dueAt: order.dueAt },
          after: { status: targetStatus, dueAt: null },
        },
      });
    });

    this.logger.warn(`Заказ ${orderId}: откат в состояние ${targetStatus} (${user.email})`);
  }

  /**
   * Состояния, доступные для отката этого заказа.
   *
   * Возвращаются интерфейсу, чтобы в выпадающем списке были только пройденные
   * состояния: предлагать недостижимое значило бы гарантировать ошибку.
   */
  async availableStates(
    orderId: string,
    user: AuthenticatedUser,
  ): Promise<{ currentStatus: string; isFinal: boolean; states: string[] }> {
    const order = await this.prisma.order.findFirst({
      where: {
        AND: [
          { id: orderId },
          this.prisma.buildOrderScopeFilter({
            scopes: user.scopes,
            storeIds: user.storeIds,
            userId: user.id,
          }),
        ],
      },
      select: { status: true },
    });

    if (order === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    const history = await this.prisma.orderStatusHistory.findMany({
      where: { orderId },
      select: { toStatus: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Пройденные состояния без повторов и без текущего: откат в него бессмыслен.
    const seen = new Set<string>();
    const states: string[] = [];
    for (const entry of history) {
      if (entry.toStatus === order.status || seen.has(entry.toStatus)) continue;
      seen.add(entry.toStatus);
      states.push(entry.toStatus);
    }

    return {
      currentStatus: order.status,
      isFinal: isTerminalStatus(order.status),
      states,
    };
  }
}
