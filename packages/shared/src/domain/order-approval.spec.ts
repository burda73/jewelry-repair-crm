import { describe, expect, it } from 'vitest';
import {
  approvalCoverageMessage,
  checkApprovalCoverage,
  checkOrderRollback,
  isRollbackReason,
  rollbackReasonText,
  rollbackRejectMessage,
  rollbackTargets,
  type ApprovalCoverage,
} from './order-approval.js';

/**
 * Покрытие суммы заказа согласованием (требование заказчика).
 *
 * Согласование — договорённость о СУММЕ. Пока состав работ не менялся, проверка
 * «согласование есть» совпадает с проверкой «сумма согласована». Как только
 * работы дополнили, итог меняется, а запись остаётся — и заказ уходит в работу
 * с суммой, которую клиент не подтверждал. Снаружи это выглядит согласованным.
 */
describe('Покрытие суммы согласованием: совпадение сумм', () => {
  it('совпадающие суммы — согласование покрывает заказ', () => {
    const coverage = checkApprovalCoverage(120_000, 120_000);

    expect(coverage.ok).toBe(true);
    expect(coverage).toEqual({ ok: true, approvedMinor: 120_000 });
  });

  it('сумма выросла после согласования — согласование устарело', () => {
    /*
     * Главный случай требования: работы дополнили, итог вырос. Именно здесь
     * прежняя проверка «есть хоть одно согласование» пропускала заказ в работу.
     */
    const coverage = checkApprovalCoverage(120_000, 150_000);

    expect(coverage.ok).toBe(false);
    expect(coverage).toMatchObject({
      reason: 'STALE',
      approvedMinor: 120_000,
      totalMinor: 150_000,
    });
  });

  it('сумма снизилась — согласование тоже устарело', () => {
    /*
     * Удешевление тоже требует согласования: клиент подтвердил конкретную
     * сумму и срок, а уменьшение объёма меняет и то, и другое. «Стало дешевле,
     * значит, клиент не против» — это решение за клиента, а не за систему.
     */
    const coverage = checkApprovalCoverage(150_000, 120_000);

    expect(coverage.ok).toBe(false);
    expect(coverage).toMatchObject({ reason: 'STALE' });
  });

  it('согласований не было — это не «устарело», а «отсутствует»', () => {
    /*
     * Коды разные намеренно: сотруднику нужны РАЗНЫЕ действия. «Отсутствует» —
     * позвонить клиенту впервые; «устарело» — показать, что изменилось после
     * согласования. Один код на оба случая заставлял бы гадать.
     */
    const coverage = checkApprovalCoverage(null, 120_000);

    expect(coverage).toEqual({ ok: false, reason: 'MISSING' });
  });

  it('нулевая согласованная сумма отличается от отсутствия согласования', () => {
    /*
     * Клиент мог согласовать бесплатный ремонт (гарантийный случай) — это
     * ровно ноль, и это состоявшееся согласование. Приравнять ноль к `null`
     * значило бы требовать согласование там, где оно уже есть.
     */
    const covered = checkApprovalCoverage(0, 0);
    expect(covered.ok).toBe(true);

    const stale = checkApprovalCoverage(0, 50_000);
    expect(stale).toMatchObject({ reason: 'STALE', approvedMinor: 0 });
  });

  it('расхождение в одну копейку — уже расхождение', () => {
    // Сравнение строгое: сумма в копейках, дробных остатков не бывает, и
    // «почти совпало» здесь означало бы «итог не тот».
    expect(checkApprovalCoverage(120_000, 120_001).ok).toBe(false);
    expect(checkApprovalCoverage(120_001, 120_000).ok).toBe(false);
  });
});

describe('Покрытие суммы согласованием: объяснение сотруднику', () => {
  it('успешная проверка объясняется утвердительно', () => {
    expect(approvalCoverageMessage(checkApprovalCoverage(100, 100))).toContain('согласована');
  });

  it('отсутствие согласования названо прямо', () => {
    const message = approvalCoverageMessage(checkApprovalCoverage(null, 100));

    expect(message).toContain('Отсутствует согласование');
  });

  it('устаревшее согласование объясняет, что делать', () => {
    /*
     * Сообщение обязано подсказывать действие. «Ошибка» без объяснения
     * заставила бы сотрудника звонить в поддержку вместо клиента.
     */
    const message = approvalCoverageMessage(checkApprovalCoverage(100, 200));

    expect(message).toContain('устарело');
    expect(message).toContain('согласие клиента');
  });

  it('тексты трёх случаев не совпадают между собой', () => {
    /*
     * Если формулировки сольются, сотрудник не отличит «клиент ещё не
     * согласовывал» от «клиент согласовал другую сумму» — а это разные звонки.
     */
    const messages = [
      approvalCoverageMessage({ ok: true, approvedMinor: 1 }),
      approvalCoverageMessage({ ok: false, reason: 'MISSING' }),
      approvalCoverageMessage({ ok: false, reason: 'STALE', approvedMinor: 1, totalMinor: 2 }),
    ];

    expect(new Set(messages).size).toBe(3);
  });

  it('сообщение об устаревании не выдаёт сумму за согласованную', () => {
    // Формулировка не должна звучать как состоявшееся согласование: заказ
    // в работу не пойдёт, и текст не имеет права это скрывать.
    const coverage: ApprovalCoverage = {
      ok: false,
      reason: 'STALE',
      approvedMinor: 100,
      totalMinor: 200,
    };

    expect(approvalCoverageMessage(coverage)).not.toMatch(/^Сумма согласована/);
  });
});

/**
 * Откат заказа до состояния из истории (инструмент администратора).
 *
 * Откат ОБХОДИТ таблицу переходов, поэтому все её гарантии приходится проверять
 * заново. Ошибка здесь не проявляется отказом: она проявляется заказом в
 * состоянии, из которого нет выхода, или документом, противоречащим фактам.
 */
describe('Откат заказа: что можно и что нельзя', () => {
  const history = [
    { toStatus: 'DRAFT', at: new Date('2026-09-01T10:00:00Z') },
    { toStatus: 'ACCEPTED', at: new Date('2026-09-02T10:00:00Z') },
    { toStatus: 'IN_PRODUCTION', at: new Date('2026-09-03T10:00:00Z') },
  ];

  it('откат к ПРОЙДЕННОМУ состоянию разрешён', () => {
    const check = checkOrderRollback({
      currentStatus: 'IN_PRODUCTION',
      history,
      target: 'ACCEPTED',
      isFinal: false,
    });

    expect(check).toEqual({ ok: true, fromStatus: 'IN_PRODUCTION' });
  });

  it('откат к состоянию, которого НЕ БЫЛО, запрещён', () => {
    /*
     * Главная защита: без неё опечатка или подделанный запрос перевели бы заказ
     * в состояние, которого у него никогда не было, и «откат» стал бы
     * произвольной сменой статуса в обход таблицы переходов.
     */
    const check = checkOrderRollback({
      currentStatus: 'IN_PRODUCTION',
      history,
      target: 'READY_FOR_PICKUP',
      isFinal: false,
    });

    expect(check).toEqual({ ok: false, reason: 'NOT_IN_HISTORY' });
  });

  it('откат в ТЕКУЩЕЕ состояние запрещён', () => {
    // Запись в истории ни о чём сбивала бы подсчёт времени в статусах.
    const check = checkOrderRollback({
      currentStatus: 'ACCEPTED',
      history,
      target: 'ACCEPTED',
      isFinal: false,
    });

    expect(check).toEqual({ ok: false, reason: 'SAME_STATUS' });
  });

  it('закрытый заказ откатить нельзя', () => {
    /*
     * Выдача подтверждена подписью клиента и оплатой, отказ и отмена —
     * документами. «Раскрыть» закрытый заказ значило бы объявить эти документы
     * недействительными, не оформляя этого.
     */
    for (const currentStatus of ['COMPLETED', 'REFUSED', 'CANCELLED']) {
      const check = checkOrderRollback({
        currentStatus,
        history,
        target: 'ACCEPTED',
        isFinal: true,
      });

      expect(check, `статус ${currentStatus}`).toEqual({ ok: false, reason: 'ORDER_FINAL' });
    }
  });

  it('закрытость проверяется РАНЬШЕ истории', () => {
    /*
     * Порядок проверок важен для понятности отказа. Сотрудник, пытающийся
     * откатить выданный заказ, должен прочитать «заказ закрыт», а не «этого
     * состояния не было в истории».
     */
    const check = checkOrderRollback({
      currentStatus: 'COMPLETED',
      history,
      target: 'НЕТТАКОГО',
      isFinal: true,
    });

    expect(check).toEqual({ ok: false, reason: 'ORDER_FINAL' });
  });

  it('заказ без истории откатывать некуда', () => {
    const check = checkOrderRollback({
      currentStatus: 'DRAFT',
      history: [],
      target: 'ACCEPTED',
      isFinal: false,
    });

    expect(check).toEqual({ ok: false, reason: 'NO_HISTORY' });
  });

  it('каждый отказ объяснён сотруднику, тексты различны', () => {
    /*
     * Тексты обязаны различаться: действия сотрудника разные — раскрыть заказ
     * нельзя вообще, а «этого состояния не было» означает, что выбрана не та
     * строка истории.
     */
    const messages = (['ORDER_FINAL', 'SAME_STATUS', 'NO_HISTORY', 'NOT_IN_HISTORY'] as const).map(
      (reason) => rollbackRejectMessage(reason),
    );

    for (const message of messages) expect(message.length).toBeGreaterThan(15);
    expect(new Set(messages).size).toBe(4);
  });

  it('объяснение для закрытого заказа называет причину', () => {
    expect(rollbackRejectMessage('ORDER_FINAL')).toContain('подписью');
  });
});

describe('Откат заказа: список доступных состояний', () => {
  it('возвращаются пройденные состояния без текущего', () => {
    const targets = rollbackTargets(
      [
        { toStatus: 'DRAFT', at: new Date('2026-09-01T10:00:00Z') },
        { toStatus: 'ACCEPTED', at: new Date('2026-09-02T10:00:00Z') },
        { toStatus: 'IN_PRODUCTION', at: new Date('2026-09-03T10:00:00Z') },
      ],
      'IN_PRODUCTION',
    );

    // От новых к старым: так их показывает вкладка истории.
    expect(targets.map((t) => t.toStatus)).toEqual(['ACCEPTED', 'DRAFT']);
  });

  it('текущее состояние в списке отсутствует', () => {
    // Иначе первым пунктом предлагался бы откат в то же состояние — гарантированная ошибка.
    const targets = rollbackTargets(
      [{ toStatus: 'ACCEPTED', at: new Date('2026-09-02T10:00:00Z') }],
      'ACCEPTED',
    );

    expect(targets).toEqual([]);
  });

  it('повторные состояния не дублируются', () => {
    /*
     * Заказ может проходить один статус несколько раз (возврат из доработки).
     * Дубли в списке выглядели бы как разные пункты и сбивали бы с толку.
     */
    const targets = rollbackTargets(
      [
        { toStatus: 'IN_PRODUCTION', at: new Date('2026-09-01T10:00:00Z') },
        { toStatus: 'REWORK', at: new Date('2026-09-02T10:00:00Z') },
        { toStatus: 'IN_PRODUCTION', at: new Date('2026-09-03T10:00:00Z') },
      ],
      'WORK_COMPLETED',
    );

    expect(targets.map((t) => t.toStatus)).toEqual(['IN_PRODUCTION', 'REWORK']);
  });

  it('список упорядочен от новых к старым', () => {
    const targets = rollbackTargets(
      [
        { toStatus: 'DRAFT', at: new Date('2026-09-01T10:00:00Z') },
        { toStatus: 'QUEUED_FOR_DISPATCH', at: new Date('2026-09-05T10:00:00Z') },
        { toStatus: 'ACCEPTED', at: new Date('2026-09-03T10:00:00Z') },
      ],
      'IN_PRODUCTION',
    );

    expect(targets.map((t) => t.toStatus)).toEqual(['QUEUED_FOR_DISPATCH', 'ACCEPTED', 'DRAFT']);
  });
});

/**
 * Пометка отката в ленте событий.
 *
 * Причина отката хранится строкой в `OrderStatusHistory.reason`, и по ней лента
 * понимает, что произошёл откат. Это КОНТРАКТ между сервисом отката и лентой:
 * расхождение в формате («Откат.» вместо «Откат:») не сломает запись, но лента
 * перестанет различать откаты, и заметить это будет нечем — сотрудник увидит
 * обычное «Статус: Заказ принят» там, где правила переходов были обойдены.
 */
describe('Пометка отката: контракт между сервисом и лентой', () => {
  it('причина отката распознаётся', () => {
    expect(isRollbackReason(rollbackReasonText('Ошибочно переведён в работу'))).toBe(true);
  });

  it('обычный переход откатом не считается', () => {
    // Причина штатного перехода (например, возврата на очередь) не должна
    // выглядеть как откат: это разные события.
    expect(isRollbackReason('Вернуть в очередь: нужны запчасти')).toBe(false);
    expect(isRollbackReason(null)).toBe(false);
    expect(isRollbackReason(undefined)).toBe(false);
    expect(isRollbackReason('')).toBe(false);
  });

  it('причина сохранена целиком и без лишних пробелов', () => {
    // Текст причины читают люди: обрезать или переформатировать его нельзя.
    expect(rollbackReasonText('  Ошибочно переведён в работу  ')).toBe(
      'Откат: Ошибочно переведён в работу',
    );
  });

  it('распознавание и формирование согласованы', () => {
    /*
     * Главная проверка контракта: любая причина, созданная для записи, обязана
     * распознаваться. Если формат пометки изменят в одном месте и забудут в
     * другом, лента молча перестанет помечать откаты.
     */
    for (const reason of ['Проверка', 'Заказ ошибочно переведён', 'тест']) {
      expect(isRollbackReason(rollbackReasonText(reason)), `причина «${reason}»`).toBe(true);
    }
  });
});
