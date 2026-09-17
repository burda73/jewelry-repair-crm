import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { RoleCode, DataScope } from '@app/shared';

/** Пользователь, помещаемый в request после успешной аутентификации. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  roles: RoleCode[];
  /**
   * Основная роль — первая в списке. Вынесена отдельным полем, потому что
   * `roles[0]` при включённом `noUncheckedIndexedAccess` имеет тип
   * `RoleCode | undefined`, и каждое место использования вынуждено было
   * ставить `!` — то есть отключать проверку типов там, где пишутся
   * аудит и история статусов.
   *
   * Инвариант «хотя бы одна роль» обеспечивается при входе (auth.service):
   * учётная запись без ролей не может войти в систему. Без этого инварианта
   * `roles[0]` действительно мог быть `undefined`, и в `AuditLog.actorRole`
   * попадало бы `undefined` вместо роли — след терялся бы.
   */
  primaryRole: RoleCode;
  permissions: string[];
  /** Область видимости — берётся наибольшая из ролей. */
  scope: DataScope;
  /** Магазины пользователя (для scope-фильтра). */
  storeIds: string[];
  /** Роли с привязкой к конкретному магазину. */
  storeRoles: { role: RoleCode; storeId: string | null; scope: DataScope }[];
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

/**
 * Проверка access-токена. По умолчанию защищает все эндпоинты,
 * кроме помеченных @Public().
 *
 * Токен читается ТОЛЬКО из httpOnly-cookie: в localStorage токены не хранятся
 * (docs/10-nfr-security.md §3.1), это защищает от кражи через XSS.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = request.cookies?.access_token as string | undefined;

    if (!token) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Требуется вход в систему',
      });
    }

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email: string;
        fullName: string;
        roles: RoleCode[];
        primaryRole?: RoleCode;
        permissions?: string[];
        scope?: DataScope;
        storeIds?: string[];
        storeRoles?: { role: RoleCode; storeId: string | null; scope: DataScope }[];
      }>(token);

      const roles = payload.roles ?? [];
      // Основная роль: берём из токена, иначе первую из списка. Проверка на
      // `undefined` (а не на длину массива) нужна, чтобы TypeScript сузил тип —
      // по длине он элемент массива не сужает.
      const primaryRole = payload.primaryRole ?? roles[0];

      // Токен без ролей не даёт никаких прав: такой субъект не должен
      // проходить аутентификацию. Без этой проверки `primaryRole` оказался бы
      // `undefined` и в аудит попало бы «неизвестно кто» вместо роли.
      if (primaryRole === undefined) {
        throw new UnauthorizedException({
          code: 'UNAUTHENTICATED',
          message: 'Учётная запись не имеет назначенных ролей',
        });
      }

      request.user = {
        id: payload.sub,
        email: payload.email,
        fullName: payload.fullName,
        roles,
        primaryRole,
        permissions: payload.permissions ?? [],
        scope: payload.scope ?? 'STORE',
        storeIds: payload.storeIds ?? [],
        storeRoles: payload.storeRoles ?? [],
      };

      return true;
    } catch (error) {
      // Уже оформленный отказ (например, отсутствие ролей) пробрасываем как есть,
      // иначе он превратился бы в «сессия истекла» и скрыл настоящую причину.
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Сессия истекла, войдите заново',
      });
    }
  }
}