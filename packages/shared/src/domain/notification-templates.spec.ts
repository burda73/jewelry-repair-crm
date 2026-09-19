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

  it('у каждого шаблона есть тема и текст', () => {
    // Пустая тема или текст превращает уведомление в безымянное сообщение.
    for (const template of NOTIFICATION_TEMPLATES) {
      expect(template.subject.trim(), `${template.code}: пустая тема`).not.toBe('');
      expect(template.body.trim(), `${template.code}: пустой текст`).not.toBe('');
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
