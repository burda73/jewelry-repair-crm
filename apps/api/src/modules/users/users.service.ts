import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import {
  createUserSchema,
  updateUserSchema,
  assignRoleSchema,
  resetUserPasswordSchema,
  ROLE,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  DATA_SCOPE,
  DEFAULT_ROLE_SCOPE,
  type RoleCode,
  type DataScope,
} from '@app/shared';
import { hash } from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Prisma } from '@prisma/client';

/**
 * Управление учётными записями и ролями (задача 1.2.4, docs/07-api-spec.md §13).
 *
 * Доступ ограничен правом `user:manage`, которое есть только у ADMIN.
 *
 * Пароли не отдаются наружу никогда: ни в списке, ни в карточке, ни в аудите.
 * Хранится только хеш Argon2id, и в ответах API поля `passwordHash` нет вовсе —
 * оно просто не выбирается из базы.
 *
 * Параметры хеширования обязаны совпадать с `ARGON2_OPTIONS` в
 * `auth.service.ts`: иначе новый пароль формально останется проверяемым
 * (Argon2 хранит параметры внутри строки хеша), но окажется слабее принятой в
 * проекте нормы, и это расхождение никак не проявилось бы снаружи.
 */
const ARGON2_OPTIONS = {
  type: 2, // argon2id
  memoryCost: 65_536, // 64 МБ
  timeCost: 3,
  parallelism: 4,
} as const;

/**
 * Поля учётной записи, которые отдаются наружу.
 *
 * `passwordHash` здесь отсутствует намеренно: если бы он выбирался, а потом
 * «не попадал в ответ», достаточно было бы одного забытого преобразования,
 * чтобы хеши утекли в интерфейс. Отсутствие поля в запросе делает такую утечку
 * невозможной по построению (тот же приём — в `customers.service.ts`).
 */
const USER_BASE_SELECT = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  email: true,
  phone: true,
  fullName: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  lockedUntil: true,
  failedAttempts: true,
  createdAt: true,
  updatedAt: true,
  roles: {
    select: {
      id: true,
      role: true,
      storeId: true,
      scope: true,
      grantedAt: true,
      grantedById: true,
      store: { select: { id: true, code: true, name: true } },
    },
    orderBy: { grantedAt: 'asc' },
  },
  stores: {
    select: {
      storeId: true,
      isDefault: true,
      store: { select: { id: true, code: true, name: true } },
    },
  },
  _count: { select: { sessions: { where: { revokedAt: null } } } },
});

const USER_DETAIL_SELECT = Prisma.validator<Prisma.UserSelect>()({
  ...USER_BASE_SELECT,
});

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_BASE_SELECT }>;
type UserDetailRow = Prisma.UserGetPayload<{ select: typeof USER_DETAIL_SELECT }>;

/** Учётная запись в списке. */
export interface UserListItem {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  roles: {
    id: string;
    role: RoleCode;
    roleLabel: string;
    storeId: string | null;
    storeName: string | null;
    scope: DataScope;
    scopeLabel: string;
  }[];
  stores: { id: string; code: string; name: string; isDefault: boolean }[];
  activeSessions: number;
}

/** Карточка учётной записи с посчитанными правами. */
export interface UserDetail extends UserListItem {
  /** Права, которые даёт совокупность ролей — то же, что отдаёт `GET /auth/me`. */
  permissions: string[];
}

/** Справочная информация для интерфейса управления ролями. */
export interface RolesCatalog {
  roles: { code: RoleCode; label: string; permissions: string[] }[];
  scopes: { code: DataScope; label: string }[];
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Список учётных записей с фильтрами и поиском. */
  async findAll(params: { q?: string; isActive?: string; role?: string }): Promise<UserListItem[]> {
    const where: Prisma.UserWhereInput = {};

    if (params.q?.trim()) {
      const q = params.q.trim();
      // Поиск по ФИО, почте и телефону. `mode: 'insensitive'` — чтобы «иванов»
      // находил «Иванов»: администратор вводит фамилию как привык.
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ];
    }

    if (params.isActive === 'true') where.isActive = true;
    if (params.isActive === 'false') where.isActive = false;

    if (params.role) {
      if (!isRoleCode(params.role)) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `Неизвестная роль: ${params.role}`,
        });
      }
      where.roles = { some: { role: params.role } };
    }

    const users = await this.prisma.user.findMany({
      where,
      select: USER_BASE_SELECT,
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
    });

    return users.map((user) => this.toListItem(user));
  }

  /** Карточка учётной записи. */
  async findOne(id: string): Promise<UserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: USER_DETAIL_SELECT });
    if (!user)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Учётная запись не найдена' });
    return this.toDetail(user);
  }

  /**
   * Создание учётной записи.
   *
   * Пароль задаёт администратор, поэтому `mustChangePassword` включается всегда:
   * владелец учётной записи обязан при первом входе задать свой пароль, и
   * администратор не сохраняет знание о боевом пароле сотрудника.
   */
  async create(input: unknown, actor: AuthenticatedUser): Promise<UserDetail> {
    const parsed = createUserSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.flatten().fieldErrors);
    const data = parsed.data;

    const email = data.email.trim().toLowerCase();

    // Проверяем заранее, чтобы вернуть понятную ошибку вместо P2002 от базы.
    // Гонка между проверкой и вставкой теоретически возможна, поэтому ниже
    // обрабатывается и конфликт уникальности от самой базы.
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'Учётная запись с такой электронной почтой уже существует',
      });
    }

    const passwordHash = await hash(data.password, ARGON2_OPTIONS);
    const storeIds = data.storeIds.filter((id, index) => data.storeIds.indexOf(id) === index);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.assertStoresExist(tx, [
          ...storeIds,
          ...data.roles.map((r) => r.storeId).filter((id): id is string => Boolean(id)),
        ]);

        const user = await tx.user.create({
          data: {
            email,
            fullName: data.fullName.trim(),
            phone: data.phone ?? null,
            passwordHash,
            isActive: true,
            mustChangePassword: true,
            stores: {
              create: storeIds.map((storeId, index) => ({ storeId, isDefault: index === 0 })),
            },
            roles: {
              create: data.roles.map((role) => ({
                role: role.role as RoleCode,
                storeId: role.storeId ?? null,
                scope:
                  (role.scope as DataScope | undefined) ??
                  DEFAULT_ROLE_SCOPE[role.role as RoleCode],
                grantedById: actor.id,
              })),
            },
          },
          select: USER_DETAIL_SELECT,
        });

        // Аудит (ТЗ п. 4). Пароль и его хеш в запись не попадают ни в каком
        // виде: журнал читают в том числе аудиторы, и он не должен становиться
        // хранилищем учётных данных.
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.primaryRole,
            action: 'CREATE',
            entity: 'User',
            entityId: user.id,
            after: {
              email: user.email,
              fullName: user.fullName,
              isActive: user.isActive,
              roles: user.roles.map((r) => ({ role: r.role, storeId: r.storeId, scope: r.scope })),
            },
            reason: 'Создание учётной записи администратором',
          },
        });

        return user;
      });

      // В лог приложения — только идентификатор: почта и ФИО это PII
      // (docs/10-nfr-security.md §7).
      this.logger.log(`Учётная запись создана: ${created.id}`);
      return this.toDetail(created);
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  /**
   * Правка учётной записи.
   *
   * Пароль здесь не меняется — для этого отдельный сценарий сброса. Иначе
   * исправление опечатки в ФИО завершало бы все сессии сотрудника.
   */
  async update(id: string, input: unknown, actor: AuthenticatedUser): Promise<UserDetail> {
    const parsed = updateUserSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.flatten().fieldErrors);
    const data = parsed.data;

    const current = await this.prisma.user.findUnique({ where: { id }, select: USER_BASE_SELECT });
    if (!current) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Учётная запись не найдена' });
    }

    // Отключение самого себя лишило бы систему администратора: текущая сессия
    // продолжила бы работать до истечения токена, но войти заново было бы
    // нельзя. Это не техническая защита, а предотвращение понятной ошибки.
    if (id === actor.id && data.isActive === false) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Нельзя отключить собственную учётную запись',
      });
    }

    const email = data.email?.trim().toLowerCase();

    if (email && email !== current.email) {
      const taken = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (taken) {
        throw new ConflictException({
          code: 'EMAIL_TAKEN',
          message: 'Учётная запись с такой электронной почтой уже существует',
        });
      }
    }

    // Отключение учётной записи обязано завершать её сессии: иначе отключённый
    // сотрудник продолжал бы работать в уже открытой вкладке до 30 дней.
    const revokeSessions = data.isActive === false;

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (data.storeIds) {
          await this.assertStoresExist(tx, data.storeIds);
        }

        const user = await tx.user.update({
          where: { id },
          data: {
            ...(email !== undefined ? { email } : {}),
            ...(data.fullName !== undefined ? { fullName: data.fullName.trim() } : {}),
            // Пустая строка означает «удалить телефон», поэтому в базу пишется
            // `null`, а не пустая строка: иначе в интерфейсе и в поиске по
            // телефону появилось бы значение, которого нет ни у одного клиента.
            ...(data.phone !== undefined ? { phone: normalizePhoneOrNull(data.phone) } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            ...(data.storeIds !== undefined
              ? {
                  stores: {
                    deleteMany: {},
                    create: data.storeIds
                      .filter((sid: string, index: number) => data.storeIds!.indexOf(sid) === index)
                      .map((storeId: string, index: number) => ({
                        storeId,
                        isDefault: index === 0,
                      })),
                  },
                }
              : {}),
          },
          select: USER_DETAIL_SELECT,
        });

        if (revokeSessions) {
          await tx.userSession.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }

        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.primaryRole,
            action: 'UPDATE',
            entity: 'User',
            entityId: id,
            // «До» и «после» — иначе по журналу нельзя доказать, какой была
            // учётная запись до правки.
            before: {
              email: current.email,
              fullName: current.fullName,
              phone: current.phone,
              isActive: current.isActive,
              storeIds: current.stores.map((s) => s.storeId),
            },
            after: {
              email: user.email,
              fullName: user.fullName,
              phone: user.phone,
              isActive: user.isActive,
              storeIds: user.stores.map((s) => s.storeId),
              ...(revokeSessions ? { sessionsRevoked: true } : {}),
            },
            reason: revokeSessions
              ? 'Правка учётной записи; учётная запись отключена, сессии завершены'
              : 'Правка учётной записи администратором',
          },
        });

        return user;
      });

      this.logger.log(`Учётная запись изменена: ${id}`);
      return this.toDetail(updated);
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  /** Справочник ролей и областей видимости для интерфейса. */
  getRolesCatalog(): RolesCatalog {
    return {
      roles: Object.values(ROLE).map((code) => ({
        code,
        label: ROLE_LABELS[code],
        permissions: [...ROLE_PERMISSIONS[code]],
      })),
      scopes: Object.values(DATA_SCOPE).map((code) => ({ code, label: scopeLabel(code) })),
    };
  }

  /** Назначить роль. */
  async assignRole(userId: string, input: unknown, actor: AuthenticatedUser): Promise<UserDetail> {
    const parsed = assignRoleSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.flatten().fieldErrors);
    const data = parsed.data;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, roles: { select: { id: true, role: true, storeId: true } } },
    });
    if (!user) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Учётная запись не найдена' });
    }

    const role = data.role as RoleCode;
    const storeId = data.storeId ?? null;

    // Уникальность роли — (userId, role, storeId). Проверяем заранее, чтобы
    // вернуть понятную ошибку, а не P2002.
    const duplicate = user.roles.some((r) => r.role === role && r.storeId === storeId);
    if (duplicate) {
      throw new ConflictException({
        code: 'ROLE_ALREADY_ASSIGNED',
        message: 'Такая роль уже назначена',
      });
    }

    // Роль, ограниченная точкой, без точки бессмысленна: фильтр области
    // видимости построить не из чего, и сотрудник не увидит ни одного заказа.
    if (roleNeedsStore(role) && !storeId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Для роли «${ROLE_LABELS[role]}» нужно указать магазин`,
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (storeId) await this.assertStoresExist(tx, [storeId]);

      await tx.userRole.create({
        data: {
          userId,
          role,
          storeId,
          scope: (data.scope as DataScope | undefined) ?? DEFAULT_ROLE_SCOPE[role],
          grantedById: actor.id,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'UPDATE',
          entity: 'User',
          entityId: userId,
          after: { assignedRole: role, storeId },
          reason: 'Назначение роли администратором',
        },
      });

      return tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_DETAIL_SELECT });
    });

    this.logger.log(`Роль ${role} назначена учётной записи ${userId}`);
    return this.toDetail(updated);
  }

  /**
   * Снять роль.
   *
   * `roleId` — идентификатор записи `user_role`, а не код роли: у одной роли
   * может быть несколько назначений (по магазинам), и снимать нужно конкретное.
   */
  async revokeRole(userId: string, roleId: string, actor: AuthenticatedUser): Promise<UserDetail> {
    const roleRow = await this.prisma.userRole.findUnique({
      where: { id: roleId },
      select: { id: true, userId: true, role: true, storeId: true },
    });

    // Роль другого пользователя по прямому id — тоже 404, а не 403: иначе по
    // коду ответа можно было бы узнать, какие роли существуют у чужой записи.
    if (!roleRow || roleRow.userId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Роль не найдена' });
    }

    // Учётная запись без ролей не может войти в систему. Снятие последней роли
    // фактически блокирует сотрудника, поэтому делаем это явно: администратор
    // должен отключить учётную запись (`isActive: false`), а не оставить её в
    // состоянии «вход невозможен, но выглядит рабочей».
    const roleCount = await this.prisma.userRole.count({ where: { userId } });
    if (roleCount <= 1) {
      throw new BadRequestException({
        code: 'LAST_ROLE',
        message:
          'Нельзя снять последнюю роль: учётная запись без ролей не сможет войти. ' +
          'Отключите учётную запись вместо этого.',
      });
    }

    // Снятие роли у самого себя разжалует администратора и может лишить его
    // права `user:manage` — вернуть роль будет уже некому.
    if (userId === actor.id && roleRow.role === actor.primaryRole) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Нельзя снять собственную основную роль',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.userRole.delete({ where: { id: roleId } });

      // Снятие роли меняет права, поэтому активные сессии завершаются: иначе
      // сотрудник продолжал бы работать с прежними правами до истечения токена.
      await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'UPDATE',
          entity: 'User',
          entityId: userId,
          before: { role: roleRow.role, storeId: roleRow.storeId },
          after: { revokedRole: roleRow.role },
          reason: 'Снятие роли администратором; сессии завершены',
        },
      });

      return tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_DETAIL_SELECT });
    });

    this.logger.log(`Роль ${roleRow.role} снята с учётной записи ${userId}`);
    return this.toDetail(updated);
  }

  /**
   * Сброс пароля администратором.
   *
   * Администратор задаёт новый пароль и обязан передать его сотруднику лично.
   * При первом входе система потребует сменить пароль на свой
   * (`mustChangePassword`), поэтому знание администратора о боевом пароле
   * сотрудника не сохраняется.
   *
   * Все активные сессии завершаются: иначе тот, кто вошёл старым паролем,
   * сохранил бы доступ по refresh-токену, и сброс не закрыл бы ничего.
   */
  async resetPassword(userId: string, input: unknown, actor: AuthenticatedUser): Promise<void> {
    const parsed = resetUserPasswordSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.flatten().fieldErrors);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Учётная запись не найдена' });
    }

    const passwordHash = await hash(parsed.data.newPassword, ARGON2_OPTIONS);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          mustChangePassword: parsed.data.mustChangePassword,
          // Сброс пароля снимает блокировку: она возникла из-за неудачных
          // попыток входа, и после установки нового пароля препятствий нет.
          failedAttempts: 0,
          lockedUntil: null,
        },
      });

      const revoked = await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // Ни пароль, ни его хеш в аудит не попадают.
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.primaryRole,
          action: 'UPDATE',
          entity: 'User',
          entityId: userId,
          after: {
            passwordReset: true,
            mustChangePassword: parsed.data.mustChangePassword,
            sessionsRevoked: revoked.count,
          },
          reason: 'Сброс пароля администратором',
        },
      });
    });

    this.logger.log(`Пароль сброшен администратором для ${userId}`);
  }

  /**
   * Проверить, что все магазины существуют.
   *
   * Без этой проверки неизвестный `storeId` привёл бы к ошибке внешнего ключа
   * Postgres, и администратор увидел бы «Internal server error» вместо
   * указания на неверный магазин.
   */
  private async assertStoresExist(tx: Prisma.TransactionClient, storeIds: string[]): Promise<void> {
    const unique = [...new Set(storeIds)];
    if (unique.length === 0) return;

    const found = await tx.store.findMany({ where: { id: { in: unique } }, select: { id: true } });
    if (found.length !== unique.length) {
      const known = new Set(found.map((s) => s.id));
      const missing = unique.filter((id) => !known.has(id));
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Магазин не найден: ${missing.join(', ')}`,
      });
    }
  }

  private toListItem(user: UserRow): UserListItem {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      fullName: user.fullName,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      lockedUntil: user.lockedUntil,
      createdAt: user.createdAt,
      roles: user.roles.map((role) => ({
        id: role.id,
        role: role.role,
        roleLabel: ROLE_LABELS[role.role],
        storeId: role.storeId,
        storeName: role.store?.name ?? null,
        scope: role.scope,
        scopeLabel: scopeLabel(role.scope),
      })),
      stores: user.stores.map((s) => ({
        id: s.store.id,
        code: s.store.code,
        name: s.store.name,
        isDefault: s.isDefault,
      })),
      activeSessions: user._count.sessions,
    };
  }

  private toDetail(user: UserDetailRow): UserDetail {
    // Права считаются объединением прав всех ролей — ровно так же, как это
    // делает `auth.service.buildAuthenticatedUser` для `GET /auth/me`. Если
    // здесь считать иначе, экран администратора показывал бы не те права,
    // которые сотрудник получит на самом деле.
    const permissions = [
      ...new Set(user.roles.flatMap((role) => [...ROLE_PERMISSIONS[role.role]])),
    ].sort();

    return { ...this.toListItem(user), permissions };
  }
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

function isRoleCode(value: string): value is RoleCode {
  return (Object.values(ROLE) as string[]).includes(value);
}

/**
 * Телефон для записи в базу: пустое значение превращается в `null`.
 *
 * `""` и `null` означают одно и то же — «телефона нет». Разные представления
 * одного состояния заставляли бы каждую проверку на наличие телефона учитывать
 * оба варианта, и рано или поздно один из них был бы забыт.
 */
function normalizePhoneOrNull(phone: string | null): string | null {
  if (phone === null) return null;
  const trimmed = phone.trim();
  return trimmed === '' ? null : trimmed;
}

/** Роли, которым нужен магазин: без него область видимости не построить. */
function roleNeedsStore(role: RoleCode): boolean {
  return role === ROLE.RECEIVER || role === ROLE.CASHIER;
}

/**
 * Читаемое название области видимости.
 *
 * В домене есть только коды (`DATA_SCOPE`): они уходят в API и сравниваются
 * кодом. Расшифровка нужна исключительно интерфейсу, поэтому живёт рядом с ним,
 * а не в доменном пакете, который не должен зависеть от формулировок для экрана.
 */
const SCOPE_LABELS: Record<DataScope, string> = {
  STORE: 'Только свой магазин',
  STORE_PLUS_GLOBAL_SEARCH: 'Свой магазин + поиск по номеру',
  PRODUCTION: 'Производство и логистика',
  ALL_STORES: 'Все магазины сети',
  READ_ALL: 'Полное чтение',
};

function scopeLabel(scope: DataScope): string {
  return SCOPE_LABELS[scope];
}

function validationError(fieldErrors: Record<string, string[] | undefined>): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Проверьте правильность заполнения полей',
    details: fieldErrors,
  });
}

/**
 * Превратить нарушение уникальности от базы в понятную ошибку.
 *
 * Между проверкой «почта свободна» и вставкой есть окно, в котором параллельный
 * запрос может занять ту же почту. Проверка заранее даёт хорошее сообщение в
 * обычном случае, а этот обработчик — в редком.
 */
function translateUniqueViolation(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException({
      code: 'EMAIL_TAKEN',
      message: 'Учётная запись с такой электронной почтой уже существует',
    });
  }
  return error;
}
