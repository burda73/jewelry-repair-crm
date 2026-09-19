import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BadRequestException } from '@nestjs/common';

import { PublicStatusService } from './public-status.service';
import type { RequestCodeResult, VerifyCodeResult } from './public-status.service';
import { Public } from '../../common/auth/public.decorator';
import {
  PUBLIC_CODE_DIGITS,
  PUBLIC_CODE_REQUESTS_PER_HOUR,
  PUBLIC_CODE_TTL_MS,
  PUBLIC_CODE_REQUEST_WINDOW_MS,
  publicOrderStatusQuerySchema,
  requestPublicCodeSchema,
} from '@app/shared';

/**
 * Публичная проверка статуса заказа (задача 5.11, docs/05 §5, docs/07 §15).
 *
 * ## Почему маршруты помечены `@Public()`
 *
 * `JwtAuthGuard` защищает ВСЁ по умолчанию — это безопасный дефолт: забыть
 * защитить эндпоинт нельзя, забыть открыть можно, и это заметно. Здесь открытие
 * сделано ЯВНО и двумя отдельными пометками, чтобы по коду было видно: это
 * единственные маршруты системы без входа.
 *
 * ## Почему ответы не различают «нет заказа» и «неверный код»
 *
 * Номера заказов угадываемы (формат содержит код магазина, месяц и
 * последовательный номер). Если бы ответ различал «такого заказа нет» и «код не
 * подошёл», перебор номеров дал бы список существующих заказов — утечка сама по
 * себе, без всякого показа статуса. Поэтому наружу уходит только `ok`, а причина
 * остаётся во внутреннем журнале.
 *
 * ## Почему ограничение частоты стоит и здесь, и в сервисе
 *
 * `@Throttle` считает по IP и защищает от грубого перебора. Ограничение по
 * ТЕЛЕФОНУ живёт в сервисе: оно защищает деньги (каждое SMS платное), а по IP
 * такой сценарий не ловится — «выкачивают» сообщения с множества адресов на один
 * номер. Два разных ограничения для двух разных угроз.
 */
@ApiTags('public')
@Controller('public/order-status')
export class PublicStatusController {
  constructor(private readonly publicStatus: PublicStatusService) {}

  /**
   * Запросить код подтверждения.
   *
   * ОГРАНИЧЕНИЕ ПО АДРЕСУ ДОЛЖНО БЫТЬ БОЛЬШЕ ЛИМИТА ПО ТЕЛЕФОНУ.
   *
   * Здесь стояло 5 запросов в час на адрес — при лимите `3` на телефон. Это
   * оказалось ошибкой, найденной на живой проверке: на четвёртом запросе клиент
   * получал `429` вместо того, чтобы упереться в ограничение по телефону. Хуже
   * того, `429` РАЗЛИЧАЕТ случаи: по нему видно, что клиент уже запрашивал коды,
   * тогда как смысл ограничения — отвечать одинаково всем.
   *
   * Почему запас нужен: за одним адресом (магазин, офис, мобильный оператор с
   * общим NAT) сидит несколько клиентов, и общий счётчик не должен наказывать их
   * за чужие запросы. Двадцать запросов в час на адрес при трёх на телефон —
   * расходы по-прежнему ограничены телефоном, а честные клиенты не страдают.
   */
  @Public()
  @Post('request-code')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 20, ttl: PUBLIC_CODE_REQUEST_WINDOW_MS } })
  @ApiOperation({ summary: 'Запросить код проверки статуса заказа' })
  async requestCode(@Body() body: unknown, @Ip() ip: string): Promise<RequestCodeResult> {
    const parsed = requestPublicCodeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    /*
     * Ответ ВСЕГДА `{ sent: true }` — см. объяснение в сервисе. `reason` уходит
     * наружу только в виде признака «код отправлен»: различать причины в ответе
     * значило бы вернуть тот самый оракул.
     */
    return this.publicStatus.requestCode({
      orderNo: parsed.data.orderNo,
      phone: parsed.data.phone,
      ip: ip ?? null,
    });
  }

  /**
   * Проверить код и получить статус заказа.
   *
   * ОГРАНИЧЕНИЕ ПО АДРЕСУ ДОЛЖНО БЫТЬ БОЛЬШЕ ЧИСЛА ПОПЫТОК ПО КОДУ.
   *
   * Здесь стояло 10 запросов в минуту, и это оказалось ОШИБКОЙ, найденной на
   * живой проверке: клиент ошибался в коде три раза, а на четвёртый получал
   * `429 Too Many Requests` — то есть ограничение по адресу срабатывало РАНЬШЕ,
   * чем предусмотренный лимит попыток по коду. Клиент видел «слишком много
   * запросов» вместо «код не подошёл», не понимал, что происходит, и не мог
   * воспользоваться оставшимися попытками.
   *
   * Почему так вышло: общий лимит считает ВСЕ запросы подряд (в том числе
   * успешные и повторные проверки статуса), а лимит попыток — только ошибки по
   * одному коду. Сравнивать их напрямую нельзя, поэтому запас взят с избытком:
   * тридцать запросов в минуту. Это по-прежнему на порядок меньше, чем нужно
   * для осмысленного перебора, — а перебор ограничивает счётчик попыток, который
   * гасит код после пяти ошибок.
   */
  @Public()
  @Get()
  @Throttle({ short: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Статус заказа по номеру и коду' })
  async status(@Query() query: unknown): Promise<VerifyCodeResult> {
    const parsed = publicOrderStatusQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Проверьте правильность заполнения полей',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await this.publicStatus.verifyCode({
      orderNo: parsed.data.orderNo,
      code: parsed.data.code,
    });

    /*
     * Неудача отдаётся как 200 с `ok: false`, а не как 404 или 401. Причина та
     * же: код ответа — это тоже информация. `404` на несуществующий заказ и
     * `401` на неверный код позволили бы перебором отличить существующие заказы
     * от несуществующих. Клиент различает случаи по `reason`, но `reason`
     * описывает только ввод (формат, срок, число попыток) и не сообщает,
     * существует ли заказ.
     */
    return result;
  }

  /**
   * Параметры публичной проверки — для подсказок в интерфейсе.
   *
   * Значения берутся из доменных констант, а не пишутся числами: подсказка
   * «код живёт 10 минут» обязана меняться вместе с `PUBLIC_CODE_TTL_MS`, иначе
   * интерфейс начнёт обещать клиенту неверный срок — и клиент будет ждать код,
   * который уже не действует.
   */
  @Public()
  @Get('limits')
  @ApiOperation({ summary: 'Параметры публичной проверки статуса' })
  limits(): { codeDigits: number; ttlMinutes: number; requestsPerHour: number } {
    return {
      codeDigits: PUBLIC_CODE_DIGITS,
      ttlMinutes: Math.round(PUBLIC_CODE_TTL_MS / 60_000),
      requestsPerHour: PUBLIC_CODE_REQUESTS_PER_HOUR,
    };
  }
}
