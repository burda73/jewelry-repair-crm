/**
 * Список заказов: разбор параметра `status` (дефект 69).
 *
 * РЕАЛЬНЫЙ ДЕФЕКТ. Контроллер оборачивал значение параметра в массив как есть.
 * Адрес `/orders?status=IN_WORK,WORK_COMPLETED` — а именно так выглядит срез,
 * скопированный из адресной строки (docs/08 §7), — уезжал в базу ОДНИМ значением
 * `"IN_WORK,WORK_COMPLETED"`. Prisma отвечала `Invalid value for argument 'in'`,
 * и список заказов возвращал **500**. Скопированная ссылка ломала экран, хотя
 * человек не сделал ничего необычного.
 *
 * Там же обнаружилось второе следствие того же места: неизвестный статус
 * (`?status=BOGUS`) давал ту же 500 вместо понятного 400 с указанием значения.
 *
 * ПОЧЕМУ НЕ БЫЛО ВИДНО. Интерфейс разбирает адрес у себя (`queryToFilters`
 * делит строку по запятой) и отправляет в API ПОВТОРЯЮЩИЙСЯ параметр
 * `status=A&status=B` — этот формат работал. Ломался только вход со стороны:
 * ссылка из адресной строки, закладка, чужая интеграция.
 */

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ORDER_STATUS } from '@app/shared';
import { OrdersController } from './orders.controller';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

function user(): AuthenticatedUser {
  return { id: 'u-1', email: 'u@remixgold.ru' } as unknown as AuthenticatedUser;
}

/** Контроллер с заглушками: проверяем только разбор параметров. */
function makeController() {
  const findAll = vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false }));
  const controller = new OrdersController(
    { findAll } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, findAll };
}

/** Статусы, доехавшие до сервиса. */
function statusesSent(findAll: ReturnType<typeof vi.fn>): unknown {
  return findAll.mock.calls[0]?.[0]?.status;
}

describe('Список заказов: status из адреса страницы (дефект 69)', () => {
  it('формат `A,B` доезжает до сервиса как ДВА статуса', () => {
    /*
     * Главная проверка исправления. Прежде до сервиса доезжала одна строка
     * `"IN_WORK,WORK_COMPLETED"`, и Prisma отвечала 500.
     */
    const { controller, findAll } = makeController();

    controller.findAll(user(), undefined, undefined, 'IN_WORK,WORK_COMPLETED');

    expect(statusesSent(findAll)).toEqual([ORDER_STATUS.IN_WORK, ORDER_STATUS.WORK_COMPLETED]);
  });

  it('формат клиента `A&status=B` продолжает работать', () => {
    // Этот формат интерфейс отправлял всегда, и его нельзя было сломать.
    const { controller, findAll } = makeController();

    controller.findAll(user(), undefined, undefined, ['IN_WORK', 'WORK_COMPLETED']);

    expect(statusesSent(findAll)).toEqual([ORDER_STATUS.IN_WORK, ORDER_STATUS.WORK_COMPLETED]);
  });

  it('смесь обоих форматов разбирается целиком', () => {
    const { controller, findAll } = makeController();

    controller.findAll(user(), undefined, undefined, ['IN_WORK,WORK_COMPLETED', 'REWORK']);

    expect(statusesSent(findAll)).toEqual([
      ORDER_STATUS.IN_WORK,
      ORDER_STATUS.WORK_COMPLETED,
      ORDER_STATUS.REWORK,
    ]);
  });

  it('без параметра статус не отправляется вовсе', () => {
    // `undefined` означает «фильтра нет»; пустой массив Prisma поняла бы как
    // `{ in: [] }` — запрос, не возвращающий ничего.
    const { controller, findAll } = makeController();

    controller.findAll(user(), undefined, undefined, undefined);

    expect(statusesSent(findAll)).toBeUndefined();
  });

  it('пустой параметр не превращается в фильтр по пустоте', () => {
    const { controller, findAll } = makeController();

    controller.findAll(user(), undefined, undefined, '');

    expect(statusesSent(findAll)).toBeUndefined();
  });

  it('неизвестный статус — 400 с указанием значения, а не 500', () => {
    /*
     * Прежде Prisma падала уже в сервисе, и наружу уходило
     * `{"statusCode":500,"message":"Internal server error"}`. Человек по такой
     * ошибке не мог понять, что не так с его ссылкой.
     */
    const { controller, findAll } = makeController();

    expect(() => controller.findAll(user(), undefined, undefined, 'BOGUS')).toThrow(
      BadRequestException,
    );
    // До базы запрос не дошёл: ошибка отсечена до сервиса.
    expect(findAll).not.toHaveBeenCalled();
  });

  it('сообщение об ошибке называет неверное значение', () => {
    // «Ошибка валидации» без значения заставила бы гадать, какой параметр
    // неверен в ссылке из десятка условий.
    const { controller } = makeController();

    try {
      controller.findAll(user(), undefined, undefined, ['IN_WORK', 'BOGUS']);
      expect.unreachable('должно было выбросить BadRequestException');
    } catch (error) {
      const response = (error as BadRequestException).getResponse();
      expect(response).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(JSON.stringify(response)).toContain('BOGUS');
    }
  });

  it('валидные статусы вместе с невалидным всё равно дают 400', () => {
    /*
     * Молча отбросить `BOGUS` значило бы вернуть полный список заказов: человек
     * просил отфильтровать, а получил всё и решил бы, что фильтр не работает.
     */
    const { controller, findAll } = makeController();

    expect(() => controller.findAll(user(), undefined, undefined, 'IN_WORK,BOGUS')).toThrow(
      BadRequestException,
    );
    expect(findAll).not.toHaveBeenCalled();
  });

  it('область видимости и прочие фильтры не теряются при разборе статусов', () => {
    // Исправление касалось только статуса: остальные условия обязаны дойти.
    const { controller, findAll } = makeController();

    controller.findAll(user(), '25', undefined, 'IN_WORK', undefined, 'true');

    expect(findAll.mock.calls[0]?.[0]).toMatchObject({ limit: 25, overdue: true });
  });
});
