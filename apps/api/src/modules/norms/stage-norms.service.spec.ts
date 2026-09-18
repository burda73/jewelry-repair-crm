/**
 * Тесты версионирования нормативов (задача 1.3.4, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Норматив определяет срок, который система обещает клиенту,
 * и по нему считается просрочка исполнителей. Поэтому проверяются правила,
 * которые схема валидации проверить не может, потому что они зависят от
 * состояния базы, — и каждая ошибка в них тихо портит сроки:
 *
 *  * вставка новой версии и её активация происходят в ОДНОЙ транзакции.
 *    Если деактивация прежней версии пройдёт, а вставка новой — нет, система
 *    останется без нормативов вообще, и сроки перестанут ставиться (это уже
 *    случалось: см. `order-workflow.service.spec.ts`);
 *  * порядок внутри транзакции — сначала вставка, потом переключение: при
 *    обратном порядке сбой вставки оставил бы систему без действующих норм;
 *  * неизвестный этап отклоняется: этап, которого нет в `NORM_STAGE`, никогда
 *    не будет найден расчётом, и норматив превратится в мёртвую строку —
 *    именно это и было причиной дефекта с ненайденными нормативами;
 *  * номер версии инкрементируется, а не переиспользуется: иначе по журналу
 *    нельзя объяснить срок уже принятого заказа.
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса, а не
 * поведение Postgres.
 */

import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { StageNormsService } from './stage-norms.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { DATA_SCOPE, ROLE } from '@app/shared';

const ADMIN_ID = 'cmu4cpwbg000bdl0ubltmh740';
const NORM_ID = 'cmu5p70yu0001bm7pzqlcawsw';

const ADMIN: AuthenticatedUser = {
  id: ADMIN_ID,
  email: 'admin@remixgold.ru',
  fullName: 'Администратор Системы',
  roles: [ROLE.ADMIN],
  primaryRole: ROLE.ADMIN,
  permissions: ['settings:manage'],
  scope: DATA_SCOPE.ALL_STORES,
  storeIds: [],
  mustChangePassword: false,
};

const normRow = (overrides: Record<string, unknown> = {}) => ({
  id: NORM_ID,
  version: 2,
  stage: 'QUEUE',
  workType: 'ANY',
  value: 24,
  unit: 'WORKHOUR',
  escalateToRole: null,
  isActive: true,
  effectiveFrom: new Date('2027-01-01T00:00:00Z'),
  approvedById: ADMIN_ID,
  approvedAt: new Date('2027-01-01T00:00:00Z'),
  createdAt: new Date('2027-01-01T00:00:00Z'),
  ...overrides,
});

/** Набор, проходящий схему: производство покрыто общим нормативом. */
const VALID_INPUT = {
  changeReason: 'Изменение норматива очереди на отправку',
  norms: [
    { stage: 'QUEUE', workType: 'ANY', value: 24, unit: 'WORKHOUR' },
    { stage: 'PRODUCTION', workType: 'ANY', value: 10, unit: 'WORKDAY' },
  ],
};

function createPrismaMock() {
  const tx = {
    stageNorm: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([normRow()]),
      createMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };

  const prisma = {
    stageNorm: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    runInTransaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    _tx: tx,
  };

  return prisma;
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  return new StageNormsService(prisma as never);
}

describe('StageNormsService: чтение', () => {
  it('нет действующих нормативов → null, а не выдуманные значения', async () => {
    const prisma = createPrismaMock();
    // Молчаливая подстановка «значений по умолчанию» скрыла бы состояние, в
    // котором сроки не рассчитываются вовсе.
    expect(await makeService(prisma).current()).toBeNull();
  });

  it('возвращает действующую версию с составом', async () => {
    const prisma = createPrismaMock();
    prisma.stageNorm.findFirst.mockResolvedValue(normRow());
    prisma.stageNorm.findMany.mockResolvedValue([normRow()]);

    const current = await makeService(prisma).current();

    expect(current?.version).toBe(2);
    expect(current?.isActive).toBe(true);
    expect(current?.norms).toHaveLength(1);
    expect(current?.norms[0]?.stage).toBe('QUEUE');
  });

  it('берёт самую новую действующую версию', async () => {
    const prisma = createPrismaMock();
    prisma.stageNorm.findFirst.mockResolvedValue(normRow({ version: 5 }));
    prisma.stageNorm.findMany.mockResolvedValue([normRow({ version: 5 })]);

    await makeService(prisma).current();

    expect(prisma.stageNorm.findFirst).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    });
  });

  it('история версий не содержит пустых записей', async () => {
    const prisma = createPrismaMock();
    expect(await makeService(prisma).versions()).toEqual([]);
  });

  it('история группирует строки по версиям, новые сверху', async () => {
    const prisma = createPrismaMock();
    prisma.stageNorm.findMany.mockResolvedValue([
      normRow({ version: 3, id: 'n3' }),
      normRow({ version: 2, id: 'n2', isActive: false }),
    ]);

    const versions = await makeService(prisma).versions();

    expect(versions.map((v) => v.version)).toEqual([3, 2]);
  });
});

describe('StageNormsService: создание версии', () => {
  it('инкрементирует номер версии, а не переиспользует существующий', async () => {
    const prisma = createPrismaMock();
    prisma._tx.stageNorm.findFirst.mockResolvedValue(normRow({ version: 4 }));

    await makeService(prisma).createVersion(VALID_INPUT, ADMIN);

    // Номер нужен, чтобы объяснить сроки уже принятых заказов по журналу.
    expect(prisma._tx.stageNorm.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ version: 5 })]),
      }),
    );
  });

  it('новая версия вставляется ДО деактивации прежней', async () => {
    const prisma = createPrismaMock();
    const calls: string[] = [];
    prisma._tx.stageNorm.createMany.mockImplementation(() => {
      calls.push('createMany');
    });
    prisma._tx.stageNorm.updateMany.mockImplementation(() => {
      calls.push('updateMany');
    });

    await makeService(prisma).createVersion(VALID_INPUT, ADMIN);

    // Порядок обязателен: при обратном сбое вставки система осталась бы без
    // действующих нормативов и сроки перестали бы ставиться.
    expect(calls[0]).toBe('createMany');
  });

  it('активирует новую версию и фиксирует автора', async () => {
    const prisma = createPrismaMock();
    prisma._tx.stageNorm.findFirst.mockResolvedValue(normRow({ version: 1 }));

    await makeService(prisma).createVersion(VALID_INPUT, ADMIN);

    const updateCalls = prisma._tx.stageNorm.updateMany.mock.calls;
    // Первый вызов — деактивация прежних, второй — активация новых.
    expect(updateCalls[0][0]).toMatchObject({
      where: { isActive: true },
      data: { isActive: false },
    });
    expect(updateCalls[1][0]).toMatchObject({
      where: { version: 2 },
      data: { isActive: true, approvedById: ADMIN_ID },
    });
  });

  it('пишет в журнал причину и состав версии', async () => {
    const prisma = createPrismaMock();
    await makeService(prisma).createVersion(VALID_INPUT, ADMIN);

    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      actorId: ADMIN_ID,
      actorRole: ROLE.ADMIN,
      action: 'CREATE',
      entity: 'StageNorm',
    });
    // Причина обязательна: норматив меняет сроки всех новых заказов.
    expect(audit.reason).toBe(VALID_INPUT.changeReason);
    expect((audit.after as { norms: unknown[] }).norms).toHaveLength(2);
  });

  it('ОТКЛОНЯЕТ неизвестный этап (это же проверяет схема, до обращения к базе)', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createVersion(
        {
          changeReason: 'Проверка',
          norms: [
            { stage: 'QUEUE', workType: 'ANY', value: 1, unit: 'WORKDAY' },
            { stage: 'DISPATCH', workType: 'ANY', value: 1, unit: 'WORKDAY' },
          ],
        },
        ADMIN,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('отклоняет дубликат «этап + тип работ»', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createVersion(
        {
          changeReason: 'Проверка дублей',
          norms: [
            { stage: 'QUEUE', workType: 'ANY', value: 1, unit: 'WORKDAY' },
            { stage: 'QUEUE', workType: 'ANY', value: 2, unit: 'WORKDAY' },
          ],
        },
        ADMIN,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('отклоняет производство только с одним типом работ', async () => {
    const prisma = createPrismaMock();
    // Иначе для одной из сложностей срок не найдётся, и заказ останется без dueAt.
    await expect(
      makeService(prisma).createVersion(
        {
          changeReason: 'Проверка покрытия',
          norms: [{ stage: 'PRODUCTION', workType: 'SIMPLE', value: 5, unit: 'WORKDAY' }],
        },
        ADMIN,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('принимает производство с обоими типами работ', async () => {
    const prisma = createPrismaMock();
    await makeService(prisma).createVersion(
      {
        changeReason: 'Разные сроки для простого и сложного ремонта',
        norms: [
          { stage: 'PRODUCTION', workType: 'SIMPLE', value: 5, unit: 'WORKDAY' },
          { stage: 'PRODUCTION', workType: 'COMPLEX', value: 15, unit: 'WORKDAY' },
        ],
      },
      ADMIN,
    );
    expect(prisma._tx.stageNorm.createMany).toHaveBeenCalled();
  });

  it('отклоняет пустой набор', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createVersion({ changeReason: 'Пустой набор', norms: [] }, ADMIN),
    ).rejects.toThrow(BadRequestException);
  });

  it('отклоняет причину короче пяти символов', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createVersion({ ...VALID_INPUT, changeReason: 'ок' }, ADMIN),
    ).rejects.toThrow(BadRequestException);
  });

  it('отклоняет неизвестную единицу измерения', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createVersion(
        {
          changeReason: 'Неизвестная единица',
          norms: [{ stage: 'QUEUE', workType: 'ANY', value: 5, unit: 'FORTNIGHT' }],
        },
        ADMIN,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('отклоняет недопустимо большие значения', async () => {
    const prisma = createPrismaMock();
    // «500 рабочих дней» вместо «5» — ошибка ввода: дешевле отклонить, чем
    // объяснять клиенту, почему заказ ждут два года.
    await expect(
      makeService(prisma).createVersion(
        {
          changeReason: 'Слишком большое значение',
          norms: [{ stage: 'QUEUE', workType: 'ANY', value: 5000, unit: 'WORKDAY' }],
        },
        ADMIN,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('тип работ по умолчанию — ANY', async () => {
    const prisma = createPrismaMock();
    await makeService(prisma).createVersion(
      {
        changeReason: 'Без указания типа работ',
        norms: [{ stage: 'QUEUE', value: 24, unit: 'WORKHOUR' }],
      },
      ADMIN,
    );

    const data = prisma._tx.stageNorm.createMany.mock.calls[0][0].data;
    expect(data[0].workType).toBe('ANY');
  });
});
