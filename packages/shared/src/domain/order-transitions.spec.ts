/**
 * Тесты статусной модели. Проверяют, что таблица переходов из
 * packages/shared/src/domain/order-transitions.ts соответствует
 * docs/04-status-workflow.md §2, и что запрещённые переходы отклоняются.
 */

import { describe, expect, it } from 'vitest';
import { ORDER_STATUS, type OrderStatus, isTerminalStatus, ALL_ORDER_STATUSES } from './order-status.js';
import {
  ORDER_TRANSITIONS,
  GUARD,
  checkTransition,
  availableTransitions,
  findTransition,
} from './order-transitions.js';
import { ROLE } from './roles.js';

describe('Статусная модель: целостность', () => {
  it('содержит ровно 22 перехода, как в docs/04-status-workflow.md §2', () => {
    expect(ORDER_TRANSITIONS).toHaveLength(22);
  });

  it('идентификаторы переходов уникальны и идут по порядку 1..22', () => {
    const ids = ORDER_TRANSITIONS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
  });

  it('нет дублирующихся пар «из → в»', () => {
    const pairs = ORDER_TRANSITIONS.map((t) => `${t.from ?? 'CREATE'}->${t.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('каждый переход имеет хотя бы одного исполнителя', () => {
    for (const rule of ORDER_TRANSITIONS) {
      expect(rule.actors.length, `переход #${rule.id}`).toBeGreaterThan(0);
    }
  });

  it('каждый переход с требованием причины имеет guard REASON_REQUIRED', () => {
    for (const rule of ORDER_TRANSITIONS) {
      if (rule.requiresReason) {
        expect(rule.guards, `переход #${rule.id}`).toContain(GUARD.REASON_REQUIRED);
      }
    }
  });

  it('все статусы участвуют хотя бы в одном переходе', () => {
    const involved = new Set<OrderStatus>();
    for (const rule of ORDER_TRANSITIONS) {
      if (rule.from) involved.add(rule.from);
      involved.add(rule.to);
    }
    const unused = ALL_ORDER_STATUSES.filter((s) => !involved.has(s));
    expect(unused).toEqual([]);
  });

  it('из терминальных статусов нет исходящих переходов', () => {
    for (const rule of ORDER_TRANSITIONS) {
      if (rule.from && isTerminalStatus(rule.from)) {
        throw new Error(`Из терминального статуса ${rule.from} объявлен переход #${rule.id}`);
      }
    }
  });
});

describe('Проверка переходов', () => {
  it('создание заказа разрешено приёмщику', () => {
    const result = checkTransition({ from: null, to: ORDER_STATUS.DRAFT, actorRole: ROLE.RECEIVER });
    expect(result.allowed).toBe(true);
  });

  it('создание заказа запрещено логисту', () => {
    const result = checkTransition({ from: null, to: ORDER_STATUS.DRAFT, actorRole: ROLE.LOGISTICIAN });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('FORBIDDEN_ROLE');
  });

  it('несуществующий переход отклоняется как INVALID_TRANSITION', () => {
    // «Прыжок» через этап: черновик сразу в производство.
    const result = checkTransition({
      from: ORDER_STATUS.DRAFT,
      to: ORDER_STATUS.IN_PRODUCTION,
      actorRole: ROLE.ADMIN,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('INVALID_TRANSITION');
  });

  it('переход из терминального статуса отклоняется с TERMINAL_STATE', () => {
    const result = checkTransition({
      from: ORDER_STATUS.COMPLETED,
      to: ORDER_STATUS.IN_PRODUCTION,
      actorRole: ROLE.ADMIN,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('TERMINAL_STATE');
  });

  it('отмена без причины отклоняется', () => {
    const result = checkTransition({
      from: ORDER_STATUS.AWAITING_APPROVAL,
      to: ORDER_STATUS.CANCELLED,
      actorRole: ROLE.RECEIVER,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('REASON_REQUIRED');
  });

  it('отмена без причины отклоняется даже для администратора', () => {
    const result = checkTransition({
      from: ORDER_STATUS.AWAITING_APPROVAL,
      to: ORDER_STATUS.CANCELLED,
      actorRole: ROLE.ADMIN,
      reason: '  ',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('REASON_REQUIRED');
  });

  it('отмена с причиной разрешена приёмщику', () => {
    const result = checkTransition({
      from: ORDER_STATUS.AWAITING_APPROVAL,
      to: ORDER_STATUS.CANCELLED,
      actorRole: ROLE.RECEIVER,
      reason: 'Клиент передумал, изделие забрал',
    });
    expect(result.allowed).toBe(true);
  });

  it('выдача разрешена приёмщику и кассиру', () => {
    for (const role of [ROLE.RECEIVER, ROLE.CASHIER]) {
      const result = checkTransition({
        from: ORDER_STATUS.READY_FOR_PICKUP,
        to: ORDER_STATUS.COMPLETED,
        actorRole: role,
      });
      expect(result.allowed, `роль ${role}`).toBe(true);
    }
  });

  it('переход в UNCLAIMED доступен только системе', () => {
    const byHuman = checkTransition({
      from: ORDER_STATUS.READY_FOR_PICKUP,
      to: ORDER_STATUS.UNCLAIMED,
      actorRole: ROLE.RECEIVER,
    });
    expect(byHuman.allowed).toBe(false);

    const bySystem = checkTransition({
      from: ORDER_STATUS.READY_FOR_PICKUP,
      to: ORDER_STATUS.UNCLAIMED,
      actorRole: 'SYSTEM',
    });
    expect(bySystem.allowed).toBe(true);
  });

  it('администратор может выполнить переход, не входящий в его роли по таблице', () => {
    // Администратор обходит проверку роли, но не проверку причины.
    const result = checkTransition({
      from: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
      to: ORDER_STATUS.IN_PRODUCTION,
      actorRole: ROLE.ADMIN,
    });
    expect(result.allowed).toBe(true);
  });
});

describe('Доступные переходы для UI', () => {
  it('приёмщик в статусе READY_FOR_PICKUP видит выдачу, отказ и не видит невостребовано', () => {
    const rules = availableTransitions(ORDER_STATUS.READY_FOR_PICKUP, ROLE.RECEIVER);
    const targets = rules.map((r) => r.to);
    expect(targets).toContain(ORDER_STATUS.COMPLETED);
    expect(targets).toContain(ORDER_STATUS.REFUSED);
    expect(targets).not.toContain(ORDER_STATUS.UNCLAIMED);
  });

  it('в терминальном статусе нет доступных переходов', () => {
    expect(availableTransitions(ORDER_STATUS.COMPLETED, ROLE.ADMIN)).toEqual([]);
    expect(availableTransitions(ORDER_STATUS.CANCELLED, ROLE.ADMIN)).toEqual([]);
  });

  it('менеджер производства не может создать заказ', () => {
    const rules = availableTransitions(null, ROLE.PRODUCTION_MANAGER);
    expect(rules).toEqual([]);
  });

  it('каждый доступный переход имеет человекочитаемую подпись', () => {
    for (const rule of ORDER_TRANSITIONS) {
      expect(rule.label.length, `переход #${rule.id}`).toBeGreaterThan(3);
    }
  });
});

describe('findTransition', () => {
  it('находит создание заказа по from = null', () => {
    expect(findTransition(null, ORDER_STATUS.DRAFT)?.id).toBe(1);
  });

  it('возвращает undefined для несуществующего перехода', () => {
    expect(findTransition(ORDER_STATUS.DRAFT, ORDER_STATUS.COMPLETED)).toBeUndefined();
  });
});