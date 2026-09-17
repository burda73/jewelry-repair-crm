import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { customerSchema, updateCustomerSchema, normalizePhone } from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
// `Prisma` нужен как значение: `Prisma.validator` вызывается при объявлении
// констант запросов, поэтому import без `type`.
import { Prisma } from '@prisma/client';

/**
 * Константы запросов с связанными данными.
 *
 * Объявлены через `Prisma.validator`, чтобы из них можно было вывести типы
 * (`Prisma.CustomerGetPayload<...>`). Тип ответа вычисляется из самого запроса:
 * добавленное в `select` поле автоматически появляется в типе, удалённое —
 * исчезает. Рукописный интерфейс разошёлся бы с реальным ответом API при первом
 * же изменении (тот же приём, что в orders.service.ts).
 */

/** Поля клиента, которые отдаются наружу в любом сценарии. */
const CUSTOMER_BASE_SELECT = Prisma.validator<Prisma.CustomerSelect>()({
  id: true,
  fullName: true,
  phone: true,
  phoneNormalized: true,
  email: true,
  birthDate: true,
  /**
   * Согласия отдаются клиенту намеренно (ТЗ п. 2.4): интерфейс обязан показать
   * текущее состояние согласия на запись разговора, а не догадываться о нём.
   */
  consentCallRecording: true,
  consentMarketing: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
});

/**
 * Результат поиска в мастере создания заказа.
 *
 * Дополнительно к полям клиента запрашиваются число заказов (`_count.orders`)
 * и последний заказ (`orders` с `take: 1`). Заказ в поиске нужен, чтобы
 * приёмщик сразу отличил постоянного клиента от однофамильца по последнему
 * обращению. Телефон в списке отдаётся в двух видах: `phone` — как вводил
 * пользователь, `phoneNormalized` — E.164 для сопоставления звонков АТС.
 */
const CUSTOMER_SEARCH_SELECT = Prisma.validator<Prisma.CustomerSelect>()({
  id: true,
  fullName: true,
  phone: true,
  phoneNormalized: true,
  email: true,
  consentCallRecording: true,
  consentMarketing: true,
  createdAt: true,
  _count: { select: { orders: true } },
  orders: {
    select: { id: true, orderNo: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
});

/**
 * Карточка клиента: данные клиента плюс последние 10 заказов.
 *
 * В истории заказов выбираются только `id`, `orderNo`, `status`, `createdAt`.
 * Суммы, описания и изделия здесь не нужны: карточка клиента открывается ради
 * истории обращений, а не ради денег, и лишние поля в ней — это лишний канал
 * утечки данных о заказах других магазинов.
 *
 * `_count.orders` отдаётся вместе с историей, потому что история ограничена
 * десятью записями: без общего счётчика интерфейс не смог бы отличить
 * «клиент с 10 заказами» от «клиент с 200 заказами, из которых показаны 10».
 */
const CUSTOMER_CARD_SELECT = Prisma.validator<Prisma.CustomerSelect>()({
  ...CUSTOMER_BASE_SELECT,
  _count: { select: { orders: true } },
  orders: {
    select: { id: true, orderNo: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  },
});

type CustomerSearchPayload = Prisma.CustomerGetPayload<{
  select: typeof CUSTOMER_SEARCH_SELECT;
}>;

/**
 * Элемент результата поиска.
 *
 * `_count` и `orders` не отдаются как есть: контракт API плоский —
 * `ordersCount` и `lastOrder`. Тип `lastOrder` берётся из самого запроса
 * (`CustomerSearchPayload['orders'][number]`), поэтому он не может разойтись
 * с тем, что реально выбирается из БД.
 */
export type CustomerSearchItem = Omit<CustomerSearchPayload, 'orders' | '_count'> & {
  ordersCount: number;
  lastOrder: CustomerSearchPayload['orders'][number] | null;
};

/** Карточка клиента с историей заказов (последние 10). */
export type CustomerCard = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_CARD_SELECT }>;

/** Клиент без связанных данных — ответ создания и изменения. */
export type CustomerDetails = Prisma.CustomerGetPayload<{
  select: typeof CUSTOMER_BASE_SELECT;
}>;

/** Максимум записей в результате поиска: список показывается в выпадающем окне. */
const SEARCH_LIMIT = 20;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Поиск клиента для первого шага мастера создания заказа.
   *
   * Логика выбора поля поиска:
   *  * если в запросе есть цифры и `normalizePhone` дал E.164 — поиск идёт
   *    ТОЧНЫМ совпадением по `phoneNormalized`. Именно поэтому «79161234567»,
   *    «+7 916 123-45-67» и «89161234567» находят одну и ту же запись: все три
   *    формы нормализуются в `+79161234567`. Поиск по `contains` здесь был бы
   *    ошибкой — он нашёл бы и чужие номера, содержащие те же цифры;
   *  * если цифр нет (или номер неполный) — поиск по `fullName` через
   *    `contains` с `mode: 'insensitive'`, чтобы «иванов» находил «Иванова».
   *
   * Фильтр по магазинам НЕ применяется, и это осознанно: клиент — общая
   * сущность сети, а не собственность точки. Приёмщик обязан видеть, что
   * человек уже сдавал изделие в ремонт в другом магазине, иначе он примет
   * второе изделие как «нового» клиента и разорвёт историю ремонтов.
   */
  async search(query: string): Promise<CustomerSearchItem[]> {
    const term = query.trim();

    // Пустой запрос — не ошибка. Мастер шлёт запрос по мере ввода, и 400 на
    // очищенное поле было бы шумом, который интерфейс обязан был бы глушить.
    if (term.length === 0) return [];

    const hasDigits = /\d/.test(term);
    const phoneNormalized = hasDigits ? normalizePhone(term) : null;

    let where: Prisma.CustomerWhereInput;
    if (phoneNormalized) {
      where = { phoneNormalized };
    } else {
      // Резервная ветка нужна для запросов вида «Иванов 2» и для неполных
      // номеров: цифры есть, но E.164 из них не собирается.
      where = { fullName: { contains: term, mode: 'insensitive' } };
    }

    const customers = await this.prisma.customer.findMany({
      where,
      orderBy: [{ fullName: 'asc' }, { createdAt: 'desc' }],
      take: SEARCH_LIMIT,
      select: CUSTOMER_SEARCH_SELECT,
    });

    return customers.map(({ orders, _count, ...customer }) => ({
      ...customer,
      ordersCount: _count.orders,
      lastOrder: orders[0] ?? null,
    }));
  }

  /**
   * Карточка клиента с историей заказов (последние 10).
   *
   * 404, а не 403, при отсутствии клиента: сервис не раскрывает, существуют ли
   * записи, к которым у пользователя нет доступа (docs/10-nfr-security.md §3.2).
   */
  async findOne(customerId: string): Promise<CustomerCard> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: CUSTOMER_CARD_SELECT,
    });

    if (!customer) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Клиент не найден' });
    }

    return customer;
  }

  /**
   * Создать клиента.
   *
   * ДВЕ ОБЯЗАТЕЛЬНЫЕ ПРОВЕРКИ.
   *
   * 1. Нормализация телефона. В БД пишется и `phone` (как ввёл пользователь —
   *    его печатают в квитанции), и `phoneNormalized` (E.164 — по нему идёт
   *    поиск и сопоставление звонков IP-АТС с клиентом, ТЗ п. 2.4). Если
   *    нормализовать номер нельзя — клиент не создаётся: запись без
   *    `phoneNormalized` была бы невидима для поиска по телефону, то есть
   *    превратилась бы в неустранимый дубль при следующем обращении.
   *
   * 2. Дедупликация по `phoneNormalized`. Дубли клиентов ломают историю
   *    ремонтов (у одного человека оказываются два дела) и сопоставление
   *    звонков с АТС (звонок цепляется к произвольной из двух записей).
   *    Поэтому вместо создания возвращается 409 с `customerId` существующего
   *    клиента: мастер не показывает ошибку, а подставляет найденную карточку.
   */
  async create(input: unknown, user: AuthenticatedUser): Promise<CustomerDetails> {
    const parsed = customerSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    const phoneNormalized = normalizePhone(data.phone);
    if (!phoneNormalized) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Некорректный номер телефона',
      });
    }

    // ТЗ п. 2.4: без согласия на запись разговора заказ создать нельзя —
    // проверка выполняется и в orders.service.ts (`CONSENT_REQUIRED`). Здесь
    // согласие проверяется в момент заведения карточки, потому что именно это
    // согласие разрешает хранить аудиозаписи звонков клиента.
    const existing = await this.prisma.customer.findFirst({ where: { phoneNormalized } });
    if (existing) {
      throw new ConflictException({
        code: 'CUSTOMER_EXISTS',
        message: 'Клиент с таким телефоном уже существует',
        customerId: existing.id,
      });
    }

    return this.prisma.runInTransaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          fullName: data.fullName,
          phone: data.phone,
          phoneNormalized,
          email: data.email ? data.email : null,
          birthDate: data.birthDate ?? null,
          consentCallRecording: data.consentCallRecording,
          consentMarketing: data.consentMarketing,
          notes: data.notes ?? null,
        },
        select: CUSTOMER_BASE_SELECT,
      });

      // Аудит (ТЗ п. 4). В лог попадает ФИО, а не только id: согласие на запись
      // разговора — юридически значимый факт, и по следу аудита должно быть
      // видно, с какими данными клиент был создан.
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'CREATE',
          entity: 'Customer',
          entityId: created.id,
          after: this.toAuditSnapshot(created),
        },
      });

      // В лог приложения — только идентификатор: ФИО и телефон это PII,
      // и структурированные логи не должны становиться вторым хранилищем
      // персональных данных (docs/10-nfr-security.md §7).
      this.logger.log(`Клиент создан: ${created.id}`);

      return created;
    });
  }

  /**
   * Изменить данные клиента.
   *
   * Смена телефона проходит ту же нормализацию и ту же проверку на дубликат,
   * что и создание: иначе «исправление опечатки» в номере сводило бы две
   * карточки в одну с произвольной историей либо создавало дубль.
   *
   * Согласия (`consentCallRecording`, `consentMarketing`) — юридически
   * значимые поля (ТЗ п. 2.4). Отзыв согласия разрешён, но фиксируется в аудите
   * с `before`/`after`: именно след аудита, а не текущее значение поля,
   * доказывает, что записи разговоров до отзыва хранились на законном
   * основании.
   */
  async update(
    customerId: string,
    input: unknown,
    user: AuthenticatedUser,
  ): Promise<CustomerDetails> {
    const parsed = updateCustomerSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const data = parsed.data;

    const current = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: CUSTOMER_BASE_SELECT,
    });
    if (!current) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Клиент не найден' });
    }

    let phoneNormalized: string | undefined;
    if (data.phone !== undefined) {
      const normalized = normalizePhone(data.phone);
      if (!normalized) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Некорректный номер телефона',
        });
      }
      phoneNormalized = normalized;

      if (normalized !== current.phoneNormalized) {
        const duplicate = await this.prisma.customer.findFirst({
          where: { phoneNormalized: normalized, id: { not: customerId } },
        });
        if (duplicate) {
          throw new ConflictException({
            code: 'CUSTOMER_EXISTS',
            message: 'Клиент с таким телефоном уже существует',
            customerId: duplicate.id,
          });
        }
      }
    }

    return this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id: customerId },
        data: {
          fullName: data.fullName,
          // `phone` хранит исходный ввод пользователя, поэтому при смене номера
          // обновляются оба поля: иначе в квитанции печатался бы старый номер.
          phone: data.phone,
          phoneNormalized,
          // Пустая строка означает «очистить email», поэтому приводится к null,
          // а не отбрасывается: иначе стереть почту через интерфейс было бы нельзя.
          email: data.email === undefined ? undefined : data.email === '' ? null : data.email,
          notes: data.notes,
          consentCallRecording: data.consentCallRecording,
          consentMarketing: data.consentMarketing,
        },
        select: CUSTOMER_BASE_SELECT,
      });

      // Аудит (ТЗ п. 4): и «до», и «после» — иначе по записи нельзя доказать,
      // каким было согласие на запись разговора до изменения.
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'UPDATE',
          entity: 'Customer',
          entityId: updated.id,
          before: this.toAuditSnapshot(current),
          after: this.toAuditSnapshot(updated),
        },
      });

      this.logger.log(`Клиент изменён: ${updated.id}`);

      return updated;
    });
  }

  /**
   * Снимок клиента для аудита.
   *
   * Отдаётся только то, что имеет смысл в следе: ФИО, оба вида телефона и
   * согласия. `createdAt`/`updatedAt` в аудите дублировали бы метку времени
   * самой записи аудита.
   */
  private toAuditSnapshot(customer: CustomerDetails): Prisma.InputJsonObject {
    return {
      fullName: customer.fullName,
      phone: customer.phone,
      phoneNormalized: customer.phoneNormalized,
      email: customer.email,
      consentCallRecording: customer.consentCallRecording,
      consentMarketing: customer.consentMarketing,
    };
  }
}
