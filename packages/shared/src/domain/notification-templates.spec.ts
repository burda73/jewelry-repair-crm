/**
 * Тесты списка шаблонов уведомлений (задачи 2.5–2.10).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Шаблоны — настроечные данные, и сид в продакшне не
 * запускают. Пока список жил только в `seed.ts`, новый шаблон не появлялся на
 * сервере, и уведомление уходило по ЗАПАСНОМУ тексту: работало, но не так, как
 * задумано, и заметить это можно было только прочитав сообщение. Здесь
 * проверяется, что список полон и согласован с кодами, которые использует код.
 */

import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TEMPLATES } from './notification-templates.js';

describe('Шаблоны уведомлений: состав', () => {
  it('пары «код + канал» не повторяются', () => {
    /*
     * Ключ шаблона — пара, а не один код: у одного события два текста, для
     * интерфейса и для почты. Повтор пары означал бы, что один шаблон затрёт
     * другой при синхронизации, и часть каналов останется без текста.
     *
     * Проверять уникальность ОДНИХ кодов теперь нельзя: она более не требуется и
     * как раз мешала почтовым текстам существовать.
     */
    const keys = NOTIFICATION_TEMPLATES.map((template) => `${template.code}|${template.channel}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('для почтовых уведомлений сотрудника есть тексты', () => {
    /*
     * РЕАЛЬНЫЙ ДЕФЕКТ, найденный в задаче 5.9. Все шаблоны имели канал `IN_APP`,
     * а уникальным был один `code` — поэтому строки с каналом `EMAIL` не могли
     * существовать вовсе. Сервис ищет шаблон по паре «код + канал», не находил
     * его и отправлял запасной текст вида «Событие: ORDER_OVERDUE». В интерфейсе
     * при этом всё выглядело правильно, и заметить можно было только в письме.
     *
     * Проверяются именно те события, которые идут сотрудникам по двум каналам.
     */
    const emailCodes = new Set(
      NOTIFICATION_TEMPLATES.filter((t) => t.channel === 'EMAIL').map((t) => t.code),
    );
    for (const code of [
      'ORDER_OVERDUE',
      'ESCALATION_MANAGER',
      'ORDER_UNCLAIMED',
      'BATCH_RECEIVED',
      'BATCH_TRANSIT_LATE',
    ]) {
      expect(emailCodes.has(code), `нет почтового текста для ${code}`).toBe(true);
    }
  });

  it('тексты для интерфейса и для почты различаются', () => {
    /*
     * Если бы содержимое совпадало, отдельные записи были бы не нужны. Письмо
     * требует темы, понятной в списке входящих, и может быть подробнее: его
     * читают с экрана, а не в узкой панели уведомлений.
     */
    const inApp = NOTIFICATION_TEMPLATES.filter((t) => t.channel === 'IN_APP');
    for (const template of inApp) {
      const email = NOTIFICATION_TEMPLATES.find(
        (t) => t.channel === 'EMAIL' && t.code === template.code,
      );
      if (email === undefined) continue;
      expect(email.body, `${template.code}: текст письма совпал с интерфейсным`).not.toBe(
        template.body,
      );
    }
  });

  it('у каждого шаблона указан канал', () => {
    // Канал входит в ключ поиска: шаблон без канала не найдётся никогда.
    for (const template of NOTIFICATION_TEMPLATES) {
      expect(
        ['IN_APP', 'EMAIL', 'SMS', 'MESSENGER'],
        `${template.code}: неизвестный канал ${template.channel}`,
      ).toContain(template.channel);
    }
  });

  it('у каждого шаблона есть текст', () => {
    // Пустой текст превращает уведомление в бессмысленное сообщение.
    for (const template of NOTIFICATION_TEMPLATES) {
      expect(template.body.trim(), `${template.code}: пустой текст`).not.toBe('');
    }
  });

  it('тема есть у каналов, где она существует', () => {
    /*
     * Тема нужна интерфейсу и почте. У SMS и мессенджера её НЕТ: сообщение
     * доставляется одним текстом, и незаполненная тема попала бы в отправку как
     * пустая строка. Прежняя проверка требовала тему у ВСЕХ шаблонов — с
     * появлением SMS-канала (задача 5.10) это перестало быть верным.
     */
    for (const template of NOTIFICATION_TEMPLATES) {
      if (template.channel === 'IN_APP' || template.channel === 'EMAIL') {
        expect(template.subject?.trim(), `${template.code}: пустая тема`).not.toBe('');
      } else {
        expect(template.subject, `${template.code}: у этого канала нет темы`).toBeNull();
      }
    }
  });

  it('подстановки записаны в одном формате', () => {
    /*
     * Опечатка в фигурных скобках (`{orderNo}` вместо `{{orderNo}}`) не ломает
     * отправку: подстановка просто не найдёт переменную, и получатель увидит
     * текст с фигурными скобками. Проверка ловит это заранее.
     */
    for (const template of NOTIFICATION_TEMPLATES) {
      const text = `${template.subject} ${template.body}`;
      const odd = text.match(/(?<!\{)\{(?!\{)[a-zA-Z]+(?<!\})\}(?!\})/g);
      expect(odd, `${template.code}: подстановка не в формате {{имя}}`).toBeNull();
    }
  });

  it('все коды, используемые сервисами, присутствуют', () => {
    /*
     * Список кодов ведётся отдельно от текстов (`TEMPLATE_CODE` в сервисе
     * уведомлений). Расхождение означало бы, что сервис ищет шаблон, которого
     * нет, и уведомление уходит по запасному тексту.
     */
    const codes = new Set(NOTIFICATION_TEMPLATES.map((template) => template.code));
    for (const code of [
      'ORDER_OVERDUE',
      'ESCALATION_MANAGER',
      'ORDER_UNCLAIMED',
      'BATCH_RECEIVED',
      'BATCH_TRANSIT_LATE',
      'READY_FOR_PICKUP',
    ]) {
      expect(codes.has(code), `шаблон ${code} отсутствует в списке`).toBe(true);
    }
  });

  it('письмо приёмщику и письмо клиенту — разные шаблоны', () => {
    /*
     * `UNCLAIMED_REMINDER` адресован клиенту («ожидает вас»), `ORDER_UNCLAIMED`
     * — приёмщику. Совпадение текстов означало бы, что одно из двух обращений
     * отправлено не тому адресату.
     */
    const client = NOTIFICATION_TEMPLATES.find((t) => t.code === 'UNCLAIMED_REMINDER');
    const receiver = NOTIFICATION_TEMPLATES.find((t) => t.code === 'ORDER_UNCLAIMED');

    expect(client).toBeDefined();
    expect(receiver).toBeDefined();
    expect(client?.body).not.toBe(receiver?.body);
  });
});

describe('Клиентские шаблоны SMS и мессенджера (задача 5.10)', () => {
  const customerCodes = [
    'ORDER_ACCEPTED',
    'APPROVAL_REQUEST',
    'PREPAYMENT_RECEIVED',
    'READY_FOR_PICKUP',
    'UNCLAIMED_REMINDER',
    'WARRANTY_ISSUED',
  ];

  it('каждое клиентское событие имеет текст для SMS', () => {
    /*
     * Без шаблона уведомление уйдёт запасным текстом «Событие: ORDER_ACCEPTED» —
     * то есть клиент получит служебную строку вместо сообщения.
     */
    for (const code of customerCodes) {
      const template = NOTIFICATION_TEMPLATES.find(
        (item) => item.code === code && item.channel === 'SMS',
      );
      expect(template, `нет SMS-шаблона для ${code}`).toBeDefined();
    }
  });

  it('каждое клиентское событие имеет текст для мессенджера', () => {
    for (const code of customerCodes) {
      const template = NOTIFICATION_TEMPLATES.find(
        (item) => item.code === code && item.channel === 'MESSENGER',
      );
      expect(template, `нет шаблона мессенджера для ${code}`).toBeDefined();
    }
  });

  it('SMS-тексты влезают в одно сообщение', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА ЗАДАЧИ. Всё, что длиннее 70 символов кириллицы,
     * разбивается на части, и КАЖДАЯ тарифицируется отдельно: «длинное SMS»
     * стоит как два, а не как одно. Заметить это можно было бы только по счёту
     * от провайдера, то есть слишком поздно.
     *
     * Проверяется текст с подставленными значениями: подстановка удлиняет
     * строку, и шаблон, влезающий «в теории», может не влезть в жизни.
     */
    const sms = NOTIFICATION_TEMPLATES.filter((item) => item.channel === 'SMS');
    expect(sms.length).toBeGreaterThan(0);

    for (const template of sms) {
      const rendered = template.body
        .replace(/\{\{orderNo\}\}/g, 'MSK1-2509-000001')
        .replace(/\{\{dueAt\}\}/g, '25.09.2026')
        .replace(/\{\{amount\}\}/g, '1 200,00 ₽')
        .replace(/\{\{warrantyUntil\}\}/g, '25.03.2027');

      expect(
        rendered.length,
        `${template.code}: ${rendered.length} символов — это два SMS`,
      ).toBeLessThanOrEqual(70);
    }
  });

  it('SMS-тексты без темы', () => {
    // У SMS темы нет: незаполненная тема попала бы в отправку как пустая строка.
    for (const template of NOTIFICATION_TEMPLATES.filter((item) => item.channel === 'SMS')) {
      expect(template.subject, `${template.code}`).toBeNull();
    }
  });

  it('тексты SMS и мессенджера различаются', () => {
    /*
     * Одинаковый текст означал бы, что один из каналов получил чужой формат: либо
     * клиент платит за лишние SMS, либо получает в мессенджер рубленую фразу.
     */
    for (const code of customerCodes) {
      const sms = NOTIFICATION_TEMPLATES.find((i) => i.code === code && i.channel === 'SMS');
      const messenger = NOTIFICATION_TEMPLATES.find(
        (i) => i.code === code && i.channel === 'MESSENGER',
      );
      expect(sms?.body, `${code}: тексты совпадают`).not.toBe(messenger?.body);
    }
  });

  it('тексты для клиента не дублируют тексты для сотрудника', () => {
    /*
     * Клиентские тексты короче и не содержат внутренних формулировок. Совпадение
     * означало бы, что клиенту ушёл текст для сотрудника.
     */
    for (const code of customerCodes) {
      const sms = NOTIFICATION_TEMPLATES.find((i) => i.code === code && i.channel === 'SMS');
      const inApp = NOTIFICATION_TEMPLATES.find((i) => i.code === code && i.channel === 'IN_APP');
      if (inApp !== undefined) {
        expect(sms?.body, `${code}`).not.toBe(inApp.body);
      }
    }
  });
});
