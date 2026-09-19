/**
 * Тесты контракта маршрутов аутентификации.
 *
 * ЗАЧЕМ ЭТО ПРОВЕРЯЕТСЯ. Список сотрудников для экрана входа обязан быть
 * публичным — иначе его нельзя получить до входа, ради чего он и существует. Но
 * «публичный» здесь означает ровно один маршрут: если атрибут `@Public()`
 * потеряется при переименовании или переносе, экран входа перестанет работать и
 * сломается неочевидно. Обратная ошибка — лишний публичный маршрут — хуже:
 * открывает данные без аутентификации. Поэтому проверяются и путь, и метод, и
 * наличие `@Public()`, и его ОТСУТСТВИЕ у соседних маршрутов.
 *
 * Проверяются метаданные декоратора: поднимать HTTP-сервер ради объявленного
 * контракта было бы дороже и не добавило бы уверенности.
 */

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller';
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator';

function handler(method: keyof AuthController): object {
  return AuthController.prototype[method] as unknown as object;
}

function pathOf(method: keyof AuthController): string {
  return Reflect.getMetadata(PATH_METADATA, handler(method)) as string;
}

function isPublic(method: keyof AuthController): boolean {
  return Reflect.getMetadata(IS_PUBLIC_KEY, handler(method)) === true;
}

describe('Маршруты аутентификации', () => {
  it('список сотрудников для входа — публичный GET login-options', () => {
    // Путь и метод — часть контракта с фронтендом: при расхождении экран входа
    // молча покажет пустой список, и сотрудник не сможет войти.
    expect(pathOf('loginOptions')).toBe('login-options');
    expect(Reflect.getMetadata(METHOD_METADATA, handler('loginOptions'))).toBe(RequestMethod.GET);
    expect(isPublic('loginOptions')).toBe(true);
  });

  it('вход и обновление сессии остаются публичными', () => {
    // Эти два маршрута публичны по своей природе: до входа cookie ещё нет.
    expect(isPublic('login')).toBe(true);
    expect(isPublic('refresh')).toBe(true);
  });

  it('профиль и выход НЕ публичны', () => {
    /*
     * Обратная проверка. `@Public()` на `me` открыл бы профиль с ролями и
     * правами без аутентификации, а на `logout` — позволил бы гасить чужие
     * сессии по переданной cookie. Обе ошибки тихие, поэтому проверяются явно.
     */
    expect(isPublic('me')).toBe(false);
    expect(isPublic('logout')).toBe(false);
    expect(isPublic('logoutAll')).toBe(false);
    expect(isPublic('changePassword')).toBe(false);
  });
});
