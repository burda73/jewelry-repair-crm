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

function makeService(prisma: Record<string, unknown> = {}) {
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
  const service = new NotificationsService(client as never);
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
