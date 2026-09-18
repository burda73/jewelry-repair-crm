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
  it('коды не повторяются', () => {
    /*
     * Повтор кода означает, что один шаблон затрёт другой при синхронизации
     * (`upsert` по коду), и часть уведомлений останется без текста.
     */
    const codes = NOTIFICATION_TEMPLATES.map((template) => template.code);
    expect(new Set(codes).size).toBe(codes.length);
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
