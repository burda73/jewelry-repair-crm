import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import {
  permissionsFor,
  loginSchema,
  changePasswordSchema,
  DATA_SCOPE,
  type RoleCode,
  type DataScope,
} from '@app/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Пара токенов, выдаваемых при входе и при обновлении сессии.
 *
 * Значения — уже подписанные JWT; наружу они уходят только в httpOnly-cookie
 * (`auth.controller.ts`), в теле ответа их нет.
 */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Результат успешного входа или обновления сессии.
 *
 * `user` — безопасное представление пользователя (без `passwordHash`),
 * собранное `buildAuthenticatedUser`.
 */
export interface AuthResult extends IssuedTokens {
  user: AuthenticatedUser;
}

/** Параметры Argon2id — соответствуют docs/10-nfr-security.md §3.1. */
const ARGON2_OPTIONS = {
  type: 2, // argon2id
  memoryCost: 65_536, // 64 МБ
  timeCost: 3,
  parallelism: 4,
} as const;

/** Порядок областей видимости «от широкой к узкой» — для выбора наибольшей. */
const SCOPE_PRIORITY: DataScope[] = [
  DATA_SCOPE.READ_ALL,
  DATA_SCOPE.ALL_STORES,
  DATA_SCOPE.PRODUCTION,
  DATA_SCOPE.STORE_PLUS_GLOBAL_SEARCH,
  DATA_SCOPE.STORE,
];

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Вход в систему.
   *
   * Защита от брутфорса: после N неудачных попыток учётная запись блокируется
   * (docs/10-nfr-security.md §3.3). Сообщение об ошибке не различает
   * «нет такого пользователя» и «неверный пароль» — чтобы не раскрывать
   * существование учётных записей.
   */
  async login(input: unknown, meta: { ip?: string; userAgent?: string }): Promise<AuthResult> {
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { email, password } = parsed.data;

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        roles: true,
        stores: true,
      },
    });

    const genericFailure = new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Неверный email или пароль',
    });

    if (!user || !user.isActive) {
      // Выполняем фиктивную проверку хеша, чтобы время ответа не раскрывало
      // существование пользователя (защита от user enumeration по таймингу).
      await verify(
        '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000',
        password,
      ).catch(() => false);
      throw genericFailure;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new UnauthorizedException({
        code: 'ACCOUNT_LOCKED',
        message: `Учётная запись временно заблокирована. Повторите через ${minutesLeft} мин.`,
      });
    }

    const passwordValid = await verify(user.passwordHash, password).catch(() => false);

    if (!passwordValid) {
      const maxAttempts = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? 5);
      const lockMinutes = Number(process.env.AUTH_LOCK_MINUTES ?? 15);
      const attempts = user.failedAttempts + 1;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: attempts,
          lockedUntil: attempts >= maxAttempts ? new Date(Date.now() + lockMinutes * 60_000) : null,
        },
      });

      this.logger.warn(`Неудачная попытка входа: ${email} (попытка ${attempts})`);
      throw genericFailure;
    }

    // Успешный вход: сбрасываем счётчик неудач.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const authenticated = this.buildAuthenticatedUser(user);
    const tokens = await this.issueTokens(authenticated, meta);

    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'LOGIN',
        entity: 'User',
        entityId: user.id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    return { user: authenticated, ...tokens };
  }

  /** Выдать access- и refresh-токены. Refresh хранится хешированным (ротация). */
  private async issueTokens(
    user: AuthenticatedUser,
    meta: { ip?: string; userAgent?: string },
  ): Promise<IssuedTokens> {
    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        fullName: user.fullName,
        roles: user.roles,
        primaryRole: user.primaryRole,
        permissions: user.permissions,
        scope: user.scope,
        storeIds: user.storeIds,
        storeRoles: user.storeRoles,
        // Флаг «сменить пароль при входе». В токене он безвреден: смена пароля
        // завершает все сессии и гасит cookie, поэтому устаревшее значение
        // живёт не дольше access-токена.
        mustChangePassword: user.mustChangePassword,
      },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: process.env.JWT_ACCESS_TTL ?? '15m' },
    );

    // Refresh-токен — случайная строка, в БД лежит только её хеш.
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');

    const refreshTtlDays = this.parseTtlDays(process.env.JWT_REFRESH_TTL ?? '30d');

    await this.prisma.userSession.create({
      data: {
        userId: user.id,
        refreshHash,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        expiresAt: new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken, refreshToken };
  }

  /**
   * Обновление access-токена с ротацией refresh.
   * Повторное использование старого refresh-токена → отзыв всей цепочки сессий
   * (защита от кражи токена, docs/10-nfr-security.md §3.1).
   */
  async refresh(
    refreshToken: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthResult> {
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');

    const session = await this.prisma.userSession.findUnique({
      where: { refreshHash },
      include: { user: { include: { roles: true, stores: true } } },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      if (session) {
        // Токен уже использован или отозван — это признак компрометации.
        await this.prisma.userSession.updateMany({
          where: { userId: session.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.logger.error(`Обнаружено повторное использование refresh-токена: ${session.userId}`);
      }
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Сессия истекла, войдите заново',
      });
    }

    // Ротация: старый токен немедленно гасится.
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    if (!session.user.isActive) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Учётная запись отключена',
      });
    }

    const authenticated = this.buildAuthenticatedUser(session.user);
    const tokens = await this.issueTokens(authenticated, meta);
    // Возвращаем и пользователя: контроллер отдаёт его в теле ответа,
    // а токены уходят только в httpOnly-cookie.
    return { user: authenticated, ...tokens };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    await this.prisma.userSession.updateMany({
      where: { refreshHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(userId: string, input: unknown): Promise<void> {
    const parsed = changePasswordSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const currentValid = await verify(user.passwordHash, parsed.data.currentPassword).catch(
      () => false,
    );

    if (!currentValid) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Текущий пароль указан неверно',
      });
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hash(parsed.data.newPassword, ARGON2_OPTIONS),
        mustChangePassword: false,
      },
    });

    // Смена пароля завершает все прочие сессии.
    await this.logoutAll(userId);

    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'UPDATE',
        entity: 'User',
        entityId: userId,
        after: { passwordChanged: true },
        reason: 'Смена пароля пользователем',
      },
    });
  }

  /** Собрать объект пользователя с ролями, правами и областью видимости. */
  private buildAuthenticatedUser(user: {
    id: string;
    email: string;
    fullName: string;
    roles: { role: RoleCode; storeId: string | null; scope: DataScope }[];
    stores: { storeId: string }[];
    mustChangePassword?: boolean;
  }): AuthenticatedUser {
    const roles = [...new Set(user.roles.map((r) => r.role))];
    const primaryRole = roles[0];

    // Учётная запись без ролей не имеет ни одного права, но раньше могла войти
    // в систему: `roles[0]` оказывался `undefined` и попадал в AuditLog.actorRole
    // и OrderStatusHistory, то есть запись об изменении теряла автора.
    // Отказываем на входе — единственное место, где инвариант можно
    // гарантировать для всех последующих запросов.
    //
    // Проверка идёт через `primaryRole === undefined`, а не через
    // `roles.length === 0`: TypeScript не сужает тип элемента массива по длине,
    // и при втором варианте `primaryRole` остался бы `RoleCode | undefined`.
    if (primaryRole === undefined) {
      throw new UnauthorizedException({
        code: 'NO_ROLES_ASSIGNED',
        message: 'Учётной записи не назначено ни одной роли. Обратитесь к администратору.',
      });
    }

    // Берём самую широкую область видимости среди всех ролей пользователя.
    let scope: DataScope = DATA_SCOPE.STORE;
    let bestPriority = SCOPE_PRIORITY.length;
    for (const role of user.roles) {
      const priority = SCOPE_PRIORITY.indexOf(role.scope);
      if (priority >= 0 && priority < bestPriority) {
        bestPriority = priority;
        scope = role.scope;
      }
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles,
      primaryRole,
      permissions: [...permissionsFor(roles)],
      scope,
      storeIds: user.stores.map((s) => s.storeId),
      storeRoles: user.roles.map((r) => ({ role: r.role, storeId: r.storeId, scope: r.scope })),
      // Флаг обязательной смены пароля. По умолчанию `false`, чтобы вызовы,
      // где поле не запрашивалось, не заставляли менять пароль на ровном месте.
      mustChangePassword: user.mustChangePassword ?? false,
    };
  }

  private parseTtlDays(ttl: string): number {
    const match = /^(\d+)([dhms])$/.exec(ttl);
    if (!match) return 30;
    const value = Number(match[1]);
    const unit = match[2];
    switch (unit) {
      case 'd':
        return value;
      case 'h':
        return value / 24;
      case 'm':
        return value / 1440;
      default:
        return value / 86_400;
    }
  }
}
