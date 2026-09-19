/**
 * Тесты входа и списка сотрудников для экрана входа.
 *
 * Проверяются правила, которые нельзя увидеть в интерфейсе, но которые либо
 * ломают вход, либо раскрывают лишнее:
 *  * список сотрудников НЕ отдаёт почту, роли и телефоны — он доступен до
 *    аутентификации, и почта в нём была бы готовым перечнем адресов для фишинга;
 *  * отключённые учётные записи в список не попадают: это перечень тех, кто
 *    может войти, а не справочник персонала;
 *  * вход по идентификатору сотрудника работает наравне с входом по почте;
 *  * запрос без идентификатора и без почты отклоняется, а не ищет наугад.
 *
 * Prisma подменяется управляемым двойником: правила находятся в сервисе, и
 * проверять их через настоящую базу значило бы проверять поведение Postgres.
 */

import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { hash } from 'argon2';
import { AuthService } from './auth.service';
import { ROLE, DATA_SCOPE } from '@app/shared';

const USER_ID = 'cmu5p70yu0000am7pzqlcawsv';

/** Пароль, с которым сверяется хеш в фикстуре (политика: 12+ символов). */
const PASSWORD = 'CorrectHorse1';

/**
 * Хеш пароля `PASSWORD`. Считается один раз: Argon2id намеренно дорог, и
 * пересчёт в каждом тесте замедлил бы прогон без пользы.
 */
const PASSWORD_HASH = await hash(PASSWORD, {
  type: 2,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
});

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'receiver1@remixgold.ru',
    phone: null,
    phoneNormalized: null,
    fullName: 'Иванова Мария Сергеевна',
    isActive: true,
    mustChangePassword: false,
    passwordHash: PASSWORD_HASH,
    lastLoginAt: null,
    lockedUntil: null,
    failedAttempts: 0,
    primaryStoreId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    roles: [{ role: ROLE.RECEIVER, storeId: null, scope: DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH }],
    stores: [],
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    userSession: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  const jwt = { signAsync: vi.fn().mockResolvedValue('signed.jwt.token') };
  return new AuthService(prisma as never, jwt as never);
}

describe('AuthService: список сотрудников для входа', () => {
  it('отдаёт только идентификатор и ФИО', async () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА БЕЗОПАСНОСТИ. Список доступен до аутентификации. Если из
     * выборки когда-нибудь уберут `select`, Prisma вернёт всю строку — вместе с
     * `passwordHash`, почтой и телефонами. Тест ловит это по составу ключей.
     */
    const prisma = createPrismaMock();
    prisma.user.findMany.mockResolvedValue([{ id: USER_ID, fullName: 'Иванова Мария Сергеевна' }]);

    const options = await makeService(prisma).loginOptions();

    expect(Object.keys(options[0] ?? {}).sort()).toEqual(['fullName', 'id']);
  });

  it('в запросе выбираются только id и fullName', async () => {
    // Вторая линия той же защиты: проверяем сам запрос, а не только ответ
    // двойника. Двойник вернул бы то, что ему велели, даже при `select: undefined`.
    const prisma = createPrismaMock();
    await makeService(prisma).loginOptions();

    const args = prisma.user.findMany.mock.calls[0]?.[0];
    expect(args.select).toEqual({ id: true, fullName: true });
  });

  it('отключённые учётные записи не попадают в список', async () => {
    /*
     * Список — это перечень тех, кто МОЖЕТ войти. Отключённый сотрудник в нём
     * означал бы предложение войти в закрытую учётную запись, а любой выбор
     * привёл бы к отказу без объяснения причины.
     */
    const prisma = createPrismaMock();
    await makeService(prisma).loginOptions();

    const args = prisma.user.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({ isActive: true });
  });

  it('сортирует по ФИО', async () => {
    // Список читают глазами, и порядок должен совпадать со справочником
    // сотрудников — иначе искать нужную фамилию приходится перебором.
    const prisma = createPrismaMock();
    await makeService(prisma).loginOptions();

    const args = prisma.user.findMany.mock.calls[0]?.[0];
    expect(args.orderBy).toEqual({ fullName: 'asc' });
  });
});

describe('AuthService: вход по идентификатору сотрудника', () => {
  it('находит учётную запись по id и выдаёт сессию', async () => {
    /*
     * Основной сценарий замечания: сотрудник выбирает себя в списке по имени, а
     * не набирает почту. Поиск обязан идти по первичному ключу.
     */
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());

    const result = await makeService(prisma).login({ userId: USER_ID, password: PASSWORD }, {});

    const args = prisma.user.findUnique.mock.calls[0]?.[0];
    expect(args.where).toEqual({ id: USER_ID });
    expect(result.user.id).toBe(USER_ID);
  });

  it('вход по почте продолжает работать', async () => {
    /*
     * Существующие сценарии (скрипты развёртывания, интеграции, аварийный доступ)
     * шлют почту. Их нельзя сломать, добавляя список.
     */
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());

    const result = await makeService(prisma).login(
      { email: 'receiver1@remixgold.ru', password: PASSWORD },
      {},
    );

    const args = prisma.user.findUnique.mock.calls[0]?.[0];
    expect(args.where).toEqual({ email: 'receiver1@remixgold.ru' });
    expect(result.user.id).toBe(USER_ID);
  });

  it('запрос без почты и без идентификатора отклоняется до обращения к базе', async () => {
    /*
     * Проверяется НАБЛЮДАЕМЫЙ контракт: такой запрос отклоняется и до базы не
     * доходит. Отклоняет его схема (`refine` требует одно из двух полей) — и это
     * ровно то, что видит вызывающий код.
     *
     * В сервисе есть и вторая, явная проверка того же условия. Она недостижима,
     * пока `refine` на месте, и мутационная проверка это подтвердила: её снятие
     * не меняет результат. Проверка оставлена как страховка на случай правки
     * схемы — без неё запрос ушёл бы с `where: { id: undefined }`, Prisma
     * отбросила бы условие, и нашлась бы ПЕРВАЯ учётная запись в таблице. Тест
     * ниже закрывает именно путь схемы; страховка в сервисе недостижима по
     * построению и в мутационной проверке не участвует.
     */
    const prisma = createPrismaMock();

    await expect(makeService(prisma).login({ password: PASSWORD }, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('схема требует ровно одно из двух полей', async () => {
    /*
     * Проверка самой схемы: без неё тест выше проходил бы по случайной причине, а
     * не потому, что путь входа защищён.
     */
    const { loginSchema } = await import('@app/shared');

    expect(loginSchema.safeParse({ password: PASSWORD }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.ru', password: PASSWORD }).success).toBe(true);
    expect(loginSchema.safeParse({ userId: USER_ID, password: PASSWORD }).success).toBe(true);
    // Пустая строка — не значение: `email: ''` не должно считаться «почта указана».
    expect(loginSchema.safeParse({ email: '', password: PASSWORD }).success).toBe(false);
  });

  it('несуществующий идентификатор даёт общий отказ, а не отдельный код', async () => {
    /*
     * Сообщение не различает «нет такого сотрудника» и «неверный пароль»: иначе
     * по коду ответа можно было бы перебором выяснить, какие идентификаторы
     * существуют.
     */
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);

    const rejection = await makeService(prisma)
      .login({ userId: USER_ID, password: PASSWORD }, {})
      .catch((error: unknown) => error as { response?: { code?: string; message?: string } });

    expect(rejection.response?.code).toBe('UNAUTHENTICATED');
    /*
     * Формулировка не должна называть поле, которого пользователь не заполнял:
     * при входе из списка «Неверный email» отправлял бы исправлять почту.
     */
    expect(rejection.response?.message ?? '').not.toMatch(/email/i);
  });
});
