import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, PERMISSIONS_KEY } from './roles.decorator';
import { ROLE, permissionsFor, type RoleCode, type Permission } from '@app/shared';
import type { RequestWithUser } from './jwt-auth.guard';

/**
 * Проверка ролей и прав. Работает после JwtAuthGuard.
 *
 * Матрица прав живёт в packages/shared и используется и здесь, и в веб-интерфейсе,
 * поэтому правила не могут разойтись между фронтендом и бэкендом.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Эндпоинт не ограничен — пропускаем.
    if (!requiredRoles?.length && !requiredPermissions?.length) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_ROLE',
        message: 'Недостаточно прав для этого действия',
      });
    }

    // Администратор имеет полный доступ (каждое действие фиксируется в аудите).
    if (user.roles.includes(ROLE.ADMIN)) return true;

    if (requiredRoles?.length) {
      const hasRole = requiredRoles.some((role) => user.roles.includes(role));
      if (!hasRole) {
        throw new ForbiddenException({
          code: 'FORBIDDEN_ROLE',
          message: 'Недостаточно прав для этого действия',
        });
      }
    }

    if (requiredPermissions?.length) {
      const granted = permissionsFor(user.roles);
      const hasPermission = requiredPermissions.some((permission) => granted.has(permission));
      if (!hasPermission) {
        throw new ForbiddenException({
          code: 'FORBIDDEN_ROLE',
          message: 'Недостаточно прав для этого действия',
        });
      }
    }

    return true;
  }
}
