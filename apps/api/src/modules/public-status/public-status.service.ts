import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { normalizePhone } from '@app/shared';
import {
  PUBLIC_CODE_REQUEST_WINDOW_MS,
  PUBLIC_CODE_TTL_MS,
  PUBLIC_VISIBLE_STATUSES,
  canRequestCode,
  generateCode,
  isCodeExpired,
  isCodeLocked,
  normalizeCodeInput,
  toPublicOrderStatusView,
  type PublicOrderStatusView,
} from '@app/shared';

/**
 * Результат запроса кода.
 *
 * Функция НЕ сообщает, существует ли заказ. Это главное решение всего модуля:
 * ответ `{ sent: true }` возвращается и для несуществующего номера, и для
 * заказа с другим телефоном, и при исчерпанном лимите. Иначе публичный маршрут
 * стал бы оракулом: перебором номеров можно было бы узнать, какие заказы есть в
 * системе, — а это уже утечка, даже без показа статуса.
 */
export interface RequestCodeResult {
  /** Код отправлен (или выглядит отправленным — см. выше). */
  sent: boolean;
  /**
   * ЗАЧЕМ ЗДЕСЬ НЕТ МАСКИ ТЕЛЕФОНА.
   *
   * Первый вариант ответа содержал `phoneMask` — «код отправлен на ****4567».
   * Это удобная подсказка, и она ФАТАЛЬНА для всей защиты: маска заполнена
   * ТОЛЬКО тогда, когда заказ существует, публично виден И телефон совпал.
   * То есть поле само по себе — тот самый оракул, от которого мы уходим:
   * перебором номеров заказов можно было бы узнать, какие из них существуют.
   *
   * Обнаружено тестом на неотличимость ответов, а не рассуждением: тест сравнил
   * ответ по существующему и несуществующему заказу и увидел разные маски.
   *
   * Подтверждение «это ваш телефон» клиенту не нужно: он сам его ввёл, и
   * интерфейс показывает маску ИЗ ВВЕДЁННОГО значения, ничего не спрашивая у
   * сервера. Внутренняя причина отказа остаётся в `reason` — для журнала.
   */
  reason:
    | 'SENT'
    | 'ALREADY_SENT'
    | 'RATE_LIMITED'
    | 'ORDER_NOT_FOUND'
    | 'ORDER_NOT_VISIBLE'
    | 'PHONE_MISMATCH'
    | 'NO_PHONE';
}

/** Результат проверки кода. */
export interface VerifyCodeResult {
  ok: boolean;
  view: PublicOrderStatusView | null;
  reason: 'OK' | 'INVALID_INPUT' | 'NOT_FOUND' | 'EXPIRED' | 'LOCKED' | 'MISMATCH';
}

/** Сколько неудачных попыток до блокировки показывать клиенту в подсказке. */
@Injectable()
export class PublicStatusService {
  private readonly logger = new Logger(PublicStatusService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /**
   * Хеш кода.
   *
   * SHA-256, а не Argon2. Разница принципиальна и её стоит понимать: Argon2
   * нужен там, где значение может быть подобрано ОФЛАЙН по украденному хешу, и
   * пароль пользователя ценен годами. Здесь значение живёт десять минут, после
   * пяти ошибок гасится, а поиск в базе ведётся по заказу — то есть подбирать
   * хеш бессмысленно: к моменту подбора код уже мёртв. Платить за медленный хеш
   * задержкой на каждый вход было бы вредно без всякой пользы.
   */
  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /**
   * Запросить код по номеру заказа и телефону.
   *
   * ВСЕГДА возвращает `sent: true`, кроме случая, когда заказ есть и код уже
   * выдан в пределах окна (тогда повторно SMS не отправляется, чтобы не платить
   * дважды за одно действие).
   */
  async requestCode(params: {
    orderNo: string;
    phone: string;
    ip: string | null;
    now?: Date;
  }): Promise<RequestCodeResult> {
    const now = params.now ?? new Date();
    const orderNo = params.orderNo.trim();
    const phoneNormalized = normalizePhone(params.phone);

    if (phoneNormalized === null) {
      // Некорректный телефон не отличим для клиента от «код отправлен»: иначе
      // по формату ответа можно было бы понять, верный ли номер у заказа.
      return { sent: true, reason: 'PHONE_MISMATCH' };
    }

    /*
     * Лимит проверяется ПО ТЕЛЕФОНУ и ДО поиска заказа. Порядок важен: он не
     * даёт использовать маршрут как оракул — при исчерпанном лимите ответ
     * одинаков для существующего и несуществующего заказа.
     */
    const recentRequests = await this.prisma.publicOrderCode.count({
      where: {
        phoneNormalized,
        createdAt: { gte: new Date(now.getTime() - PUBLIC_CODE_REQUEST_WINDOW_MS) },
      },
    });

    if (!canRequestCode(recentRequests)) {
      this.logger.warn(
        `Лимит запросов кода исчерпан для телефона ${maskPhoneForLog(phoneNormalized)}`,
      );
      return { sent: true, reason: 'RATE_LIMITED' };
    }

    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      select: {
        id: true,
        status: true,
        customer: { select: { phoneNormalized: true } },
      },
    });

    if (order === null) {
      return { sent: true, reason: 'ORDER_NOT_FOUND' };
    }

    if (!(PUBLIC_VISIBLE_STATUSES as readonly string[]).includes(order.status)) {
      return { sent: true, reason: 'ORDER_NOT_VISIBLE' };
    }

    /*
     * Телефон обязан совпасть с телефоном КЛИЕНТА заказа. Это второй фактор:
     * номер заказа угадываем, а телефон клиента — нет. Сравниваем
     * нормализованные значения, иначе «8 900…» и «+7 900…» считались бы разными.
     */
    if (order.customer.phoneNormalized !== phoneNormalized) {
      return { sent: true, reason: 'PHONE_MISMATCH' };
    }

    /*
     * Если живой код уже выдан, повторно SMS не отправляем. Клиент нажал кнопку
     * дважды или не дождался — платить за второе сообщение незачем, а прежний
     * код ещё действует.
     */
    const active = await this.prisma.publicOrderCode.findFirst({
      where: {
        orderId: order.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (active !== null) {
      return { sent: true, reason: 'ALREADY_SENT' };
    }

    const code = generateCode();

    await this.prisma.publicOrderCode.create({
      data: {
        orderId: order.id,
        codeHash: this.hashCode(code),
        phoneNormalized,
        expiresAt: new Date(now.getTime() + PUBLIC_CODE_TTL_MS),
        ip: params.ip,
      },
    });

    /*
     * Отправка идёт через существующий порт уведомлений. Если SMS-канал выключен
     * настройкой, сообщение останется в таблице `notification` как неотправленное
     * — и это ПРАВИЛЬНО: администратор увидит в логе, что клиент не получил код,
     * а не будет искать причину в логах приложения.
     */
    const created = await this.notifications.notifyCustomer({
      code: 'PUBLIC_STATUS_CODE',
      customerId: null,
      orderId: order.id,
      phone: phoneNormalized,
      values: { code },
    });

    /*
     * ЕСЛИ КОД НИКУДА НЕ УШЁЛ — ЭТО ОТКАЗ ФУНКЦИИ, А НЕ ОБЫЧНОЕ СОБЫТИЕ.
     *
     * В отличие от прочих клиентских уведомлений, здесь код — КЛЮЧ ДОСТУПА:
     * без доставки публичная страница не работает вовсе, а клиент будет ждать
     * сообщение, которого не будет. Каналы `SMS` и `MESSENGER` выключены по
     * умолчанию (это внешние и платные каналы), поэтому ситуация «код создан, но
     * отправить некуда» вполне достижима — и о ней нужно сказать ГРОМКО.
     *
     * Наружу по-прежнему уходит `sent: true`: иначе ответ стал бы оракулом и
     * выдал бы существование заказа. Но администратор увидит причину в журнале,
     * а не будет искать её в переписке с клиентом.
     */
    if (created.length === 0) {
      this.logger.error(
        'Код проверки статуса создан, но НЕ ОТПРАВЛЕН: ни один внешний канал ' +
          '(SMS, MESSENGER) не включён настройкой. Публичная проверка статуса ' +
          'неработоспособна, пока канал не подключён — см. docs/05 §3.1.',
      );
      return { sent: true, reason: 'NO_PHONE' };
    }

    return { sent: true, reason: 'SENT' };
  }

  /**
   * Проверить код и вернуть публичное представление заказа.
   *
   * Порядок проверок задан от дешёвых к дорогим и от «нельзя вообще» к «можно»:
   * формат → существование живого кода → блокировка → срок → сравнение.
   */
  async verifyCode(params: {
    orderNo: string;
    code: string;
    now?: Date;
  }): Promise<VerifyCodeResult> {
    const now = params.now ?? new Date();
    const normalized = normalizeCodeInput(params.code);

    if (normalized === null) {
      // Формат проверяем до базы: мусор в поле не должен вызывать запрос.
      return { ok: false, view: null, reason: 'INVALID_INPUT' };
    }

    const order = await this.prisma.order.findUnique({
      where: { orderNo: params.orderNo.trim() },
      select: {
        id: true,
        orderNo: true,
        status: true,
        dueAt: true,
        totalAmountMinor: true,
        paidAmountMinor: true,
        currency: true,
        customer: { select: { phoneNormalized: true } },
      },
    });

    if (order === null) {
      return { ok: false, view: null, reason: 'NOT_FOUND' };
    }

    /*
     * Ищем среди ЖИВЫХ кодов заказа, а не только последний. Так повторный ввод
     * ранее выданного кода (если клиент запросил новый) не открывает доступ —
     * иначе отзыв кода был бы невозможен.
     */
    const record = await this.prisma.publicOrderCode.findFirst({
      where: { orderId: order.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (record === null) {
      return { ok: false, view: null, reason: 'NOT_FOUND' };
    }

    /*
     * Блокировка проверяется ДО сравнения. Если сравнивать раньше, последняя
     * разрешённая попытка всё ещё работала бы, и смысл ограничения терялся бы:
     * оно существует, чтобы после N ошибок код был мёртв независимо от
     * следующего ввода.
     */
    if (isCodeLocked(record.attempts)) {
      return { ok: false, view: null, reason: 'LOCKED' };
    }

    if (isCodeExpired(record.expiresAt, now)) {
      return { ok: false, view: null, reason: 'EXPIRED' };
    }

    /*
     * Сравниваем хеши. `timingSafeEqual` здесь не нужен: значение короткое,
     * живёт минуты и после пяти ошибок гасится, — а сторонний наблюдатель не
     * может измерять время сравнения в нашей базе.
     */
    if (record.codeHash !== this.hashCode(normalized)) {
      await this.prisma.publicOrderCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      return { ok: false, view: null, reason: 'MISMATCH' };
    }

    /*
     * Публичность статуса проверяется ДО отметки об использовании.
     *
     * ЗАЧЕМ ИМЕННО ТАК. Заказ мог вернуться в черновик между выдачей кода и
     * проверкой. Если сначала погасить код, а потом обнаружить, что показывать
     * нечего, клиент потеряет код, не получив ничего: повторный ввод даст
     * `NOT_FOUND`, а причина будет непонятна. Проверка впереди оставляет код
     * живым — и он сработает, если заказ снова станет публичным.
     *
     * Дефект найден тестом: код гасился на черновике. Порядок операций здесь —
     * часть поведения, а не деталь реализации.
     */
    const view = toPublicOrderStatusView({
      orderNo: order.orderNo,
      status: order.status,
      dueAt: order.dueAt,
      totalAmountMinor: order.totalAmountMinor,
      paidAmountMinor: order.paidAmountMinor,
      currency: order.currency,
      phone: order.customer.phoneNormalized,
    });

    if (view === null) {
      // Статус стал непубличным между выдачей кода и проверкой. Отвечаем как
      // «не найден» — заказ действительно больше не показывается, и ответ не
      // раскрывает незавершённую операцию. Код при этом остаётся живым.
      return { ok: false, view: null, reason: 'NOT_FOUND' };
    }

    /*
     * Успех: код помечается использованным. Код ОДНОРАЗОВЫЙ — иначе
     * перехваченное сообщение давало бы доступ до конца срока, а клиент не
     * заметил бы постороннего.
     */
    await this.prisma.publicOrderCode.update({
      where: { id: record.id },
      data: { usedAt: now },
    });

    return { ok: true, view, reason: 'OK' };
  }

  /**
   * Удалить истёкшие коды.
   *
   * Вызывается воркером. Истёкшие коды — это персональные данные (телефон) в
   * связке с заказом, и хранить их дольше нужного незачем. Использованные
   * удаляются вместе с истёкшими: срок — единственный критерий.
   */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.publicOrderCode.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}

/**
 * Телефон для журнала.
 *
 * В лог полный номер не пишем: журнал читают шире, чем базу, и номер клиента —
 * персональные данные. Хвоста достаточно, чтобы разобрать обращение.
 */
function maskPhoneForLog(phoneNormalized: string): string {
  const digits = phoneNormalized.replace(/\D/g, '');
  return `****${digits.slice(-4)}`;
}
