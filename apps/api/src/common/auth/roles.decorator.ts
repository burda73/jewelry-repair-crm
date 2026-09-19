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
 * (или хотя бы одно из прав). Администратор имеет все права — см.
 * `RequireStrictPermission` для исключений.
 */
export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';

export const RequirePermission = (...permissions: Permission[]): CustomDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Отключить безусловный доступ администратора к этому эндпоинту.
 *
 * ЗАЧЕМ. `RolesGuard` пропускает `ADMIN` через любую проверку прав: это удобно и
 * по умолчанию верно, потому что администратор — техническая роль, которая
 * настраивает систему. Но для КОНТРОЛЬНОЙ функции такое правило стирает сам
 * контроль.
 *
 * Конкретный случай — утверждение прейскуранта (задача 1.4.3). По матрице прав
 * (`docs/02-domain-and-roles.md` §4) утверждают руководитель и главный бухгалтер,
 * а у администратора право `pricelist:approve` помечено прочерком. Причина
 * прямая: администратор правит цены, и если он же их утверждает, подпись под
 * ценами становится формальностью — один человек и назначает цену, и согласует её.
 *
 * До этого флага правило матрицы не действовало: администратор утверждал
 * прейскурант, потому что `RolesGuard` пропускал его раньше, чем проверялись
 * права. То есть документация и поведение расходились, причём в сторону потери
 * контроля, — а расхождение не было видно ни в тестах, ни в интерфейсе.
 */
export const STRICT_PERMISSION_KEY = 'strictPermission';

export const Roles = (...roles: RoleCode[]): CustomDecorator => SetMetadata(ROLES_KEY, roles);

/**
 * Требовать право, не пропуская администратора «по должности».
 *
 * Используется только там, где право существует ради разделения обязанностей —
 * на утверждении и отклонении прейскуранта. Для остальных проверок остаётся
 * обычный `RequirePermission`: администратор должен сохранять доступ к
 * настройке системы, иначе никто не сможет её починить.
 */
export const RequireStrictPermission = (
  ...permissions: Permission[]
): MethodDecorator & ClassDecorator => {
  /*
   * Два `SetMetadata` подряд в одном декораторе: первый задаёт требуемое право,
   * второй — запрет на обход администратором. Именно так, а не двумя отдельными
   * декораторами, чтобы их нельзя было применить по одному: право без запрета
   * обхода вернуло бы дефект, ради которого это и заведено.
   */
  const withPermission = SetMetadata(PERMISSIONS_KEY, permissions);
  const strict = SetMetadata(STRICT_PERMISSION_KEY, true);
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor): void => {
    withPermission(target, key as string, descriptor as PropertyDescriptor);
    strict(target, key as string, descriptor as PropertyDescriptor);
  };
};
