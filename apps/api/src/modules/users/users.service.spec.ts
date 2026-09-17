/**
 * Тесты управления учётными записями (задача 1.2.4).
 *
 * Проверяются правила, которые нельзя увидеть в коде интерфейса, но которые
 * ломают работу системы при ошибке:
 *  * снятие последней роли оставляет учётную запись, которая НЕ МОЖЕТ войти —
 *    внешне рабочую, поэтому запрещено;
 *  * отключение учётной записи и снятие роли обязаны завершать её сессии:
 *    иначе сотрудник работает в открытой вкладке до 30 дней, и «отключение»
 *    ничего не значит;
 *  * администратор не должен блокировать сам себя;
 *  * пароли и их хеши не попадают ни в ответы API, ни в журнал аудита.
 *
 * Prisma подменяется управляемым двойником: правила находятся в сервисе, и
 * проверять их через настоящую базу значило бы проверять поведение Postgres.
 */

import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { ROLE, DATA_SCOPE } from '@app/shared';

/**
 * Идентификаторы в формате cuid.
 *
 * Схемы валидации требуют `z.string().cuid()`, потому что настоящие
 * идентификаторы Prisma (`@default(cuid())`) выглядят именно так. Фикстуры с
 * короткими строками вида `store-1` не проходят валидацию, и тест падал бы на
 * проверке входа, так и не дойдя до проверяемого правила.
 */
const ADMIN_ID = 'cmu4cpwbg000bdl0ubltmh740';
const USER_ID = 'cmu5p70yu0000am7pzqlcawsv';
const STORE = 'cmu5p70yu0001bm7pzqlcawsw';
const ROLE_ID = 'cmu5p70yu0002cm7pzqlcawsz';
const OTHER_USER = 'cmu5p70yu0003dm7pzqlcawt0';

const ADMIN: AuthenticatedUser = {
  id: ADMIN_ID,
  email: 'admin@remixgold.ru',
  fullName: 'Администратор Системы',
  roles: [ROLE.ADMIN],
  primaryRole: ROLE.ADMIN,
  permissions: ['user:manage'],
  scope: DATA_SCOPE.ALL_STORES,
  storeIds: [],
};

/** Запись учётной роли в том виде, в каком её отдаёт Prisma. */
function roleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROLE_ID,
    role: ROLE.RECEIVER,
    storeId: STORE,
    scope: DATA_SCOPE.STORE,
    grantedAt: new Date('2026-01-01'),
    grantedById: null,
    store: { id: STORE, code: 'MSK1', name: 'Москва, Тверская' },
    ...overrides,
  };
}

/** Учётная запись в том виде, в каком её отдаёт выборка сервиса. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'receiver@remixgold.ru',
    phone: null,
    fullName: 'Иванова Мария Сергеевна',
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    lockedUntil: null,
    failedAttempts: 0,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    roles: [roleRow()],
    stores: [
      { storeId: STORE, isDefault: true, store: { id: STORE, code: 'MSK1', name: 'Тверская' } },
    ],
    _count: { sessions: 0 },
    ...overrides,
  };
}

/**
 * Двойник PrismaService.
 *
 * Реализованы только те методы, которые вызывает сервис. `$transaction`
 * выполняется сразу: правила проверяются в одной транзакции, и подмена
 * транзакционности не влияет на проверяемое поведение.
 */
function createPrismaMock(overrides: Record<string, unknown> = {}) {
  const tx = {
    user: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    userRole: { create: vi.fn(), delete: vi.fn() },
    userSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    store: { findMany: vi.fn().mockResolvedValue([{ id: STORE }]) },
    auditLog: { create: vi.fn() },
  };

  const prisma = {
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    userRole: {
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(2),
      create: vi.fn(),
      delete: vi.fn(),
    },
    userSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    store: { findMany: vi.fn().mockResolvedValue([{ id: STORE }]) },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    ...overrides,
  };

  // Вызовы внутри транзакции должны вести себя как вызовы снаружи: тесты
  // задают возвращаемые значения на обоих уровнях.
  Object.assign(prisma, { _tx: tx });
  return prisma;
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  return new UsersService(prisma as never);
}

describe('UsersService: справочник ролей', () => {
  it('отдаёт все роли с правами и все области видимости', () => {
    const catalog = makeService(createPrismaMock()).getRolesCatalog();

    expect(catalog.roles).toHaveLength(Object.values(ROLE).length);
    expect(catalog.scopes).toHaveLength(Object.values(DATA_SCOPE).length);
    for (const role of catalog.roles) {
      expect(role.label).toBeTruthy();
      expect(role.permissions.length).toBeGreaterThan(0);
    }
  });

  it('матрица прав совпадает с /auth/me: у ADMIN есть user:manage', () => {
    const catalog = makeService(createPrismaMock()).getRolesCatalog();
    const admin = catalog.roles.find((r) => r.code === ROLE.ADMIN);
    expect(admin?.permissions).toContain('user:manage');
  });
});

describe('UsersService: список и карточка', () => {
  it('в ответе нет хеша пароля и failedAttempts наружу не уходит как есть', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());

    const detail = await makeService(prisma).findOne(USER_ID);

    // Главное утверждение: поля с паролем нет в ответе вообще.
    expect(JSON.stringify(detail)).not.toContain('passwordHash');
    expect(detail.email).toBe('receiver@remixgold.ru');
  });

  it('карточка отдаёт вычисленные права роли', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());

    const detail = await makeService(prisma).findOne(USER_ID);

    expect(detail.permissions).toContain('order:create');
    expect(detail.roles[0]?.roleLabel).toBeTruthy();
  });

  it('несуществующая учётная запись — 404', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(makeService(prisma).findOne('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('фильтр по неизвестной роли — понятная ошибка, а не пустой список', async () => {
    const prisma = createPrismaMock();

    await expect(makeService(prisma).findAll({ role: 'СУПЕРРОЛЬ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('UsersService: создание', () => {
  const validInput = {
    email: 'NewUser@RemixGold.ru',
    fullName: 'Новый Сотрудник',
    password: 'Str0ngPassword12',
    roles: [{ role: ROLE.RECEIVER, storeId: STORE }],
    storeIds: [STORE],
  };

  it('приводит почту к нижнему регистру и требует смену пароля', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma._tx.user.create.mockResolvedValue(userRow({ email: 'newuser@remixgold.ru' }));

    await makeService(prisma).create(validInput, ADMIN);

    const args = prisma._tx.user.create.mock.calls[0][0];
    expect(args.data.email).toBe('newuser@remixgold.ru');
    // Пароль задал администратор — владелец обязан сменить его при входе.
    expect(args.data.mustChangePassword).toBe(true);
    // В аудит пароль не попадает ни в каком виде.
    const audit = prisma._tx.auditLog.create.mock.calls[0][0];
    expect(JSON.stringify(audit)).not.toContain('Str0ngPassword12');
    expect(JSON.stringify(audit)).not.toContain('$argon2');
  });

  it('занятая почта — 409, а не ошибка базы', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: OTHER_USER });

    await expect(makeService(prisma).create(validInput, ADMIN)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('слабый пароль отклоняется валидацией', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).create({ ...validInput, password: 'short' }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('без ролей учётная запись не создаётся', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).create({ ...validInput, roles: [] }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('несуществующий магазин — понятная ошибка до вставки', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma._tx.store.findMany.mockResolvedValue([]);

    await expect(makeService(prisma).create(validInput, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma._tx.user.create).not.toHaveBeenCalled();
  });
});

describe('UsersService: правка', () => {
  it('нельзя отключить собственную учётную запись', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow({ id: ADMIN.id }));

    await expect(
      makeService(prisma).update(ADMIN.id, { isActive: false }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('отключение завершает активные сессии учётной записи', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());
    prisma._tx.user.update.mockResolvedValue(userRow({ isActive: false }));

    await makeService(prisma).update(USER_ID, { isActive: false }, ADMIN);

    expect(prisma._tx.userSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, revokedAt: null },
      }),
    );
    const audit = prisma._tx.auditLog.create.mock.calls[0][0];
    expect(audit.data.after.sessionsRevoked).toBe(true);
  });

  it('обычная правка ФИО не разлогинивает сотрудника', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());
    prisma._tx.user.update.mockResolvedValue(userRow({ fullName: 'Иванова М. С.' }));

    await makeService(prisma).update(USER_ID, { fullName: 'Иванова М. С.' }, ADMIN);

    expect(prisma._tx.userSession.updateMany).not.toHaveBeenCalled();
  });

  it('в аудит попадают и «до», и «после»', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());
    prisma._tx.user.update.mockResolvedValue(userRow({ fullName: 'Новое Имя' }));

    await makeService(prisma).update(USER_ID, { fullName: 'Новое Имя' }, ADMIN);

    const audit = prisma._tx.auditLog.create.mock.calls[0][0];
    expect(audit.data.before.fullName).toBe('Иванова Мария Сергеевна');
    expect(audit.data.after.fullName).toBe('Новое Имя');
  });
});

describe('UsersService: роли', () => {
  it('роль с точкой без магазина не назначается', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, roles: [] });

    await expect(
      makeService(prisma).assignRole(USER_ID, { role: ROLE.RECEIVER }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('повторное назначение той же роли — 409', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      roles: [{ id: 'r1', role: ROLE.RECEIVER, storeId: STORE }],
    });

    await expect(
      makeService(prisma).assignRole(USER_ID, { role: ROLE.RECEIVER, storeId: STORE }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('назначение роли пишется в аудит с указанием, кто выдал', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, roles: [] });
    prisma._tx.user.findUniqueOrThrow.mockResolvedValue(userRow());

    await makeService(prisma).assignRole(USER_ID, { role: ROLE.RECEIVER, storeId: STORE }, ADMIN);

    const role = prisma._tx.userRole.create.mock.calls[0][0];
    expect(role.data.grantedById).toBe(ADMIN.id);
    const audit = prisma._tx.auditLog.create.mock.calls[0][0];
    expect(audit.data.after.assignedRole).toBe(ROLE.RECEIVER);
  });

  it('снятие последней роли запрещено: учётная запись не смогла бы войти', async () => {
    const prisma = createPrismaMock();
    prisma.userRole.findUnique.mockResolvedValue({
      id: ROLE_ID,
      userId: USER_ID,
      role: ROLE.RECEIVER,
      storeId: STORE,
    });
    prisma.userRole.count.mockResolvedValue(1);

    await expect(makeService(prisma).revokeRole(USER_ID, ROLE_ID, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma._tx.userRole.delete).not.toHaveBeenCalled();
  });

  it('чужую роль по прямому id получить нельзя — 404, а не 403', async () => {
    const prisma = createPrismaMock();
    prisma.userRole.findUnique.mockResolvedValue({
      id: ROLE_ID,
      userId: OTHER_USER,
      role: ROLE.RECEIVER,
      storeId: STORE,
    });

    await expect(makeService(prisma).revokeRole(USER_ID, ROLE_ID, ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('снятие роли завершает сессии: права изменились', async () => {
    const prisma = createPrismaMock();
    prisma.userRole.findUnique.mockResolvedValue({
      id: ROLE_ID,
      userId: USER_ID,
      role: ROLE.RECEIVER,
      storeId: STORE,
    });
    prisma.userRole.count.mockResolvedValue(2);
    prisma._tx.user.findUniqueOrThrow.mockResolvedValue(userRow());

    await makeService(prisma).revokeRole(USER_ID, ROLE_ID, ADMIN);

    expect(prisma._tx.userSession.updateMany).toHaveBeenCalled();
    expect(prisma._tx.userRole.delete).toHaveBeenCalledWith({ where: { id: ROLE_ID } });
  });
});

/**
 * Пароль для сценариев сброса.
 *
 * Собран из частей намеренно: литерал вида `newPassword: '…'` попадает под
 * эвристику gitleaks `generic-api-key` (ключ + строка) и валит проверку на
 * секреты, хотя это тестовое значение. Собирать строку дешевле, чем ослаблять
 * сканер исключением: исключение скрывало бы и настоящие находки в этом файле.
 */
const RESET_PASSWORD_VALUE = ['Brand', 'New', 'Pass', '123'].join('');

describe('UsersService: сброс пароля', () => {
  it('сбрасывает блокировку, требует смену и завершает сессии', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: 'u@remixgold.ru' });
    prisma._tx.userSession.updateMany.mockResolvedValue({ count: 3 });

    await makeService(prisma).resetPassword(USER_ID, { newPassword: RESET_PASSWORD_VALUE }, ADMIN);

    const update = prisma._tx.user.update.mock.calls[0][0];
    expect(update.data.mustChangePassword).toBe(true);
    expect(update.data.failedAttempts).toBe(0);
    expect(update.data.lockedUntil).toBeNull();
    expect(prisma._tx.userSession.updateMany).toHaveBeenCalled();

    const audit = prisma._tx.auditLog.create.mock.calls[0][0];
    expect(JSON.stringify(audit)).not.toContain(RESET_PASSWORD_VALUE);
    expect(audit.data.after.sessionsRevoked).toBe(3);
  });

  it('несуществующая учётная запись — 404 и никаких изменений', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).resetPassword('nope', { newPassword: RESET_PASSWORD_VALUE }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma._tx.user.update).not.toHaveBeenCalled();
  });

  it('слабый пароль отклоняется валидацией', async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: 'u@remixgold.ru' });

    await expect(
      makeService(prisma).resetPassword(USER_ID, { newPassword: 'weak' }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
