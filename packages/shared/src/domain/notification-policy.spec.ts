/**
 * Тесты правил выбора каналов (задача 5.10).
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ. SMS — платный внешний канал. Ошибка в решении «отправлять
 * или нет» стоит не «неудобства», а денег: массовая рассылка по ошибке уходит
 * реальным клиентам и тарифицируется. Поэтому проверяется КАЖДОЕ условие
 * отдельно: включён ли канал, есть ли правило для события, известен ли телефон.
 *
 * ОТДЕЛЬНО ПРОВЕРЯЕТСЯ, ЧТО СОТРУДНИКУ SMS НЕ УХОДИТ. Рабочие вопросы решаются в
 * системе; SMS сотруднику — это лишние расходы без пользы.
 */

import { describe, expect, it } from 'vitest';
import { ORDER_TRANSITIONS } from './order-transitions.js';
import {
  CUSTOMER_NOTIFICATION_CODES,
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_CHANNEL_RULES,
  SMS_SINGLE_LENGTH,
  STAFF_NOTIFICATION_CODES,
  audienceFor,
  channelsFor,
  customerEventForTransition,
  transitionKeysWithCustomerEvent,
  fitsSingleSms,
  ruleForCode,
} from './notification-policy.js';

/** Доступность всех каналов — «всё включено». */
const ALL_ON = { smsEnabled: true, messengerEnabled: true, hasPhone: true };
/** Ничего не включено и телефона нет. */
const ALL_OFF = { smsEnabled: false, messengerEnabled: false, hasPhone: false };

describe('Правила доставки: состав (задача 5.10)', () => {
  it('каждое событие описано ровно один раз', () => {
    // Повтор правила означает, что одно из них никогда не применится, и часть
    // событий останется без каналов.
    const codes = NOTIFICATION_CHANNEL_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('все клиентские события имеют внешний канал', () => {
    /*
     * Клиент не видит уведомлений в системе: у него нет учётной записи. Если у
     * клиентского события нет внешнего канала, оно не дойдёт до адресата НИКОГДА,
     * и запись в базе будет единственным следом.
     */
    for (const code of Object.values(CUSTOMER_NOTIFICATION_CODES)) {
      const rule = ruleForCode(code);
      expect(rule, `нет правила для ${code}`).not.toBeNull();
      expect(rule?.optionalChannels.length, `${code}: нет внешнего канала`).toBeGreaterThan(0);
      expect(rule?.baseChannels, `${code}: клиенту не нужен внутренний канал`).toHaveLength(0);
    }
  });

  it('все события для сотрудника имеют внутренний канал', () => {
    /*
     * Событие для сотрудника обязано быть видно в системе: почта может быть не
     * настроена, и тогда единственным каналом остаётся лента.
     */
    for (const code of Object.values(STAFF_NOTIFICATION_CODES)) {
      const rule = ruleForCode(code);
      expect(rule, `нет правила для ${code}`).not.toBeNull();
      expect(rule?.baseChannels, `${code}: нет канала в приложении`).toContain('IN_APP');
    }
  });

  it('сотруднику SMS не назначается', () => {
    // Рабочие вопросы решаются в системе; SMS сотруднику — расходы без пользы.
    for (const code of Object.values(STAFF_NOTIFICATION_CODES)) {
      expect(ruleForCode(code)?.optionalChannels, `${code}`).toHaveLength(0);
    }
  });

  it('адресат события определяется', () => {
    expect(audienceFor(CUSTOMER_NOTIFICATION_CODES.READY_FOR_PICKUP)).toBe(
      NOTIFICATION_AUDIENCE.CUSTOMER,
    );
    expect(audienceFor(STAFF_NOTIFICATION_CODES.ORDER_OVERDUE)).toBe(NOTIFICATION_AUDIENCE.STAFF);
  });

  it('неизвестное событие не имеет правила', () => {
    // Возвращается `null`, а не «правило по умолчанию»: выдуманный набор каналов
    // для неизвестного события мог бы отправить SMS, которого никто не планировал.
    expect(ruleForCode('НЕСУЩЕСТВУЮЩЕЕ')).toBeNull();
    expect(audienceFor('НЕСУЩЕСТВУЮЩЕЕ')).toBeNull();
  });
});

describe('Выбор каналов (задача 5.10)', () => {
  it('при выключенных внешних каналах SMS не отправляется', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА. Клиентское событие при выключенном канале не должно
     * получить НИ ОДНОГО канала — запись в базу создаётся отдельно, а внешняя
     * отправка не выполняется.
     */
    expect(channelsFor(CUSTOMER_NOTIFICATION_CODES.READY_FOR_PICKUP, ALL_OFF)).toEqual([]);
  });

  it('при включённом канале и известном телефоне SMS отправляется', () => {
    // Обратная проверка: включение канала обязано работать, иначе задача
    // «включение по настройке» не выполнена.
    expect(channelsFor(CUSTOMER_NOTIFICATION_CODES.READY_FOR_PICKUP, ALL_ON)).toContain('SMS');
  });

  it('без телефона SMS не отправляется даже при включённом канале', () => {
    /*
     * Отправлять некуда. Проверка здесь, а не в адаптере: адаптер получает
     * готовый номер и не должен решать, есть ли он у клиента.
     */
    const noPhone = { smsEnabled: true, messengerEnabled: true, hasPhone: false };
    expect(channelsFor(CUSTOMER_NOTIFICATION_CODES.READY_FOR_PICKUP, noPhone)).toEqual([]);
  });

  it('включение одного канала не включает другой', () => {
    /*
     * SMS и мессенджер — разные провайдеры и разные деньги. Общий флаг включил бы
     * оба, и расходы оказались бы вдвое больше запланированных.
     */
    const onlySms = { smsEnabled: true, messengerEnabled: false, hasPhone: true };
    const channels = channelsFor(CUSTOMER_NOTIFICATION_CODES.READY_FOR_PICKUP, onlySms);
    expect(channels).toContain('SMS');
    expect(channels).not.toContain('MESSENGER');

    const onlyMessenger = { smsEnabled: false, messengerEnabled: true, hasPhone: true };
    const channels2 = channelsFor(CUSTOMER_NOTIFICATION_CODES.READY_FOR_PICKUP, onlyMessenger);
    expect(channels2).toContain('MESSENGER');
    expect(channels2).not.toContain('SMS');
  });

  it('сотруднику каналы не зависят от настроек SMS', () => {
    /*
     * Просрочка заказа должна дойти до ответственного независимо от того,
     * подключён ли SMS-провайдер: это разные подсистемы.
     */
    const withSms = channelsFor(STAFF_NOTIFICATION_CODES.ORDER_OVERDUE, ALL_ON);
    const withoutSms = channelsFor(STAFF_NOTIFICATION_CODES.ORDER_OVERDUE, ALL_OFF);

    expect(withSms).toEqual(withoutSms);
    expect(withSms).toContain('IN_APP');
    expect(withSms).toContain('EMAIL');
    expect(withSms).not.toContain('SMS');
  });

  it('неизвестное событие не получает каналов', () => {
    // Иначе опечатка в коде шаблона превратилась бы в отправку «чего-то» по
    // каналам, которые никто не выбирал.
    expect(channelsFor('ОПЕЧАТКА', ALL_ON)).toEqual([]);
  });

  it('внутренние каналы не дублируются', () => {
    // Повтор в списке означал бы два одинаковых уведомления в ленте.
    const channels = channelsFor(STAFF_NOTIFICATION_CODES.ORDER_OVERDUE, ALL_ON);
    expect(new Set(channels).size).toBe(channels.length);
  });
});

describe('Длина SMS (задача 5.10)', () => {
  it('короткий текст влезает в одно сообщение', () => {
    expect(fitsSingleSms('Заказ MSK1-2509-000001 готов')).toBe(true);
  });

  it('текст ровно на границе влезает', () => {
    // Граница включительная: 70 символов — это ещё одно сообщение.
    expect(fitsSingleSms('а'.repeat(SMS_SINGLE_LENGTH))).toBe(true);
  });

  it('текст длиннее границы не влезает', () => {
    /*
     * 71 символ кириллицы — это уже ДВА тарифицируемых сообщения. Заметить это
     * можно было бы только по счёту от провайдера, то есть слишком поздно.
     */
    expect(fitsSingleSms('а'.repeat(SMS_SINGLE_LENGTH + 1))).toBe(false);
  });
});

describe('Согласованность таблицы событий и таблицы переходов (задача 5.10)', () => {
  it('каждое клиентское событие привязано к переходу с эффектом NOTIFY_CUSTOMER', () => {
    /*
     * РЕАЛЬНЫЙ ДЕФЕКТ, найденный при разборе задачи. Таблица событий и таблица
     * переходов живут в разных файлах. Запись о событии для перехода, у которого
     * НЕТ эффекта `NOTIFY_CUSTOMER`, мёртвая: уведомление не создаётся никогда,
     * хотя текст шаблона существует и выглядит рабочим.
     *
     * Именно так и пропало обещанное docs/05 §3 событие «Заказ принят»
     * (`DRAFT` → `ACCEPTED`): шаблон был, событие не возникало.
     */
    for (const key of transitionKeysWithCustomerEvent()) {
      const [from, to] = key.split('->');
      const rule = ORDER_TRANSITIONS.find(
        (transition) => transition.from === from && transition.to === to,
      );
      expect(rule, `нет перехода ${key}`).toBeDefined();
      expect(
        rule?.effects.includes('NOTIFY_CUSTOMER'),
        `${key}: переход без эффекта NOTIFY_CUSTOMER - уведомление не создастся`,
      ).toBe(true);
    }
  });

  it('каждый переход с NOTIFY_CUSTOMER имеет событие', () => {
    /*
     * Обратная проверка: эффект в переходе без события означал бы, что система
     * считает клиента уведомлённым, а сообщения нет. Так выглядел исходный
     * дефект задачи: эффект в таблице переходов был, обработчика не было вовсе.
     */
    for (const transition of ORDER_TRANSITIONS) {
      if (!transition.effects.includes('NOTIFY_CUSTOMER')) continue;

      const key = `${transition.from}->${transition.to}`;
      expect(
        customerEventForTransition(transition.from, transition.to),
        `${key}: эффект есть, а события нет`,
      ).not.toBeNull();
    }
  });

  it('разные переходы в один статус дают разные события', () => {
    /*
     * Статус `ACCEPTED` достигается и приёмом заказа, и поступлением предоплаты.
     * Ключ по целевому статусу смог бы выразить только один смысл, и второй
     * молча пропал бы: клиент либо не узнал бы, что заказ принят, либо получил бы
     * «оплата получена», ничего не заплатив.
     */
    expect(customerEventForTransition('DRAFT', 'ACCEPTED')).toBe('ORDER_ACCEPTED');
    expect(customerEventForTransition('AWAITING_APPROVAL', 'ACCEPTED')).toBe('ORDER_ACCEPTED');
    // Предоплата - событие платежа, создаётся тем, кто принимает деньги.
    expect(customerEventForTransition('AWAITING_PREPAYMENT', 'ACCEPTED')).toBeNull();
  });
});
