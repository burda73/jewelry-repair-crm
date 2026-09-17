import { createParamDecorator, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, RequestWithUser } from './jwt-auth.guard';

/**
 * Получить текущего пользователя в контроллере.
 *
 * Использование:
 *   findAll(@CurrentUser() user: AuthenticatedUser) { ... }
 *   findMine(@CurrentUser('id') userId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      // Не должно происходить: JwtAuthGuard выполняется раньше.
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Требуется вход в систему',
      });
    }

    return field ? user[field] : user;
  },
);