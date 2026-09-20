import { describe, expect, it } from 'vitest';
import {
  approvalCoverageMessage,
  checkApprovalCoverage,
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
