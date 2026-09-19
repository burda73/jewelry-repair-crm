/**
 * Тесты сервиса уведомлений (задача 2.6, ТЗ п. 2.6 и 2.7).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Уведомление — это то, по чему сотрудник узнаёт о событии, и
 * ошибки здесь тихие: ничего не падает, просто человек не получает сообщения.
 * Проверяются правила, которые нельзя увидеть в схеме валидации:
 *
 *  * запись создаётся СО СТАТУСОМ `PENDING`, а не отправляется напрямую: при
 *    сбое провайдера событие не должно исчезать бесследно;
 *  * отсутствующий шаблон НЕ отменяет операцию: незаполненный справочник не
 *    должен блокировать перевозку партии;
 *  * чужое уведомление прочитать нельзя: лента личная, а идентификатор
 *    угадываем;
 *  * плейсхолдер без значения заменяется пустой строкой: получатель не должен
 *    видеть в письме `{{batchNo}}`.
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса, а не
 * поведение Postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  NOTIFICATION_CHANNEL,
  NOTIFICATION_STATUS,
  NotificationsService,
  TEMPLATE_CODE,
  renderTemplate,
} from './notifications.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

const USER_ID = 'cmu4cpwbg000bdl0ubltmh740';
const OTHER_USER_ID = 'cmu4cpwbg000cdl0ubltmh741';
const NOTIFICATION_ID = 'cmu5p70yu0001bm7pzqlcawsw';

const USER: AuthenticatedUser = {
  id: USER_ID,
  email: 'logist@remixgold.ru',
  role: 'LOGISTICIAN',
  storeIds: [],
} as AuthenticatedUser;

const NOW = new Date('2025-09-16T12:00:00Z');

/** Строка уведомления в форме, которую возвращает Prisma. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIFICATION_ID,
    userId: USER_ID,
    customerId: null,
    orderId: null,
    templateCode: TEMPLATE_CODE.BATCH_TRANSIT_LATE,
    channel: NOTIFICATION_CHANNEL.IN_APP,
    recipient: USER_ID,
    subject: 'Партия задерживается',
    body: 'Партия П-250916-001 в пути дольше норматива',
    status: NOTIFICATION_STATUS.PENDING,
    sentAt: null,
    readAt: null,
    error: null,
    attempts: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function makeService(
  prisma: Record<string, unknown> = {},
  /*
   * Настройки внешних каналов. По умолчанию оба выключены — это состояние
   * продакшна: SMS-провайдер ещё не подключён (задача 5.10).
   */
  env: Record<string, string> = {},
) {
  const client = {
    notificationTemplate: {
      findFirst: vi.fn(async () => null),
      ...(prisma.notificationTemplate as object),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        row({ ...data, createdAt: NOW }),
      ),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      updateMany: vi.fn(async () => ({ count: 0 })),
      ...(prisma.notification as object),
    },
    ...prisma,
  };
  const config = { get: (key: string) => env[key] } as never;
  const service = new NotificationsService(client as never, config);
  return { service, client };
}

describe('Подстановка в шаблон', () => {
  it('подставляет значения по именам', () => {
    expect(renderTemplate('Партия {{batchNo}} в пути', { batchNo: 'П-250916-001' })).toBe(
      'Партия П-250916-001 в пути',
    );
  });

  it('отсутствующая переменная заменяется пустой строкой', () => {
    /*
     * Иначе получатель увидит в письме техническую разметку `{{batchNo}}`, а это
     * выглядит как сбой системы. «Пусто» человек прочитает как отсутствие
     * данных, что и есть правда.
     */
    expect(renderTemplate('Партия {{batchNo}} в пути', {})).toBe('Партия  в пути');
    expect(renderTemplate('Партия {{batchNo}}', { batchNo: null })).toBe('Партия ');
  });

  it('пробелы внутри фигурных скобок допускаются', () => {
    expect(renderTemplate('{{ batchNo }}', { batchNo: 'A' })).toBe('A');
  });

  it('числа подставляются', () => {
    // Ноль — значение, а не «пусто»: партия с нулевым составом должна
    // отображаться как 0, иначе текст соврёт.
    expect(renderTemplate('Заказов: {{count}}', { count: 0 })).toBe('Заказов: 0');
  });
});

describe('Создание уведомления по шаблону (задача 2.6)', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('создаётся со статусом PENDING, а не SENT', () => {
    /*
     * Запись в базе — это очередь отправки. Отметка `SENT` сразу означала бы,
     * что при сбое провайдера событие потеряно: повторить его нечем, потому что
     * «уже отправлено».
     */
    return ctx.service
      .notifyByTemplate({
        code: TEMPLATE_CODE.BATCH_TRANSIT_LATE,
        userId: USER_ID,
        recipient: USER_ID,
        fallbackBody: 'Партия задерживается',
      })
      .then(() => {
        const data = ctx.client.notification.create.mock.calls[0][0].data;
        expect(data.status).toBe(NOTIFICATION_STATUS.PENDING);
        expect(data.sentAt).toBeUndefined();
      });
  });

  it('текст из шаблона имеет приоритет над запасным', async () => {
    ctx = makeService({
      notificationTemplate: {
        findFirst: vi.fn(async () => ({
          code: TEMPLATE_CODE.BATCH_TRANSIT_LATE,
          channel: NOTIFICATION_CHANNEL.IN_APP,
          subject: 'Задержка {{batchNo}}',
          body: 'Партия {{batchNo}} опаздывает',
          isActive: true,
        })),
      },
    });

    const result = await ctx.service.notifyByTemplate({
      code: TEMPLATE_CODE.BATCH_TRANSIT_LATE,
      userId: USER_ID,
      recipient: USER_ID,
      values: { batchNo: 'П-1' },
      fallbackBody: 'запасной текст',
    });

    expect(result?.subject).toBe('Задержка П-1');
    expect(result?.body).toBe('Партия П-1 опаздывает');
  });

  it('без шаблона используется запасной текст и уведомление всё равно создаётся', async () => {
    /*
     * Отсутствие шаблона — не ошибка бизнес-операции. Партия обязана
     * отправиться даже тогда, когда текст уведомления ещё не заполнен: иначе
     * незаполненный справочник блокировал бы перевозку изделий клиентов.
     */
    const result = await ctx.service.notifyByTemplate({
      code: TEMPLATE_CODE.BATCH_TRANSIT_LATE,
      userId: USER_ID,
      recipient: USER_ID,
      fallbackSubject: 'Задержка',
      fallbackBody: 'Партия в пути дольше норматива',
    });

    expect(result).not.toBeNull();
    expect(result?.subject).toBe('Задержка');
    expect(result?.body).toBe('Партия в пути дольше норматива');
    expect(ctx.client.notification.create).toHaveBeenCalledTimes(1);
  });

  it('отключённый шаблон не применяется', async () => {
    // Запрос ищет `isActive: true`: выключенный шаблон означает «это
    // уведомление сейчас не отправляем», а не «подставь старый текст».
    ctx = makeService({
      notificationTemplate: { findFirst: vi.fn(async () => null) },
    });

    await ctx.service.notifyByTemplate({
      code: TEMPLATE_CODE.BATCH_TRANSIT_LATE,
      userId: USER_ID,
      recipient: USER_ID,
      fallbackBody: 'запасной',
    });

    const where = ctx.client.notificationTemplate.findFirst.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
  });

  it('канал по умолчанию — IN_APP', async () => {
    await ctx.service.notifyByTemplate({
      code: TEMPLATE_CODE.BATCH_RECEIVED,
      userId: USER_ID,
      recipient: USER_ID,
    });

    const data = ctx.client.notification.create.mock.calls[0][0].data;
    expect(data.channel).toBe(NOTIFICATION_CHANNEL.IN_APP);
  });
});

describe('Уведомление сотрудника по двум каналам (задача 5.9)', () => {
  /*
   * ЗАЧЕМ ЭТИ ТЕСТЫ. Раньше к почте не обращался НИ ОДИН вызов: уведомление
   * появлялось в интерфейсе, а письмо не уходило. Сотрудник, не открывший
   * систему, о просрочке не узнавал — и обнаруживалось это только тогда, когда
   * он случайно заходил сам.
   */

  it('создаются оба уведомления: в интерфейсе и на почте', async () => {
    const ctx = makeService();

    const result = await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: 'receiver@remixgold.ru',
      orderId: 'order-1',
      values: { orderNo: 'MSK1-2509-000001' },
    });

    expect(result.inApp).not.toBeNull();
    expect(result.email).not.toBeNull();

    const channels = ctx.client.notification.create.mock.calls.map((call) => call[0].data.channel);
    expect(channels).toContain(NOTIFICATION_CHANNEL.IN_APP);
    expect(channels).toContain(NOTIFICATION_CHANNEL.EMAIL);
  });

  it('адресат каждого канала — свой', async () => {
    /*
     * Сообщение в интерфейсе адресуется идентификатору пользователя (по нему
     * строится лента), письмо — почтовому адресу. Перепутать их означает либо
     * письмо на «идентификатор», либо ленту, в которую уведомление не попало.
     */
    const ctx = makeService();

    await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: 'receiver@remixgold.ru',
    });

    const calls = ctx.client.notification.create.mock.calls.map((call) => call[0].data);
    const inApp = calls.find((data) => data.channel === NOTIFICATION_CHANNEL.IN_APP);
    const email = calls.find((data) => data.channel === NOTIFICATION_CHANNEL.EMAIL);

    expect(inApp.recipient).toBe(USER_ID);
    expect(email.recipient).toBe('receiver@remixgold.ru');
  });

  it('оба канала адресованы одному сотруднику', async () => {
    // Разные `userId` означали бы, что письмо ушло одному, а лента показала
    // другому.
    const ctx = makeService();

    await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ESCALATION_MANAGER,
      userId: USER_ID,
      email: 'receiver@remixgold.ru',
    });

    for (const call of ctx.client.notification.create.mock.calls) {
      expect(call[0].data.userId).toBe(USER_ID);
    }
  });

  it('без адреса письмо не создаётся, но уведомление в интерфейсе остаётся', async () => {
    /*
     * У сотрудника может не быть адреса. Терять из-за этого уведомление нельзя:
     * оно уже создано и видно в ленте.
     */
    const ctx = makeService();

    const result = await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: null,
    });

    expect(result.inApp).not.toBeNull();
    expect(result.email).toBeNull();
    expect(ctx.client.notification.create).toHaveBeenCalledTimes(1);
  });

  it('пустой адрес не создаёт письмо «в никуда»', async () => {
    // Пустая строка в `recipient` дала бы запись, которую невозможно отправить,
    // и она навсегда осталась бы в очереди с ошибкой.
    const ctx = makeService();

    const result = await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: '   ',
    });

    expect(result.email).toBeNull();
    expect(ctx.client.notification.create).toHaveBeenCalledTimes(1);
  });

  it('адрес обрезается от пробелов', async () => {
    /*
     * Адрес из карточки сотрудника мог быть сохранён с пробелом по краям.
     * Пробел в `recipient` — это неверный адрес: почтовый сервер отвергнет
     * письмо, и оно навсегда останется в очереди с постоянной ошибкой.
     */
    const ctx = makeService();

    await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: '  receiver@remixgold.ru  ',
    });

    const email = ctx.client.notification.create.mock.calls
      .map((call) => call[0].data)
      .find((data) => data.channel === NOTIFICATION_CHANNEL.EMAIL);
    expect(email.recipient).toBe('receiver@remixgold.ru');
  });

  it('заказ передаётся в оба канала', async () => {
    /*
     * `orderId` связывает уведомление с заказом: по нему лента и карточка заказа
     * показывают, о чём речь. Потеря его в письме означала бы, что переход к
     * заказу из письма невозможен, а в интерфейсе он был бы.
     */
    const ctx = makeService();

    await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: 'receiver@remixgold.ru',
      orderId: 'order-42',
    });

    for (const call of ctx.client.notification.create.mock.calls) {
      expect(call[0].data.orderId).toBe('order-42');
    }
  });

  it('канал письма — EMAIL, а не IN_APP', async () => {
    /*
     * Если бы оба уведомления создавались с каналом `IN_APP`, письмо не ушло бы
     * вовсе: воркер отправки берёт из очереди только записи с поддержанным
     * каналом, и `IN_APP`-запись он считает уже доставленной.
     */
    const ctx = makeService();

    await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: 'receiver@remixgold.ru',
    });

    const channels = ctx.client.notification.create.mock.calls.map((c) => c[0].data.channel);
    expect(channels).toEqual([NOTIFICATION_CHANNEL.IN_APP, NOTIFICATION_CHANNEL.EMAIL]);
  });

  it('шаблоны ищутся по своему каналу', async () => {
    /*
     * Ключ поиска — пара «код + канал» (уникальный индекс изменён в задаче 5.9).
     * Пока уникальным был один код, у шаблонов стоял канал `IN_APP`, и письмо НЕ
     * НАХОДИЛО текста вовсе: уходил запасной «Событие: ORDER_OVERDUE».
     */
    const ctx = makeService();

    await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: 'receiver@remixgold.ru',
    });

    const channelsQueried = ctx.client.notificationTemplate.findFirst.mock.calls.map(
      (call) => call[0].where.channel,
    );
    expect(channelsQueried).toContain(NOTIFICATION_CHANNEL.IN_APP);
    expect(channelsQueried).toContain(NOTIFICATION_CHANNEL.EMAIL);
  });

  it('значения подставляются в оба канала', async () => {
    // Номер заказа должен попасть и в письмо, и в сообщение в интерфейсе: иначе
    // получатель прочитает «Заказ  просрочен» без номера.
    const ctx = makeService({
      notificationTemplate: {
        findFirst: vi.fn(async () => ({
          code: TEMPLATE_CODE.ORDER_OVERDUE,
          subject: 'Просрочка {{orderNo}}',
          body: 'Заказ {{orderNo}} просрочен',
          isActive: true,
        })),
      },
    });

    await ctx.service.notifyStaff({
      code: TEMPLATE_CODE.ORDER_OVERDUE,
      userId: USER_ID,
      email: 'receiver@remixgold.ru',
      values: { orderNo: 'MSK1-2509-000001' },
    });

    for (const call of ctx.client.notification.create.mock.calls) {
      expect(call[0].data.body).toContain('MSK1-2509-000001');
    }
  });
});

describe('Лента уведомлений (задача 2.6)', () => {
  it('показываются только уведомления самого пользователя', async () => {
    /*
     * Лента личная: это сообщения сотруднику, а не рабочий документ. Без
     * фильтра по `userId` любой увидел бы чужие уведомления.
     */
    const { service, client } = makeService();
    await service.listMine(USER);

    const where = client.notification.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe(USER_ID);
    expect(where.channel).toBe(NOTIFICATION_CHANNEL.IN_APP);
  });

  it('прочитанные не считаются непрочитанными', async () => {
    const { service, client } = makeService();
    await service.unreadCount(USER);

    const where = client.notification.count.mock.calls[0][0].where;
    expect(where.status.in).toEqual([NOTIFICATION_STATUS.PENDING, NOTIFICATION_STATUS.SENT]);
  });

  it('чужое уведомление не читается: 404, а не 403', async () => {
    /*
     * 403 подтвердил бы, что запись существует. Идентификаторы угадываемы,
     * поэтому чужое уведомление должно выглядеть как несуществующее.
     */
    const { service } = makeService({
      notification: { findFirst: vi.fn(async () => null) },
    });

    await expect(service.markRead(NOTIFICATION_ID, USER)).rejects.toThrow(NotFoundException);
  });

  it('поиск уведомления идёт с проверкой владельца', async () => {
    // Недостаточно проверить существование: фильтр по владельцу обязателен.
    const { service, client } = makeService({
      notification: {
        findFirst: vi.fn(async () => row({ userId: OTHER_USER_ID })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      },
    });

    await service.markRead(NOTIFICATION_ID, USER);
    expect(client.notification.findFirst.mock.calls[0][0].where).toEqual({
      id: NOTIFICATION_ID,
      userId: USER_ID,
    });
  });

  it('отметка о прочтении ставит время', async () => {
    // Без `readAt` нельзя понять, когда сотрудник увидел сообщение.
    const { service, client } = makeService({
      notification: {
        findFirst: vi.fn(async () => row()),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      },
    });

    const result = await service.markRead(NOTIFICATION_ID, USER);
    expect(result.status).toBe(NOTIFICATION_STATUS.READ);
    expect(result.readAt).not.toBeNull();
    expect(client.notification.update.mock.calls[0][0].data.status).toBe(NOTIFICATION_STATUS.READ);
  });

  it('«прочитать все» затрагивает только непрочитанные', async () => {
    // Иначе повторный вызов перезаписывал бы время прочтения у уже прочитанных.
    const { service, client } = makeService();
    await service.markAllRead(USER);

    const where = client.notification.updateMany.mock.calls[0][0].where;
    expect(where.userId).toBe(USER_ID);
    expect(where.status.in).toEqual([NOTIFICATION_STATUS.PENDING, NOTIFICATION_STATUS.SENT]);
  });
});

describe('Отправка и повтор (задача 2.6)', () => {
  it('успешная отправка ставит SENT, время и увеличивает число попыток', async () => {
    const { service, client } = makeService({
      notification: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      },
    });

    await service.markSent(NOTIFICATION_ID);

    const data = client.notification.update.mock.calls[0][0].data;
    expect(data.status).toBe(NOTIFICATION_STATUS.SENT);
    expect(data.sentAt).toBeInstanceOf(Date);
    expect(data.attempts).toEqual({ increment: 1 });
  });

  it('сбой отправки сохраняет ошибку и НЕ теряет уведомление', async () => {
    /*
     * При сбое провайдера уведомление остаётся в базе со статусом `FAILED` и
     * текстом ошибки, чтобы его можно было повторить. Если бы запись удалялась
     * или помечалась отправленной, событие исчезло бы бесследно.
     */
    const { service, client } = makeService({
      notification: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      },
    });

    await service.markFailed(NOTIFICATION_ID, 'SMTP timeout');

    const data = client.notification.update.mock.calls[0][0].data;
    expect(data.status).toBe(NOTIFICATION_STATUS.FAILED);
    expect(data.error).toBe('SMTP timeout');
    expect(data.attempts).toEqual({ increment: 1 });
  });

  it('длинный текст ошибки обрезается', async () => {
    // Ошибка внешней системы может прийти простыней: поле в базе ограничено, и
    // запись не должна падать из-за длины сообщения.
    const { service, client } = makeService({
      notification: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      },
    });

    await service.markFailed(NOTIFICATION_ID, 'x'.repeat(5000));

    expect((client.notification.update.mock.calls[0][0].data.error as string).length).toBe(500);
  });
});

describe('Уведомление клиента (задача 5.10)', () => {
  const SMS_ON = { NOTIFICATIONS_SMS_ENABLED: 'true' };

  it('при выключенном канале уведомление не создаётся', async () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА ЗАДАЧИ. Запись без получателя и без канала навсегда
     * осталась бы в статусе `FAILED` и копилась бы в списке «требует
     * вмешательства», то есть превратилась бы в постоянный шум. Отсутствие
     * SMS-канала — это настройка, а не сбой доставки.
     */
    const { service, client } = makeService();
    const created = await service.notifyCustomer({
      code: 'READY_FOR_PICKUP',
      customerId: 'c-1',
      phone: '+79161234567',
    });

    expect(created).toEqual([]);
    expect(client.notification.create).not.toHaveBeenCalled();
  });

  it('при включённом канале уведомление создаётся с каналом SMS', async () => {
    // Обратная проверка: включение канала обязано работать, иначе задача
    // «включение по настройке» не выполнена.
    const { service, client } = makeService({}, SMS_ON);
    const created = await service.notifyCustomer({
      code: 'READY_FOR_PICKUP',
      customerId: 'c-1',
      phone: '+79161234567',
    });

    expect(created).toHaveLength(1);
    const data = client.notification.create.mock.calls[0][0].data;
    expect(data.channel).toBe('SMS');
    expect(data.recipient).toBe('+79161234567');
    // Уведомление СОЗДАЁТСЯ, а не отправляется: отправка — дело воркера, в
    // отдельной транзакции. Иначе недоступный шлюз откатывал бы выдачу заказа.
    expect(data.status).toBe('PENDING');
  });

  it('без телефона уведомление не создаётся', async () => {
    // Отправлять некуда: запись осталась бы висеть в очереди без получателя.
    const { service, client } = makeService({}, SMS_ON);
    const created = await service.notifyCustomer({
      code: 'READY_FOR_PICKUP',
      customerId: 'c-1',
      phone: null,
    });

    expect(created).toEqual([]);
    expect(client.notification.create).not.toHaveBeenCalled();
  });

  it('пустой телефон не считается заполненным', async () => {
    // Пробелы в поле телефона — частая ошибка ввода; создавать запись с
    // получателем «   » бессмысленно.
    const { service, client } = makeService({}, SMS_ON);
    const created = await service.notifyCustomer({
      code: 'READY_FOR_PICKUP',
      customerId: 'c-1',
      phone: '   ',
    });

    expect(created).toEqual([]);
    expect(client.notification.create).not.toHaveBeenCalled();
  });

  it('включение SMS не включает мессенджер', async () => {
    /*
     * Разные провайдеры и разные деньги. Общий флаг создал бы два уведомления,
     * и клиент получил бы одно и то же дважды.
     */
    const { service, client } = makeService({}, SMS_ON);
    await service.notifyCustomer({
      code: 'READY_FOR_PICKUP',
      customerId: 'c-1',
      phone: '+79161234567',
    });

    expect(client.notification.create).toHaveBeenCalledTimes(1);
    expect(client.notification.create.mock.calls[0][0].data.channel).toBe('SMS');
  });

  it('оба канала создают по уведомлению', async () => {
    // Клиент получает сообщение там, где ему удобно; записи разные, потому что
    // отслеживаются отдельно.
    const { service, client } = makeService(
      {},
      { NOTIFICATIONS_SMS_ENABLED: 'true', NOTIFICATIONS_MESSENGER_ENABLED: 'true' },
    );
    const created = await service.notifyCustomer({
      code: 'READY_FOR_PICKUP',
      customerId: 'c-1',
      phone: '+79161234567',
    });

    expect(created).toHaveLength(2);
    const channels = client.notification.create.mock.calls.map(
      (call: { 0: { data: { channel: string } } }[]) => call[0].data.channel,
    );
    expect(channels).toContain('SMS');
    expect(channels).toContain('MESSENGER');
  });

  it('внутренний канал клиенту не создаётся', async () => {
    /*
     * У клиента нет учётной записи: `IN_APP`-запись ему не создать. Если бы
     * канал попал в набор, он молча копился бы в базе и никогда не был бы
     * прочитан.
     */
    const { service, client } = makeService(
      {},
      { NOTIFICATIONS_SMS_ENABLED: 'true', NOTIFICATIONS_MESSENGER_ENABLED: 'true' },
    );
    await service.notifyCustomer({
      code: 'READY_FOR_PICKUP',
      customerId: 'c-1',
      phone: '+79161234567',
    });

    const channels = client.notification.create.mock.calls.map(
      (call: { 0: { data: { channel: string } } }[]) => call[0].data.channel,
    );
    expect(channels).not.toContain('IN_APP');
    expect(channels).not.toContain('EMAIL');
  });

  it('событие без правила каналов не создаёт уведомлений', async () => {
    // Опечатка в коде шаблона не должна превращаться в отправку «чего-то» по
    // каналам, которые никто не выбирал.
    const { service, client } = makeService({}, SMS_ON);
    const created = await service.notifyCustomer({
      code: 'ОПЕЧАТКА',
      customerId: 'c-1',
      phone: '+79161234567',
    });

    expect(created).toEqual([]);
    expect(client.notification.create).not.toHaveBeenCalled();
  });
});
