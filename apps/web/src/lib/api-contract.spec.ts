import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Форма ответа API должна совпадать с типами интерфейса.
 *
 * ## Дефект, который здесь закрывается
 *
 * В карточке заказа вместо ФИО исполнителя показывалось `undefined`. Причина:
 * тип `OrderAssignment` в `apps/web/src/lib/api-types.ts` объявлял ПЛОСКИЕ поля
 * `performerName` и `assignedByName`, тогда как `GET /orders/:id` отдаёт связи
 * ВЛОЖЕННО (`performer.fullName`, `assignedBy.fullName`). Плоская форма —
 * это ответ ДРУГОГО маршрута (`POST /orders/:id/assignments`).
 *
 * ## Почему ни одна проверка этого не поймала
 *
 * Типы интерфейса написаны руками и не связаны с типами сервера: `apps/web` не
 * зависит от `apps/api`. TypeScript проверяет только СОГЛАСОВАННОСТЬ типа с его
 * использованием, но не с реальным ответом. Пока `OrderAssignment` описывал поля,
 * которых сервер не присылает, компилятор молчал, тесты компонентов не
 * рендерились (`environment: 'node'`), и единственным обнаружением было то, что
 * сотрудник увидел `undefined` на экране.
 *
 * ## Что проверяет этот тест
 *
 * Читает ОБА источника — форму выборки на сервере (`ORDER_CARD_INCLUDE`) и
 * объявление типа в интерфейсе — и сверяет ключи. Так расхождение становится
 * ошибкой сборки тестов, а не ошибкой на экране.
 */
/** Корень репозитория: файл лежит в `apps/web/src/lib/`. */
const repoRoot = resolve(__dirname, '../../../..');

/** Тело `assignments: { include: { ... } }` из карточки заказа на сервере. */
function serverAssignmentInclude(): { included: string[]; selected: string[] } {
  const source = readFileSync(
    resolve(repoRoot, 'apps/api/src/modules/orders/orders.service.ts'),
    'utf8',
  );

  const block = /assignments:\s*\{([\s\S]*?)\n  \},/.exec(source);
  if (block === null) throw new Error('Не найден блок assignments в ORDER_CARD_INCLUDE');

  // `m[1]` для группы обязателен, поэтому берём его через проверку: без этого
  // обращения компилятор справедливо считает значение `string | undefined`.
  const captured = (match: RegExpExecArray, group = 1): string => match[group] ?? '';

  const body = captured(block);
  const include = /include:\s*\{([\s\S]*?)\}/.exec(body);
  const includeBody = include === null ? '' : captured(include);
  const included = [...includeBody.matchAll(/(\w+):/g)].map((m) => captured(m));
  const selected = [...body.matchAll(/(\w+):\s*\{\s*select:/g)].map((m) => captured(m));

  return { included, selected };
}

/** Тело интерфейса `OrderAssignment` из типов интерфейса. */
function clientAssignmentFields(): string[] {
  const source = readFileSync(resolve(repoRoot, 'apps/web/src/lib/api-types.ts'), 'utf8');

  const block = /export interface OrderAssignment \{([\s\S]*?)\n\}/.exec(source);
  if (block === null) throw new Error('Не найден интерфейс OrderAssignment');

  // Только поля верхнего уровня: вложенные описаны на следующем уровне отступа.
  const body = block[1] ?? '';
  return [...body.matchAll(/^ {2}(\w+)[?]?:/gm)].map((m) => m[1] ?? '');
}

/** Ключи, которые Prisma отдаёт всегда, независимо от `include`/`select`. */
const SCALAR_FIELDS = [
  'id',
  'orderId',
  'performerId',
  'assignedById',
  'plannedHours',
  'startedAt',
  'finishedAt',
  'status',
  'comment',
  'createdAt',
];

describe('Форма ответа карточки заказа: назначения исполнителя', () => {
  it('сервер отдаёт связи performer и assignedBy вложенно', () => {
    /*
     * Проверка самого разбора серверной выборки: если он перестанет совпадать,
     * следующий тест провалится по непонятной причине. Здесь это видно прямо.
     */
    const { included, selected } = serverAssignmentInclude();

    expect(included).toContain('performer');
    expect(selected).toContain('assignedBy');
  });

  it('тип интерфейса описывает ВЛОЖЕННЫЕ связи, а не плоские поля', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА дефекта. Плоские `performerName`/`assignedByName` в
     * карточке не приходят — именно из-за них на экране был `undefined`.
     */
    const fields = clientAssignmentFields();

    expect(fields, 'performerName в карточке не приходит').not.toContain('performerName');
    expect(fields, 'assignedByName в карточке не приходит').not.toContain('assignedByName');
    expect(fields).toContain('performer');
    expect(fields).toContain('assignedBy');
  });

  it('тип содержит все скалярные поля, которые отдаёт карточка', () => {
    // Пропущенное поле — это снова `undefined` на экране, если его начнут читать.
    const fields = clientAssignmentFields();

    for (const field of SCALAR_FIELDS) {
      expect(fields, `поле ${field} отсутствует в OrderAssignment`).toContain(field);
    }
  });

  it('вложенные связи описаны как объекты, а не как строки', () => {
    /*
     * Если объявить `performer: string`, TypeScript пропустит обращение
     * `assignment.performer.fullName` только при `any`. Проверяем, что связи —
     * объекты: именно их поля читает интерфейс.
     */
    const source = readFileSync(resolve(repoRoot, 'apps/web/src/lib/api-types.ts'), 'utf8');
    const block = /export interface OrderAssignment \{([\s\S]*?)\n\}/.exec(source);
    expect(block).not.toBeNull();

    expect(block![1]).toMatch(/performer:\s*\{/);
    expect(block![1]).toMatch(/assignedBy:\s*\{/);
    // И внутри них — те поля, которые показывает карточка.
    expect(block![1]).toMatch(/fullName:\s*string/);
    expect(block![1]).toMatch(/specialization:\s*string \| null/);
  });
});
