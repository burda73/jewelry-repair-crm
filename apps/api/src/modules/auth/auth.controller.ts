import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from '../../common/auth/public.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../common/auth/jwt-auth.guard';

/**
 * Тело ответа на вход и обновление сессии.
 *
 * Токенов здесь нет намеренно: они уходят только в httpOnly-cookie, поэтому
 * JavaScript на странице до них не доберётся (защита от XSS-кражи сессии).
 */
interface SessionResponse {
  user: AuthenticatedUser;
}

/** Настройки cookie для токенов (docs/10-nfr-security.md §3.1). */
const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

const baseCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Сотрудники для выпадающего списка на экране входа.
   *
   * Доступен без аутентификации — иначе список нельзя было бы получить до входа,
   * ради чего он и существует. Отдаются только идентификатор и ФИО активных
   * записей (объяснение выбора полей — в `AuthService.loginOptions`).
   *
   * Свой лимит частоты: 30 запросов за 15 минут с одного адреса. Экран входа
   * запрашивает список один раз при открытии, поэтому обычная работа в него не
   * упирается, а сплошной обход списка сотрудников с одного адреса — упирается.
   */
  @Public()
  @Get('login-options')
  @Throttle({ short: { limit: 30, ttl: 900_000 } })
  @ApiOperation({ summary: 'Сотрудники для выбора на экране входа' })
  async loginOptions(): Promise<{ id: string; fullName: string }[]> {
    return this.authService.loginOptions();
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Жёсткий лимит против брутфорса: 10 попыток за 15 минут с одного IP.
  @Throttle({ short: { limit: 10, ttl: 900_000 } })
  @ApiOperation({ summary: 'Вход в систему' })
  async login(
    @Body() body: unknown,
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const result = await this.authService.login(body, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    // Токены НЕ возвращаются в теле ответа: они уже в httpOnly-cookie.
    return { user: result.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Обновить access-токен (с ротацией refresh)' })
  async refresh(
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const refreshToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!refreshToken) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Сессия истекла, войдите заново',
      });
    }

    const result = await this.authService.refresh(refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { user: result.user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Выход из системы' })
  async logout(
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Завершить все сессии пользователя' })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logoutAll(user.id);
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  @Get('me')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Текущий пользователь: роли, права, магазины' })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    // Фронтенд доверяет этому списку прав и не дублирует матрицу доступа.
    return user;
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Сменить пароль' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.changePassword(user.id, body);
    // Пароль изменён → все сессии завершены, текущие cookie недействительны.
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    res.cookie(ACCESS_COOKIE, accessToken, {
      ...baseCookieOptions,
      maxAge: 15 * 60 * 1000, // 15 минут
    });
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...baseCookieOptions,
      // Refresh ограничен путём обновления токена — меньше поверхность атаки.
      path: '/api/v1/auth',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
    });
  }
}
