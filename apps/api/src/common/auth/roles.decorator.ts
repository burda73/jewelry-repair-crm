import { SetMetadata } from '@nestjs/common';
import type { CustomDecorator } from '@nestjs/common';
import type { Permission, RoleCode } from '@app/shared';

/**
 * Ограничить эндпоинт ролями и/или правами.
 *
 * Использование:
 *   @Roles(ROLE.CASHIER)
 *   @RequirePermission(PERMISSION.PAYMENT_CREATE)
 *
 * Пользователь проходит проверку, если у него есть ЛЮБАЯ из указанных ролей
 * (или хотя бы одно из прав). Администратор имеет все права.
 */
export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';

export const Roles = (...roles: RoleCode[]): CustomDecorator => SetMetadata(ROLES_KEY, roles);

export const RequirePermission = (...permissions: Permission[]): CustomDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);