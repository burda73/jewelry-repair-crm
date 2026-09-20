/**
 * Тесты рабочего календаря (задача 1.3.3, ТЗ п. 2.7 и 2.9).
 *
 * ЗАЧЕМ ЭТИ ТЕСТЫ. Календарь определяет сроки, которые система обещает клиенту.
 * Дефект, ради которого сделана задача, был не в расчёте, а в ДАННЫХ: `seed`
 * заполнял таблицу зеркалом правила «работают только пн–пт», среди этих строк
 * были праздники среди недели, помеченные рабочими, а запись из базы приоритетнее
 * встроенного списка праздников. Поэтому срок попадал на 1 января.
 *
 * Отсюда два главных требования, которые проверяются здесь:
 *  1. запись, повторяющую обычное правило, создать нельзя — иначе дефект вернётся
 *     через интерфейс администратора;
 *  2. снятие записи пишется в журнал, потому что действие меняет сроки заказов.
 *
 * Prisma подменяется управляемым двойником: проверяются правила сервиса, а не
 * поведение Postgres. Двойник намеренно реализует `delete` — в отличие от
 * справочников, здесь удаление разрешено осознанно (на строку календаря нет
 * внешних ключей).
 */

import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { WorkingCalendarService, isRedundantDay } from './working-calendar.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { DATA_SCOPE, ROLE } from '@app/shared';

const ADMIN_ID = 'cmu4cpwbg000bdl0ubltmh740';
const DAY_ID = 'cmu5p70yu0001bm7pzqlcawsw';

const ADMIN: AuthenticatedUser = {
  id: ADMIN_ID,
  email: 'admin@remixgold.ru',
  fullName: 'Администратор Системы',
  roles: [ROLE.ADMIN],
  primaryRole: ROLE.ADMIN,
  permissions: ['settings:manage'],
  scope: DATA_SCOPE.ALL_STORES,
  scopes: [DATA_SCOPE.ALL_STORES],
  storeIds: [],
  mustChangePassword: false,
};

/** 1 января 2027 — праздник и пятница: раньше именно такие дни помечались рабочими. */
const NEW_YEAR_2027 = new Date('2027-01-01T00:00:00Z');
/** 4 января 2027 — понедельник, но праздник: рабочим быть не должен. */
const NEW_YEAR_MONDAY_2027 = new Date('2027-01-04T00:00:00Z');
/** 12 января 2027 — вторник, обычный рабочий день. */
const ORDINARY_TUESDAY_2027 = new Date('2027-01-12T00:00:00Z');
/** 16 января 2027 — суббота, обычный выходной. */
const ORDINARY_SATURDAY_2027 = new Date('2027-01-16T00:00:00Z');
/** 17 сентября 2027 — пятница, обычный рабочий день. */
const ORDINARY_FRIDAY_2027 = new Date('2027-09-17T00:00:00Z');

const dayRow = (overrides: Record<string, unknown> = {}) => ({
  id: DAY_ID,
  storeId: null,
  date: NEW_YEAR_MONDAY_2027,
  isWorkday: false,
  hours: 0,
  note: null,
  ...overrides,
});

function createPrismaMock() {
  const tx = {
    workingCalendar: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };

  const prisma = {
    workingCalendar: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    runInTransaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    _tx: tx,
  };

  return prisma;
}

function makeService(prisma: ReturnType<typeof createPrismaMock>) {
  return new WorkingCalendarService(prisma as never);
}

describe('isRedundantDay: распознавание записей, ничего не меняющих', () => {
  it('будний день с обычными часами — зеркало', () => {
    // Именно такие строки создавал seed и именно они перекрывали праздники.
    expect(isRedundantDay(ORDINARY_TUESDAY_2027, true, 8)).toBe(true);
  });

  it('выходной с нулём часов — зеркало', () => {
    expect(isRedundantDay(ORDINARY_SATURDAY_2027, false, 0)).toBe(true);
  });

  it('праздник среди недели, объявленный рабочим, зеркалом НЕ является', () => {
    // 4 января 2027 — понедельник. Правило считает его рабочим, но это праздник,
    // поэтому запись «рабочий» здесь — исключение, а не зеркало.
    expect(isRedundantDay(NEW_YEAR_MONDAY_2027, true, 8)).toBe(false);
  });

  it('праздник, объявленный выходным, тоже зеркало: правило и так даёт выходной', () => {
    // Правило «праздник нерабочий» уже даёт этот результат, поэтому запись
    // «праздник — выходной» бесполезна (и вредна: она мешает позже объявить
    // праздник рабочим, потому что на дату уже есть строка).
    expect(isRedundantDay(NEW_YEAR_MONDAY_2027, false, 0)).toBe(true);
  });

  it('особые часы — не зеркало, даже в будний день', () => {
    expect(isRedundantDay(ORDINARY_TUESDAY_2027, true, 4)).toBe(false);
  });

  it('рабочая суббота — не зеркало', () => {
    expect(isRedundantDay(ORDINARY_SATURDAY_2027, true, 8)).toBe(false);
  });
});

describe('WorkingCalendarService: чтение', () => {
  it('отдаёт праздники отдельно от записей', async () => {
    const prisma = createPrismaMock();
    const result = await makeService(prisma).list({ from: '2027-01-01', to: '2027-01-31' });

    // Записей нет, но праздники есть: администратор должен видеть, что 1–8 января
    // нерабочие и без строк в таблице.
    expect(result.days).toEqual([]);
    expect(result.holidays).toHaveLength(8);
    expect(result.holidays[0]).toBe('2027-01-01');
  });

  it('помечает праздник и зеркальность у записи', async () => {
    const prisma = createPrismaMock();
    // Историческая строка-зеркало: вторник объявлен рабочим.
    prisma.workingCalendar.findMany.mockResolvedValue([
      {
        id: DAY_ID,
        storeId: null,
        date: ORDINARY_TUESDAY_2027,
        isWorkday: true,
        hours: 8,
        note: null,
      },
    ]);

    const result = await makeService(prisma).list({ from: '2027-01-01', to: '2027-01-31' });

    expect(result.days[0].redundant).toBe(true);
    expect(result.days[0].isHoliday).toBe(false);
  });

  it('запрос без периода отклоняется', async () => {
    const prisma = createPrismaMock();
    await expect(makeService(prisma).list({})).rejects.toThrow(BadRequestException);
  });

  it('период больше года отклоняется', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).list({ from: '2027-01-01', to: '2029-01-01' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('перевёрнутый период отклоняется', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).list({ from: '2027-02-01', to: '2027-01-01' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('несуществующая дата отклоняется', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).list({ from: '2027-02-31', to: '2027-03-01' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('сводка считает рабочие дни и праздники по правилу и коду', async () => {
    const prisma = createPrismaMock();
    // Январь 2027: 1–8 праздники. Проверяем, что они не попали в рабочие дни.
    const summary = await makeService(prisma).summary({ from: '2027-01-01', to: '2027-01-31' });
    expect(summary).toHaveLength(1);
    expect(summary[0].month).toBe('2027-01');
    // 31 день − 8 праздников − выходные (9,10,16,17,23,24,30,31) = 15 рабочих.
    expect(summary[0].holidays).toBe(16);
    expect(summary[0].workdays).toBe(15);
  });

  it('сводка учитывает исключения администратора', async () => {
    const prisma = createPrismaMock();
    // 16 января (суббота) объявлена рабочей — рабочий день должен прибавиться.
    prisma.workingCalendar.findMany.mockResolvedValue([
      { date: ORDINARY_SATURDAY_2027, isWorkday: true, hours: 8 },
    ]);
    const summary = await makeService(prisma).summary({ from: '2027-01-16', to: '2027-01-17' });
    expect(summary[0].workdays).toBe(1);
    expect(summary[0].holidays).toBe(1);
  });
});

describe('WorkingCalendarService: создание', () => {
  it('создаёт исключение и пишет в журнал в той же транзакции', async () => {
    const prisma = createPrismaMock();
    // Настоящее исключение: 4 января 2027 (понедельник, праздник) объявлено
    // РАБОЧИМ — магазин работает в каникулы.
    prisma._tx.workingCalendar.create.mockResolvedValue(dayRow({ isWorkday: true, hours: 8 }));

    const created = await makeService(prisma).createDay(
      { date: '2027-01-04', isWorkday: true },
      ADMIN,
    );

    expect(created.date).toBe('2027-01-04');
    expect(prisma._tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      actorId: ADMIN_ID,
      action: 'CREATE',
      entity: 'WorkingCalendar',
      entityId: DAY_ID,
    });
    // У создания нет «до»: поле отсутствует, а не равно `Prisma.JsonNull`.
    expect(audit.before).toBeUndefined();
  });

  it('ЗАПРЕЩАЕТ создавать зеркальную запись', async () => {
    // Главная защита от возврата дефекта: 12 января 2027 — обычный вторник,
    // запись «рабочий, 8 часов» ничего не меняет, но перекрыла бы праздник,
    // если бы дата была праздничной.
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createDay({ date: '2027-01-12', isWorkday: true }, ADMIN),
    ).rejects.toThrow(BadRequestException);
    expect(prisma._tx.workingCalendar.create).not.toHaveBeenCalled();
  });

  it('запрещает зеркальный выходной', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createDay({ date: '2027-01-16', isWorkday: false }, ADMIN),
    ).rejects.toThrow(BadRequestException);
  });

  it('разрешает объявить рабочим праздник среди недели', async () => {
    // Магазин работает в каникулы: 4 января 2027 — понедельник и праздник.
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.create.mockResolvedValue(
      dayRow({ date: NEW_YEAR_MONDAY_2027, isWorkday: true, hours: 8 }),
    );

    const created = await makeService(prisma).createDay(
      { date: '2027-01-04', isWorkday: true },
      ADMIN,
    );
    expect(created.isWorkday).toBe(true);
    // Часы подставляются: «рабочий день 0 часов» получиться не должно.
    expect(prisma._tx.workingCalendar.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hours: 8 }) }),
    );
  });

  it('разрешает объявить выходным рабочий день', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.create.mockResolvedValue(
      dayRow({ date: ORDINARY_FRIDAY_2027, isWorkday: false, hours: 0 }),
    );
    await makeService(prisma).createDay({ date: '2027-09-17', isWorkday: false }, ADMIN);
    expect(prisma._tx.workingCalendar.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hours: 0 }) }),
    );
  });

  it('разрешает особые часы в будний день', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.create.mockResolvedValue(
      dayRow({ date: ORDINARY_TUESDAY_2027, isWorkday: true, hours: 4 }),
    );
    await makeService(prisma).createDay({ date: '2027-01-12', isWorkday: true, hours: 4 }, ADMIN);
    expect(prisma._tx.workingCalendar.create).toHaveBeenCalled();
  });

  it('отклоняет повторную запись на ту же дату', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findFirst.mockResolvedValue(dayRow({ isWorkday: true, hours: 8 }));
    await expect(
      makeService(prisma).createDay({ date: '2027-01-04', isWorkday: true }, ADMIN),
    ).rejects.toThrow(ConflictException);
  });

  it('отклоняет противоречивые часы: «рабочий день 0 часов»', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createDay({ date: '2027-01-04', isWorkday: true, hours: 0 }, ADMIN),
    ).rejects.toThrow(BadRequestException);
  });

  it('отклоняет противоречивые часы: «выходной 8 часов»', async () => {
    const prisma = createPrismaMock();
    await expect(
      makeService(prisma).createDay({ date: '2027-01-04', isWorkday: false, hours: 8 }, ADMIN),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('WorkingCalendarService: изменение', () => {
  it('меняет часы и пишет «до» и «после» в журнал', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findUnique.mockResolvedValue(
      dayRow({ date: ORDINARY_TUESDAY_2027, isWorkday: true, hours: 8 }),
    );
    prisma._tx.workingCalendar.update.mockResolvedValue(
      dayRow({ date: ORDINARY_TUESDAY_2027, isWorkday: true, hours: 4 }),
    );

    await makeService(prisma).updateDay(DAY_ID, { hours: 4 }, ADMIN);

    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('UPDATE');
    expect((audit.before as { hours: number }).hours).toBe(8);
    expect((audit.after as { hours: number }).hours).toBe(4);
  });

  it('смена «выходной → рабочий» подставляет обычные часы', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findUnique.mockResolvedValue(
      dayRow({ date: NEW_YEAR_MONDAY_2027, isWorkday: false, hours: 0 }),
    );
    prisma._tx.workingCalendar.update.mockResolvedValue(
      dayRow({ date: NEW_YEAR_MONDAY_2027, isWorkday: true, hours: 8 }),
    );

    await makeService(prisma).updateDay(DAY_ID, { isWorkday: true }, ADMIN);

    // Оставить 0 нельзя: получился бы «рабочий день 0 часов».
    expect(prisma._tx.workingCalendar.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hours: 8 }) }),
    );
  });

  it('смена «рабочий → выходной» обнуляет часы', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findUnique.mockResolvedValue(
      dayRow({ date: ORDINARY_TUESDAY_2027, isWorkday: true, hours: 8 }),
    );
    prisma._tx.workingCalendar.update.mockResolvedValue(
      dayRow({ date: ORDINARY_TUESDAY_2027, isWorkday: false, hours: 0 }),
    );

    await makeService(prisma).updateDay(DAY_ID, { isWorkday: false }, ADMIN);

    expect(prisma._tx.workingCalendar.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hours: 0 }) }),
    );
  });

  it('ЗАПРЕЩАЕТ превращать запись в зеркало', async () => {
    // Праздник объявили рабочим, потом решили вернуть как было: правильный
    // путь — снять отметку, а не записать «как по правилу», иначе строка
    // останется и будет скрывать праздник.
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findUnique.mockResolvedValue(
      dayRow({ date: NEW_YEAR_MONDAY_2027, isWorkday: true, hours: 8 }),
    );

    await expect(
      makeService(prisma).updateDay(DAY_ID, { isWorkday: false }, ADMIN),
    ).rejects.toThrow(BadRequestException);
  });

  it('запрещает перенос записи на занятую дату', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findUnique.mockResolvedValue(
      dayRow({ date: NEW_YEAR_MONDAY_2027, isWorkday: true, hours: 8 }),
    );
    prisma._tx.workingCalendar.findFirst.mockResolvedValue({ id: 'other' });

    // Переносим запись с 4 на 5 января — оба дня праздники и объявлены
    // рабочими (исключения), поэтому проверка доходит до конфликта дат,
    // а не отклоняется раньше как «ничего не меняющая» запись.
    await expect(
      makeService(prisma).updateDay(DAY_ID, { date: '2027-01-05' }, ADMIN),
    ).rejects.toThrow(ConflictException);
  });

  it('несуществующая запись даёт понятную ошибку', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findUnique.mockResolvedValue(null);
    await expect(makeService(prisma).updateDay(DAY_ID, { hours: 4 }, ADMIN)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('пустой запрос на изменение отклоняется', async () => {
    const prisma = createPrismaMock();
    await expect(makeService(prisma).updateDay(DAY_ID, {}, ADMIN)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('WorkingCalendarService: снятие отметки', () => {
  it('удаляет запись и сохраняет прежнее значение в журнале', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findUnique.mockResolvedValue(dayRow({ isWorkday: true, hours: 8 }));

    const result = await makeService(prisma).deleteDay(DAY_ID, ADMIN);

    expect(result).toEqual({ removed: true });
    expect(prisma._tx.workingCalendar.delete).toHaveBeenCalledWith({ where: { id: DAY_ID } });
    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ action: 'DELETE', entity: 'WorkingCalendar', entityId: DAY_ID });
    // Прежнее значение обязательно: без него нельзя понять, что именно сняли.
    expect(audit.before).toBeDefined();
    expect(audit.before).not.toBeNull();
    // Нового значения нет: поле отсутствует (см. пояснение выше про JsonNull).
    expect(audit.after).toBeUndefined();
  });

  it('снятие несуществующей записи даёт ошибку', async () => {
    const prisma = createPrismaMock();
    prisma._tx.workingCalendar.findUnique.mockResolvedValue(null);
    await expect(makeService(prisma).deleteDay(DAY_ID, ADMIN)).rejects.toThrow(BadRequestException);
    expect(prisma._tx.workingCalendar.delete).not.toHaveBeenCalled();
  });
});

describe('WorkingCalendarService: расчёт сроков после снятия дефектных строк', () => {
  it('пустой календарь даёт верный срок через новогодние каникулы', async () => {
    // Это и есть исходный дефект: без строк-зеркал расчёт обязан учесть
    // каникулы 1–8 января и поставить срок на 11 января, а не на 1-е.
    const prisma = createPrismaMock();
    const service = makeService(prisma);
    const rows = await service.list({ from: '2026-12-25', to: '2027-01-31' });
    expect(rows.days).toEqual([]);

    const { addWorkingDays, toDateKey } = await import('@app/shared');
    const calendar = { overrides: new Map(), defaultHours: 8 };
    expect(toDateKey(addWorkingDays(new Date('2026-12-25T12:00:00Z'), 5, calendar))).toBe(
      '2027-01-11',
    );
  });
});
