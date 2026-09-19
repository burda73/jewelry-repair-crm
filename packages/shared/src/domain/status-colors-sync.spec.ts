/**
 * Согласованность цветов статусов между доменом и компонентом бейджа.
 *
 * ## Что именно проверяется и почему это не формальность
 *
 * `STATUS_COLORS` в домене хранит НЕ цвет, а имя тона (`'green'`, `'amber'`).
 * Настоящие классы Tailwind живут в `TONES` компонента `Badge`
 * (`apps/web/src/components/ui/badge.tsx`). Между словарями нет ничего, кроме
 * совпадения строк, и связь эта односторонняя: домен ничего не знает о
 * компоненте.
 *
 * Если тон появится в домене и не найдётся в `TONES`, бейдж не сломается
 * заметно — он просто отрисуется СЕРЫМ. `TONES[tone]` вернёт `undefined`,
 * склейка классов в `cn()` молча пропустит его, и готовый к выдаче заказ будет
 * выглядеть как черновик. Ни ошибки в консоли, ни падения сборки, ни провала
 * типа: цвет статуса — это единственный сигнал, который сотрудник видит не
 * читая текст. Потерять его незаметно для всех проверок — реальный риск.
 *
 * Тип `StatusTone` закрывает опечатки внутри домена (проверено: `'gren'` не
 * собирается). Этот тест закрывает вторую половину — расхождение между доменом
 * и компонентом, которое компилятор не видит, потому что компонент читает
 * словарь по ключу и приводит результат к своему типу.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATUS_COLORS } from './order-status.js';

/** Корень репозитория: файл лежит в `packages/shared/src/domain/`. */
const repoRoot = resolve(__dirname, '../../../..');

/**
 * Тона, объявленные в компоненте `Badge`.
 *
 * Читаются из исходника, а не импортируются: `apps/web` не является
 * зависимостью `packages/shared`, и импорт перевернул бы направление
 * зависимостей ради одного теста.
 */
function badgeTones(): string[] {
  const source = readFileSync(resolve(repoRoot, 'apps/web/src/components/ui/badge.tsx'), 'utf8');
  const block = /const TONES: Record<Tone, string> = \{([\s\S]*?)\n\};/.exec(source);
  if (block === null) throw new Error('Не найден словарь TONES в badge.tsx');
  return [...block[1].matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]);
}

describe('Цвета статусов: домен и компонент бейджа', () => {
  it('каждый тон из STATUS_COLORS существует в Badge', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА. Отсутствующий тон означал бы серый бейдж для живого
     * статуса — то есть потерю сигнала без единого признака поломки.
     */
    const tones = new Set(badgeTones());
    for (const [status, tone] of Object.entries(STATUS_COLORS)) {
      expect(tones.has(tone), `${status} → '${tone}' отсутствует в Badge.TONES`).toBe(true);
    }
  });

  it('словарь TONES прочитан полностью', () => {
    /*
     * Проверка самого разбора: если регулярное выражение однажды перестанет
     * совпадать с разметкой, `badgeTones()` вернёт пустой список, и первая
     * проверка провалится по непонятной причине. Здесь это видно прямо.
     */
    expect(badgeTones().length).toBeGreaterThanOrEqual(9);
    expect(badgeTones()).toContain('slate');
  });

  it('все статусы имеют цвет', () => {
    // Пропущенный статус отрисовался бы серым через запасное значение
    // `?? 'slate'` в компоненте — то есть снова молча.
    for (const [status, tone] of Object.entries(STATUS_COLORS)) {
      expect(typeof tone, status).toBe('string');
      expect(tone.length, status).toBeGreaterThan(0);
    }
  });

  it('значимые статусы различимы по тону', () => {
    /*
     * Цвет несёт смысл (docs/08-ui-ux.md §6): «выдан» и «отказ» не должны
     * совпадать, иначе сотрудник не отличит успешное закрытие от неуспешного.
     * Это не проверка красоты, а проверка того, что смысл сохранён.
     */
    expect(STATUS_COLORS.COMPLETED).not.toBe(STATUS_COLORS.REFUSED);
    expect(STATUS_COLORS.COMPLETED).not.toBe(STATUS_COLORS.CANCELLED);
    expect(STATUS_COLORS.READY_FOR_PICKUP).not.toBe(STATUS_COLORS.DRAFT);
    // Статусы ожидания ожидания клиента делят янтарный намеренно: для сотрудника
    // это одно состояние — «мяч на стороне клиента».
    expect(STATUS_COLORS.AWAITING_APPROVAL).toBe(STATUS_COLORS.AWAITING_PREPAYMENT);
  });
});
