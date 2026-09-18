/**
 * Проверка, что документация не разошлась с кодом (docs/04-status-workflow.md §6).
 *
 * Если кто-то добавит переход в код, но забудет обновить документ (или наоборот),
 * этот тест упадёт. Документация, которая молча устаревает, хуже её отсутствия.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORDER_TRANSITIONS } from './order-transitions.js';
import { ALL_ORDER_STATUSES, STATUS_LABELS } from './order-status.js';
import { ALL_ROLES, ROLE_LABELS } from './roles.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const docsDir = resolve(repoRoot, 'docs');

function readDoc(name: string): string {
  return readFileSync(resolve(docsDir, name), 'utf8');
}

describe('Документация: статусная модель', () => {
  const workflow = readDoc('04-status-workflow.md');

  it('документ существует и читается', () => {
    expect(workflow.length).toBeGreaterThan(1000);
  });

  it('число переходов в коде совпадает с числом строк таблицы в документе', () => {
    // Строки таблицы переходов имеют вид "| 12 | `...` | `...` |"
    const tableRows = workflow
      .split('\n')
      .filter((line) => /^\|\s*\d+\s*\|/.test(line.trim()))
      .map((line) => Number(line.trim().split('|')[1]?.trim()));

    expect(tableRows.length).toBe(ORDER_TRANSITIONS.length);
    expect([...tableRows].sort((a, b) => a - b)).toEqual(
      ORDER_TRANSITIONS.map((t) => t.id).sort((a, b) => a - b),
    );
  });

  it('каждый статус упомянут в документе', () => {
    for (const status of ALL_ORDER_STATUSES) {
      expect(workflow, `статус ${status} отсутствует в docs/04-status-workflow.md`).toContain(
        `\`${status}\``,
      );
    }
  });

  it('русские названия статусов совпадают с документом', () => {
    for (const status of ALL_ORDER_STATUSES) {
      const label = STATUS_LABELS[status];
      expect(workflow, `название «${label}» для ${status} не найдено в документе`).toContain(label);
    }
  });

  /**
   * Побочные эффекты переходов должны быть описаны в документе.
   *
   * ЗАЧЕМ. Это расхождение уже привело к реальному дефекту: переходы 4, 11, 13,
   * 15 и 16 назначают нормативный срок (`SET_DUE_AT`), но в таблице документа
   * `dueAt` у них не упоминался, а переходы 3, 5 и 7 (в `ACCEPTED`) его
   * объявляли, хотя норматива у этапа `INTAKE` нет. Документ и код
   * расходились в обе стороны, и ни один тест этого не видел.
   *
   * Проверка специально про `dueAt`: это единственный эффект, который зависит
   * от СПРАВОЧНИКА (`StageNorm`), поэтому его рассинхронизация не проявляется
   * ошибкой, а тихо оставляет заказ без срока.
   */
  it('назначение нормативного срока (dueAt) описано там же, где объявлено в коде', () => {
    const section = workflow.split('## 2. Допустимые переходы')[1]?.split('## 3.')[0];
    expect(section, 'в документе нет раздела «Допустимые переходы»').toBeTruthy();

    const rows = (section ?? '').split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line.trim()));

    const mismatches: string[] = [];
    for (const transition of ORDER_TRANSITIONS) {
      const row = rows.find((line) => Number(line.trim().split('|')[1]?.trim()) === transition.id);
      if (row === undefined) continue; // отсутствие строки ловит тест выше
      const inCode = transition.effects.includes('SET_DUE_AT');
      const inDoc = /dueAt/i.test(row);
      if (inCode !== inDoc) {
        mismatches.push(
          `переход ${transition.id} (${transition.from} → ${transition.to}): ` +
            `в коде ${inCode ? 'есть' : 'нет'} SET_DUE_AT, в документе ${inDoc ? 'есть' : 'нет'} dueAt`,
        );
      }
    }

    expect(mismatches, `расхождения кода и документа:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('документ не описывает больше переходов, чем реализовано', () => {
    // Ловим случай, когда переход удалили из кода, но оставили в документе.
    const tableRows = workflow.split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line.trim()));
    const documentedIds = new Set(
      tableRows.map((line) => Number(line.trim().split('|')[1]?.trim())),
    );
    const codeIds = new Set(ORDER_TRANSITIONS.map((t) => t.id));
    const onlyInDocs = [...documentedIds].filter((id) => !codeIds.has(id));
    expect(
      onlyInDocs,
      `переходы есть в документе, но отсутствуют в коде: ${onlyInDocs.join(', ')}`,
    ).toEqual([]);
  });
});

describe('Документация: роли', () => {
  const rolesDoc = readDoc('02-domain-and-roles.md');

  it('каждая роль описана в документации', () => {
    for (const role of ALL_ROLES) {
      expect(rolesDoc, `роль ${role} не упомянута в docs/02-domain-and-roles.md`).toContain(role);
    }
  });

  it('русские названия ролей присутствуют в документе', () => {
    for (const role of ALL_ROLES) {
      expect(rolesDoc, `название «${ROLE_LABELS[role]}» для роли ${role} не найдено`).toContain(
        ROLE_LABELS[role],
      );
    }
  });

  it('документ явно фиксирует, что мастер-ювелир не является пользователем системы', () => {
    // Решение заказчика, критичное для понимания ролевой модели.
    expect(rolesDoc).toMatch(/Мастер-ювелир не является пользователем системы/);
  });
});

describe('Документация: решения', () => {
  const decisions = readDoc('00-decisions.md');

  it('зафиксированы ответы на все 4 вопроса из ТЗ', () => {
    // Вопросы: SMS, личный кабинет, мобильное приложение, разграничение по магазинам.
    expect(decisions).toMatch(/SMS-уведомления клиенту/);
    expect(decisions).toMatch(/Личный кабинет клиента/);
    expect(decisions).toMatch(/Мобильное приложение для мастеров/);
    expect(decisions).toMatch(/Разграничение по магазинам/);
  });

  it('зафиксировано решение по стеку', () => {
    expect(decisions).toContain('NestJS');
    expect(decisions).toContain('Next.js');
    expect(decisions).toContain('PostgreSQL');
    expect(decisions).toContain('Prisma');
  });
});
