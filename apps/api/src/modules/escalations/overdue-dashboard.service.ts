/**
 * Дашборд просроченных заказов (задача 2.9, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Эскалация сообщает о просрочке, когда она уже случилась, и
 * сообщает адресно. Но руководителю нужно видеть картину целиком: сколько
 * просрочено, где, на каком этапе и насколько. Без этого каждая просрочка
 * разбирается как отдельный случай, а общая причина (например, цех перегружен)
 * не видна.
 *
 * ПОЧЕМУ СЧИТАЕТСЯ ПО `dueAt`, А НЕ ПО ФАКТУ ОТПРАВКИ УВЕДОМЛЕНИЯ. Дашборд
 * обязан показывать просрочку и тогда, когда уведомление не ушло: недоступная
 * почта не отменяет просроченный срок. Обратная зависимость («показать то, о чём
 * предупредили») скрыла бы ровно те заказы, которые остались без оповещения.
 *
 * ПОЧЕМУ АГРЕГАЦИЯ В ПАМЯТИ. Число просроченных заказов — это исключение, а не
 * норма: в исправно работающем магазине их единицы. `GROUP BY` по вычисляемому
 * «насколько просрочено» потребовал бы расчёта рабочих часов в SQL, где нет ни
 * производственного календаря, ни границ рабочего дня; дублировать эту логику
 * второй реализацией значит гарантировать расхождение с воркером эскалаций.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrderWorkflowService } from '../../common/workflow/order-workflow.service';
import { ESCALATION_LEVEL, ORDER_STATUS, assessEscalation, type OrderStatus } from '@app/shared';

/** Строка дашборда: один просроченный заказ. */
export interface OverdueOrderDto {
  id: string;
  orderNo: string;
  status: string;
  dueAt: string;
  /** Рабочих часов просрочки. */
  overdueWorkingHours: number;
  /** Достигнутый уровень эскалации. */
  escalationLevel: number;
  /** Просрочка требует вмешательства руководителя. */
  needsManager: boolean;
  storeId: string;
  storeName: string | null;
  customerName: string | null;
  totalAmountMinor: number;
}

/** Сводка по одному разрезу (магазин или этап). */
export interface OverdueGroupDto {
  /** Идентификатор разреза: `storeId` или код этапа. */
  key: string;
  /** Название для интерфейса. */
  label: string;
  count: number;
  /** Сумма просроченных заказов в копейках. */
  totalAmountMinor: number;
}

/** Ответ дашборда. */
export interface OverdueDashboardDto {
  /** Всего просроченных заказов. */
  total: number;
  /** Из них требуют вмешательства руководителя (просрочка больше рабочего дня). */
  needsManager: number;
  /** Сумма просроченных заказов в копейках. */
  totalAmountMinor: number;
  /** Разрез по магазинам. */
  byStore: OverdueGroupDto[];
  /** Разрез по этапам. */
  byStage: OverdueGroupDto[];
  /** Просроченные заказы, самые задержанные сверху. */
  orders: OverdueOrderDto[];
}

/** Человекочитаемые названия этапов для дашборда. */
const STAGE_LABELS: Record<string, string> = {
  AWAITING_APPROVAL: 'Согласование клиента',
  AWAITING_PREPAYMENT: 'Ожидание предоплаты',
  QUEUED_FOR_DISPATCH: 'Очередь на отправку',
  IN_TRANSIT_TO_PRODUCTION: 'Доставка в цех',
  IN_PRODUCTION: 'Производство',
  IN_TRANSIT_TO_STORE: 'Доставка в магазин',
  READY_FOR_PICKUP: 'Хранение до выдачи',
};

/**
 * Статусы, которые в просрочку не попадают.
 *
 * Совпадает со списком воркера эскалаций намеренно: дашборд и эскалация обязаны
 * видеть один и тот же набор заказов. Расхождение означало бы, что дашборд
 * показывает просрочку, о которой никого не оповестили, или наоборот.
 */
const EXCLUDED_STATUSES: OrderStatus[] = [
  ORDER_STATUS.DRAFT,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.AWAITING_PREPAYMENT,
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.REFUSED,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.UNCLAIMED,
];

@Injectable()
export class OverdueDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: OrderWorkflowService,
  ) {}

  /**
   * Собрать дашборд просрочек.
   *
   * @param now момент проверки; передаётся явно, чтобы результат был проверяемым
   */
  async build(now: Date = new Date()): Promise<OverdueDashboardDto> {
    const rows = await this.prisma.order.findMany({
      where: {
        dueAt: { not: null, lt: now },
        status: { notIn: EXCLUDED_STATUSES },
      },
      select: {
        id: true,
        orderNo: true,
        status: true,
        dueAt: true,
        escalationLevel: true,
        totalAmountMinor: true,
        createdStoreId: true,
        createdStore: { select: { name: true } },
        customer: { select: { fullName: true } },
      },
      take: 1000,
    });

    const empty: OverdueDashboardDto = {
      total: 0,
      needsManager: 0,
      totalAmountMinor: 0,
      byStore: [],
      byStage: [],
      orders: [],
    };
    if (rows.length === 0) return empty;

    const calendar = await this.workflow.loadCalendar();

    const orders: OverdueOrderDto[] = [];
    for (const row of rows) {
      const state = assessEscalation({
        dueAt: row.dueAt,
        now,
        calendar,
        currentLevel: row.escalationLevel,
      });
      // Проверка повторяется, хотя условие уже в запросе: расчёт рабочих часов
      // может дать ноль, если срок наступил внутри нерабочего окна. Показывать
      // такую строку как просрочку значит порождать ложную тревогу.
      if (!state.isOverdue) continue;

      orders.push({
        id: row.id,
        orderNo: row.orderNo,
        status: row.status,
        dueAt: (row.dueAt as Date).toISOString(),
        overdueWorkingHours: state.overdueWorkingHours,
        escalationLevel: row.escalationLevel,
        needsManager: state.level >= ESCALATION_LEVEL.MANAGER,
        storeId: row.createdStoreId,
        storeName: row.createdStore?.name ?? null,
        customerName: row.customer?.fullName ?? null,
        totalAmountMinor: row.totalAmountMinor,
      });
    }

    // Самые задержанные сверху: именно они требуют вмешательства первыми.
    orders.sort((a, b) => b.overdueWorkingHours - a.overdueWorkingHours);

    return {
      total: orders.length,
      needsManager: orders.filter((order) => order.needsManager).length,
      totalAmountMinor: orders.reduce((sum, order) => sum + order.totalAmountMinor, 0),
      byStore: groupBy(
        orders,
        (order) => order.storeId,
        (order) => order.storeName ?? 'Без магазина',
      ),
      byStage: groupBy(
        orders,
        (order) => order.status,
        (order) => STAGE_LABELS[order.status] ?? order.status,
      ),
      orders,
    };
  }
}

/** Сгруппировать строки по ключу и посчитать число и сумму. */
function groupBy(
  orders: readonly OverdueOrderDto[],
  keyOf: (order: OverdueOrderDto) => string,
  labelOf: (order: OverdueOrderDto) => string,
): OverdueGroupDto[] {
  const groups = new Map<string, OverdueGroupDto>();
  for (const order of orders) {
    const key = keyOf(order);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: labelOf(order),
        count: 1,
        totalAmountMinor: order.totalAmountMinor,
      });
    } else {
      existing.count += 1;
      existing.totalAmountMinor += order.totalAmountMinor;
    }
  }
  // Больные места сверху: разрез нужен, чтобы увидеть, где сосредоточены
  // просрочки, а не чтобы перечислить магазины по алфавиту.
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
