import { SetMetadata } from '@nestjs/common';
import type { CustomDecorator } from '@nestjs/common';

/**
 * Пометить эндпоинт как публичный (без аутентификации).
 * По умолчанию JwtAuthGuard защищает ВСЁ — это безопасный дефолт:
 * забыть защитить эндпоинт нельзя, забыть открыть — можно, и это заметно.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);
