/**
 * Разделение обязанностей при утверждении прейскуранта (задача 1.4.3).
 *
 * ЗАЧЕМ ЭТО ПРОВЕРЯЕТСЯ. `RolesGuard` пропускал администратора через любую
 * проверку прав безусловно, и пропуск стоял РАНЬШЕ проверки прав. Поэтому
 * прочерк «Прейскурант: утверждение» в матрице прав (`docs/02-domain-and-roles.md`
 * §4) для администратора не действовал: администратор правил цены и он же их
 * утверждал. Контрольная функция, которую выполняет тот же человек, что и
 * контролируемое действие, контролем не является — а расхождение между
 * документацией и поведением не было видно ни в одном тесте.
 *
 * Проверяется и обратное: для обычных проверок безусловный доступ
 * администратора СОХРАНЁН. Иначе, закрыв утверждение прейскуранта, можно было бы
 * случайно отобрать у администратора возможность настраивать систему — и
 * починить её стало бы некому.
 */

import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { CustomDecorator } from '@nestjs/common';
import { RolesGuard } from './roles.guard';
import { RequirePermission, RequireStrictPermission, Roles } from './roles.decorator';
import { PERMISSION, ROLE, DATA_SCOPE } from '@app/shared';
import type { AuthenticatedUser, RequestWithUser } from './jwt-auth.guard';

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'cmu5p70yu0000am7pzqlcawsv',
    email: 'admin@remixgold.ru',
    fullName: 'Администратор Системы',
    roles: [ROLE.ADMIN],
    primaryRole: ROLE.ADMIN,
    permissions: Object.values(PERMISSION),
    scope: DATA_SCOPE.ALL_STORES,
    scopes: [DATA_SCOPE.ALL_STORES],
    storeIds: [],
    ...overrides,
  };
}

/**
 * Контекст с обработчиком, размеченным декоратором.
 *
 * Декоратор применяется к настоящей функции, а `Reflector` читает метаданные
 * из неё же, — поэтому проверяется РЕАЛЬНЫЙ путь чтения, а не подставленные
 * значения. Подставь мы метаданные руками, тест прошёл бы и при неверно
 * объявленном декораторе.
 */
function contextFor(
  decorate: (fn: () => void) => void,
  current: AuthenticatedUser,
): ExecutionContext {
  const handler = (): void => {};
  decorate(handler);

  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: <T>(): T => ({ user: current }) as T,
    }),
  } as unknown as ExecutionContext;
}

function guard(): RolesGuard {
  return new RolesGuard(new Reflector());
}

describe('RolesGuard: обычные проверки прав', () => {
  it('администратор проходит безусловно', () => {
    // Это поведение по умолчанию и оно должно сохраниться: администратор —
    // техническая роль, без неё систему не настроить и не починить.
    const context = contextFor(
      (fn) =>
        RequirePermission(PERMISSION.SETTINGS_MANAGE)(fn, undefined as never, undefined as never),
      user(),
    );

    expect(guard().canActivate(context)).toBe(true);
  });

  it('роль без права получает отказ', () => {
    const context = contextFor(
      (fn) =>
        RequirePermission(PERMISSION.SETTINGS_MANAGE)(fn, undefined as never, undefined as never),
      user({
        roles: [ROLE.RECEIVER],
        primaryRole: ROLE.RECEIVER,
        permissions: [PERMISSION.ORDER_READ],
      }),
    );

    expect(() => guard().canActivate(context)).toThrow(ForbiddenException);
  });
});

describe('RolesGuard: строгая проверка (разделение обязанностей)', () => {
  it('АДМИНИСТРАТОР НЕ проходит строгую проверку права', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА. Администратор правит прейскурант, поэтому утверждать его
     * не должен: иначе подпись под ценами формальна. По матрице прав у него нет
     * `pricelist:approve` — значит, доступ обязан быть закрыт, несмотря на роль.
     */
    const context = contextFor(
      (fn) =>
        RequireStrictPermission(PERMISSION.PRICELIST_APPROVE)(
          fn,
          undefined as never,
          undefined as never,
        ),
      user(),
    );

    expect(() => guard().canActivate(context)).toThrow(ForbiddenException);
  });

  it('руководитель проходит строгую проверку', () => {
    // Право есть по матрице — значит, и доступ есть.
    const context = contextFor(
      (fn) =>
        RequireStrictPermission(PERMISSION.PRICELIST_APPROVE)(
          fn,
          undefined as never,
          undefined as never,
        ),
      user({
        roles: [ROLE.MANAGER],
        primaryRole: ROLE.MANAGER,
        permissions: [PERMISSION.PRICELIST_APPROVE],
      }),
    );

    expect(guard().canActivate(context)).toBe(true);
  });

  it('главный бухгалтер проходит строгую проверку', () => {
    // Ответ A2: достаточно ОДНОЙ подписи руководителя ИЛИ главбуха.
    const context = contextFor(
      (fn) =>
        RequireStrictPermission(PERMISSION.PRICELIST_APPROVE)(
          fn,
          undefined as never,
          undefined as never,
        ),
      user({
        roles: [ROLE.CHIEF_ACCOUNTANT],
        primaryRole: ROLE.CHIEF_ACCOUNTANT,
        permissions: [PERMISSION.PRICELIST_APPROVE],
      }),
    );

    expect(guard().canActivate(context)).toBe(true);
  });

  it('строгая проверка требует именно указанное право', () => {
    /*
     * Руководитель проходит `pricelist:approve`, но не строгую проверку чужого
     * права: декоратор не должен превращаться в «пропустить всех, кроме
     * администратора».
     */
    const context = contextFor(
      (fn) =>
        RequireStrictPermission(PERMISSION.USER_MANAGE)(fn, undefined as never, undefined as never),
      user({
        roles: [ROLE.MANAGER],
        primaryRole: ROLE.MANAGER,
        permissions: [PERMISSION.PRICELIST_APPROVE],
      }),
    );

    expect(() => guard().canActivate(context)).toThrow(ForbiddenException);
  });

  it('строгая проверка не отменяет проверку ролей', () => {
    // Если бы строгость влияла только на права, декоратор `Roles` рядом с ней
    // перестал бы работать — а вместе они и образуют правило.
    const context = contextFor(
      (fn) => {
        Roles(ROLE.MANAGER)(fn, undefined as never, undefined as never);
        RequireStrictPermission(PERMISSION.PRICELIST_APPROVE)(
          fn,
          undefined as never,
          undefined as never,
        );
      },
      user({
        roles: [ROLE.CHIEF_ACCOUNTANT],
        primaryRole: ROLE.CHIEF_ACCOUNTANT,
        permissions: [PERMISSION.PRICELIST_APPROVE],
      }),
    );

    expect(() => guard().canActivate(context)).toThrow(ForbiddenException);
  });

  it('неаутентифицированный запрос получает отказ', () => {
    const handler = (): void => {};
    RequireStrictPermission(PERMISSION.PRICELIST_APPROVE)(
      handler,
      undefined as never,
      undefined as never,
    );
    const context = {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: <T>(): T => ({ user: undefined }) as T,
      }),
    } as unknown as ExecutionContext;

    expect(() => guard().canActivate(context)).toThrow(ForbiddenException);
  });
});
