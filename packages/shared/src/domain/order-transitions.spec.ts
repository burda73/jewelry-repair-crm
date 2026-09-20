/**
 * Тесты статусной модели. Проверяют, что таблица переходов из
 * packages/shared/src/domain/order-transitions.ts соответствует
 * docs/04-status-workflow.md §2, и что запрещённые переходы отклоняются.
 */

import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUS,
  type OrderStatus,
  isTerminalStatus,
  ALL_ORDER_STATUSES,
} from './order-status.js';
import {
  ORDER_TRANSITIONS,
  GUARD,
  checkTransition,
  availableTransitions,
  findTransition,
} from './order-transitions.js';
import { ROLE } from './roles.js';

describe('Статусная модель: целостность', () => {
  it('содержит 29 переходов: 22 базовых (docs/04 §2) и 7 этапа производства (§2.1)', () => {
    /*
     * 1–22 — базовые переходы таблицы §2; 23–29 — распределение работы, возврат
     * без работ, приём партии цехом и закрытие отказа клиента (задачи 7.3, 7.9).
     * Они описаны в docs/04-status-workflow.md §2.1, а не в таблице §2: та
     * построчно сверяется с кодом тестом `docs-sync.spec.ts`, и нереализованные
     * переходы в ней лишили бы стража силы.
     */
    expect(ORDER_TRANSITIONS).toHaveLength(29);
  });

  it('идентификаторы переходов уникальны и покрывают 1..29', () => {
    const ids = ORDER_TRANSITIONS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
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
    const result = checkTransition({
      from: null,
      to: ORDER_STATUS.DRAFT,
      actorRole: ROLE.RECEIVER,
    });
    expect(result.allowed).toBe(true);
  });

  it('создание заказа запрещено логисту', () => {
    const result = checkTransition({
      from: null,
      to: ORDER_STATUS.DRAFT,
      actorRole: ROLE.LOGISTICIAN,
    });
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

describe('Мультироль: переходы учитывают ВЕСЬ набор ролей (задача 7.7)', () => {
  /**
   * РЕАЛЬНЫЙ РАЗРЫВ, найденный при вводе второй роли. Мультироль в системе
   * поддержана (`UserRole[]`, права объединяются), но переходы сверялись только
   * с `primaryRole` — ролью, которая в наборе первая. Приёмщик, которому выдали
   * ВТОРУЮ роль логиста (решение заказчика: «где приняли, там и выдаём»), не мог
   * отправить партию в цех: `primaryRole` остаётся `RECEIVER`, а правило 11
   * допускает `PRODUCTION_MANAGER`/`LOGISTICIAN`.
   *
   * Дефект коварный: право `logistics:manage` у сотрудника ЕСТЬ, интерфейс
   * раздел показывает, партию создать даёт — и только последний шаг падал с
   * `FORBIDDEN_ROLE`. Выданная роль не давала ничего, а причина выглядела как
   * «что-то не так с правами», а не как дефект проверки роли.
   */
  const RECEIVER_AND_LOGISTICIAN = [ROLE.RECEIVER, ROLE.LOGISTICIAN] as const;

  it('приёмщик со второй ролью логиста может отправить партию в цех', () => {
    const result = checkTransition({
      from: ORDER_STATUS.QUEUED_FOR_DISPATCH,
      to: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
      actorRole: ROLE.RECEIVER,
      actorRoles: RECEIVER_AND_LOGISTICIAN,
    });
    expect(result.allowed).toBe(true);
  });

  it('без второй роли тот же переход по-прежнему закрыт', () => {
    // Обратная половина: исправление не должно открыть переход всем приёмщикам.
    const result = checkTransition({
      from: ORDER_STATUS.QUEUED_FOR_DISPATCH,
      to: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
      actorRole: ROLE.RECEIVER,
      actorRoles: [ROLE.RECEIVER],
    });
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.code).toBe('FORBIDDEN_ROLE');
  });

  it('если набор ролей не задан, проверяется только actorRole', () => {
    // Системные переходы и внутренние вызовы передают одну роль: поведение
    // не должно измениться.
    const result = checkTransition({
      from: ORDER_STATUS.QUEUED_FOR_DISPATCH,
      to: ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION,
      actorRole: ROLE.RECEIVER,
    });
    expect(result.allowed).toBe(false);
  });

  it('список действий в UI совпадает с фактически разрешёнными переходами', () => {
    /*
     * Расхождение дало бы кнопку, которая видна, но не работает. Проверяются
     * ОБА направления: список не должен ни терять доступное действие, ни
     * показывать недоступное.
     */
    const rules = availableTransitions(
      ORDER_STATUS.QUEUED_FOR_DISPATCH,
      ROLE.RECEIVER,
      RECEIVER_AND_LOGISTICIAN,
    );
    expect(rules.map((r) => r.to)).toContain(ORDER_STATUS.IN_TRANSIT_TO_PRODUCTION);

    for (const rule of rules) {
      const check = checkTransition({
        from: ORDER_STATUS.QUEUED_FOR_DISPATCH,
        to: rule.to,
        actorRole: ROLE.RECEIVER,
        actorRoles: RECEIVER_AND_LOGISTICIAN,
      });
      expect(check.allowed, `показанный переход ${rule.label} должен быть разрешён`).toBe(true);
    }
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

/**
 * Выдача заказа БЕЗ подписи клиента (решение заказчика).
 *
 * ИСТОРИЯ. Переходы 18 и 21 (в «Выдан») охранялись условием `PICKUP_SIGNATURE`:
 * без загруженного росчерка выдача отклонялась с `409
 * PICKUP_SIGNATURE_REQUIRED`. Заказчик решил, что подпись не должна блокировать
 * выдачу, — требование снято. Возможность приложить подпись осталась
 * необязательной отметкой о получении.
 *
 * Проверка важна именно на уровне ТАБЛИЦЫ переходов: если условие вернут сюда,
 * выдача снова начнёт требовать росчерк, причём незаметно — интерфейс поле
 * подписи уже предлагает как необязательное, и сотрудник упрётся в отказ на
 * последнем шаге, когда клиент стоит у стойки.
 */
describe('Выдача заказа: подпись клиента не требуется', () => {
  /** Переходы в «Выдан»: из «Готов к выдаче» и из «Невостребованного». */
  const handover = ORDER_TRANSITIONS.filter((rule) => rule.to === ORDER_STATUS.COMPLETED);

  it('переходы в «Выдан» существуют', () => {
    // Проверка самого отбора: пустой список сделал бы остальное бессмысленным.
    expect(handover.length).toBeGreaterThanOrEqual(2);
  });

  it('ни один переход в «Выдан» не проверяет подпись', () => {
    /*
     * ГЛАВНАЯ проверка снятия требования.
     */
    for (const rule of handover) {
      expect(rule.guards, `переход ${rule.id} (${rule.from} → ${rule.to})`).not.toContain(
        'PICKUP_SIGNATURE',
      );
    }
  });

  it('полная оплата по-прежнему обязательна', () => {
    /*
     * Снятие требования подписи не должно было ослабить единственное оставшееся
     * условие выдачи: деньги проверяет система, и выдать неоплаченный заказ
     * нельзя.
     */
    for (const rule of handover) {
      expect(rule.guards, `переход ${rule.id}`).toContain('PAID_IN_FULL');
    }
  });

  it('условие подписи не используется НИ ОДНИМ переходом', () => {
    /*
     * Если его вернут в любой переход, это снова заблокирует выдачу — а поле в
     * интерфейсе необязательное, и понять причину отказа будет нечем.
     */
    const withSignature = ORDER_TRANSITIONS.filter((rule) =>
      rule.guards.includes('PICKUP_SIGNATURE'),
    );

    expect(withSignature.map((rule) => `${rule.id}: ${rule.from} → ${rule.to}`)).toEqual([]);
  });
});
