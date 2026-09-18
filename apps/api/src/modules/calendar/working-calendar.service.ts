import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  createCalendarDaySchema,
  updateCalendarDaySchema,
  calendarQuerySchema,
  isStateHoliday,
  stateHolidaysBetween,
  weekday,
} from '@app/shared';

import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Строка календаря так, как её видит интерфейс.
 *
 * `isWorkday` и `hours` — то, что хранится. `redundant` — вычисляемый признак:
 * «эта запись ничего не меняет, день и так такой по правилу». Он нужен
 * интерфейсу, чтобы показать, какие строки являются настройкой, а какие —
 * историческим мусором, который можно снять.
 */
export interface CalendarDayDto {
  id: string;
  date: string;
  isWorkday: boolean;
  hours: number;
  note: string | null;
  /** Праздник по ТК РФ (встроенный список), независимо от записи. */
  isHoliday: boolean;
  /**
   * Запись ничего не меняет: день и без неё такой же.
   *
   * Такие строки — историческое наследие `seed` (он писал по строке на каждый
   * день). Они безвредны, пока не совпадают с праздником, но именно они
   * перекрывали праздники, поэтому интерфейс показывает их отдельно и
   * предлагает снять.
   */
  redundant: boolean;
}

export interface CalendarMonthSummaryDto {
  month: string;
  workdays: number;
  holidays: number;
}

@Injectable()
export class WorkingCalendarService {
  private readonly logger = new Logger(WorkingCalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Чтение
  // -------------------------------------------------------------------------

  /**
   * Календарь за период.
   *
   * Возвращаются только ЗАПИСИ из базы, а не вычисленный календарь на каждый
   * день: праздники РФ знает код (`isStateHoliday`), дублировать их строками в
   * ответе значило бы снова создать видимость, что календарь — это таблица на
   * каждый день. Именно из-за такого дублирования (`seed` писал по строке на
   * каждый день) праздники среди недели были помечены рабочими.
   */
  async list(query: unknown): Promise<{ days: CalendarDayDto[]; holidays: string[] }> {
    const filters = parseOrThrow(calendarQuerySchema, query);
    const from = new Date(`${filters.from}T00:00:00Z`);
    const to = new Date(`${filters.to}T00:00:00Z`);

    const rows = await this.prisma.workingCalendar.findMany({
      // Только общий календарь сети: именно его читает расчёт сроков
      // (`OrderWorkflowService.loadCalendar`). Календарь отдельного магазина
      // на сроки сейчас не влияет, поэтому и показывать его как настройку
      // сроков было бы обманом.
      where: { storeId: null, date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
    });

    const days = rows.map((row) => toDto(row));

    // Праздники считаются кодом и отдаются отдельно: администратору важно
    // видеть, что 1 января нерабочее даже без строки в таблице, иначе он будет
    // заводить запись, которая уже не нужна.
    const holidays = stateHolidaysBetween(from, to);

    return { days, holidays };
  }

  /** Сводка по месяцам периода: сколько рабочих дней и праздников. */
  async summary(query: unknown): Promise<CalendarMonthSummaryDto[]> {
    const filters = parseOrThrow(calendarQuerySchema, query);
    const from = new Date(`${filters.from}T00:00:00Z`);
    const to = new Date(`${filters.to}T00:00:00Z`);

    const rows = await this.prisma.workingCalendar.findMany({
      where: { storeId: null, date: { gte: from, lte: to } },
      select: { date: true, isWorkday: true, hours: true },
    });

    const overrides = new Map<string, { isWorkday: boolean; hours?: number }>();
    for (const row of rows) {
      overrides.set(row.date.toISOString().slice(0, 10), {
        isWorkday: row.isWorkday,
        hours: row.hours,
      });
    }

    // Месяцы считаются по тому же правилу, что и сроки: праздник важнее дня
    // недели, а исключение сильнее праздника. Отдельная копия правила здесь
    // разошлась бы с расчётом сроков, и сводка показывала бы не то, по чему
    // система ставит dueAt.
    const byMonth = new Map<string, CalendarMonthSummaryDto>();
    const cursor = new Date(from.getTime());
    while (cursor.getTime() <= to.getTime()) {
      const key = cursor.toISOString().slice(0, 10);
      const month = key.slice(0, 7);
      const entry = byMonth.get(month) ?? { month, workdays: 0, holidays: 0 };
      const override = overrides.get(key);
      if (override !== undefined) {
        if (override.isWorkday) entry.workdays += 1;
        else entry.holidays += 1;
      } else if (isStateHoliday(key)) {
        entry.holidays += 1;
      } else {
        const day = weekday(cursor);
        if (day === 0 || day === 6) entry.holidays += 1;
        else entry.workdays += 1;
      }
      byMonth.set(month, entry);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  }

  // -------------------------------------------------------------------------
  // Изменение
  // -------------------------------------------------------------------------

  async createDay(input: unknown, actor: AuthenticatedUser): Promise<CalendarDayDto> {
    const data = parseOrThrow(createCalendarDaySchema, input);
    const date = new Date(`${data.date}T00:00:00Z`);
    const hours = data.isWorkday ? (data.hours ?? 8) : 0;

    // Зеркальную запись создавать нельзя: именно они перекрывали встроенные
    // праздники и были причиной дефекта сроков. Запись, повторяющая обычное
    // правило, бессмысленна (день и так такой) и вредна (маскирует праздник),
    // поэтому отклоняется с объяснением, а не создаётся молча.
    if (isRedundantDay(date, data.isWorkday, hours)) {
      throw new BadRequestException({
        code: 'CALENDAR_REDUNDANT_DAY',
        message:
          'Этот день уже такой по обычному правилу, запись ничего не изменит. ' +
          'Отметьте только исключение: праздник, перенос или особые часы.',
      });
    }

    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.workingCalendar.findFirst({
        where: { storeId: null, date },
      });
      if (existing) {
        throw new ConflictException({
          code: 'CALENDAR_DAY_EXISTS',
          message: 'На этот день уже есть запись — измените её вместо создания новой',
        });
      }

      const created = await tx.workingCalendar.create({
        data: {
          storeId: null,
          date,
          isWorkday: data.isWorkday,
          hours,
          note: data.note ?? null,
        },
      });

      await this.audit(tx, actor, 'CREATE', created.id, null, toDto(created));

      this.logger.log(
        { date: data.date, isWorkday: data.isWorkday },
        'Рабочий календарь: добавлена запись',
      );
      return toDto(created);
    });
  }

  async updateDay(id: string, input: unknown, actor: AuthenticatedUser): Promise<CalendarDayDto> {
    const data = parseOrThrow(updateCalendarDaySchema, input);

    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.workingCalendar.findUnique({ where: { id } });
      if (!existing) {
        throw new BadRequestException({
          code: 'NOT_FOUND',
          message: 'Запись календаря не найдена',
        });
      }

      // Часы выводятся из признака рабочего дня, если он меняется: смена
      // «выходной → рабочий» без указания часов должна дать обычные 8, а не
      // оставить 0 и создать запись «рабочий день 0 часов».
      const isWorkday = data.isWorkday ?? existing.isWorkday;
      let hours = data.hours ?? existing.hours;
      if (data.isWorkday !== undefined && data.hours === undefined) {
        hours = isWorkday ? 8 : 0;
      }
      if (isWorkday && hours === 0) hours = 8;
      if (!isWorkday) hours = 0;

      const date = data.date === undefined ? existing.date : new Date(`${data.date}T00:00:00Z`);

      // Если запись меняется на «как по правилу», она перестаёт быть
      // исключением и начинает маскировать праздник — это тот же дефект.
      // Администратору предлагается снять запись, а не превращать её в зеркало.
      if (isRedundantDay(date, isWorkday, hours)) {
        throw new BadRequestException({
          code: 'CALENDAR_REDUNDANT_DAY',
          message:
            'После изменения запись совпадёт с обычным правилом и будет скрывать праздники. ' +
            'Снимите отметку, если день должен стать обычным.',
        });
      }

      // Смена даты может столкнуться с существующей записью: частичный
      // уникальный индекс (миграция 20260919000000) это отклонит на уровне базы,
      // но проверка здесь даёт понятное сообщение вместо ошибки ограничения.
      if (data.date !== undefined && data.date !== existing.date.toISOString().slice(0, 10)) {
        const clash = await tx.workingCalendar.findFirst({
          where: { storeId: null, date, id: { not: id } },
        });
        if (clash) {
          throw new ConflictException({
            code: 'CALENDAR_DAY_EXISTS',
            message: 'На эту дату уже есть запись календаря',
          });
        }
      }

      const updated = await tx.workingCalendar.update({
        where: { id },
        data: {
          date,
          isWorkday,
          hours,
          ...(data.note === undefined ? {} : { note: data.note }),
        },
      });

      await this.audit(tx, actor, 'UPDATE', id, toDto(existing), toDto(updated));
      return toDto(updated);
    });
  }

  /**
   * Снять запись — день возвращается к обычному правилу.
   *
   * Это ЕДИНСТВЕННОЕ удаление в системе администратора, и оно не противоречит
   * решению «не удалять, только отключать»: на строку календаря не ссылается ни
   * одна таблица (внешних ключей нет), а «отключить дату» смысла не имеет —
   * каждая дата либо есть в календаре, либо нет. Прежнее значение сохраняется
   * в журнале (`before`), поэтому действие обратимо.
   */
  async deleteDay(id: string, actor: AuthenticatedUser): Promise<{ removed: true }> {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.workingCalendar.findUnique({ where: { id } });
      if (!existing) {
        throw new BadRequestException({
          code: 'NOT_FOUND',
          message: 'Запись календаря не найдена',
        });
      }
      await tx.workingCalendar.delete({ where: { id } });
      // `action: 'DELETE'` — единственное место, где он используется. Журнал
      // append-only, поэтому запись о снятии остаётся навсегда.
      await this.audit(tx, actor, 'DELETE', id, toDto(existing), null);

      this.logger.log(
        { date: existing.date.toISOString().slice(0, 10) },
        'Рабочий календарь: запись снята',
      );
      return { removed: true } as const;
    });
  }

  // -------------------------------------------------------------------------
  // Вспомогательное
  // -------------------------------------------------------------------------

  private async audit(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.primaryRole,
        action,
        entity: 'WorkingCalendar',
        entityId,
        // `Prisma.JsonNull` вместо `null`: в `Json?`-поле `null` означает
        // «значение JSON null», а не «поля не было». Для CREATE и DELETE
        // отсутствие прежнего/нового значения выражается именно JsonNull.
        before: action === 'CREATE' ? Prisma.JsonNull : (before as Prisma.InputJsonValue),
        after: after === null ? Prisma.JsonNull : (after as Prisma.InputJsonValue),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Строка базы → DTO. `isHoliday` и `redundant` вычисляются. */
function toDto(row: {
  id: string;
  date: Date;
  isWorkday: boolean;
  hours: number;
  note: string | null;
}): CalendarDayDto {
  const key = row.date.toISOString().slice(0, 10);
  return {
    id: row.id,
    date: key,
    isWorkday: row.isWorkday,
    hours: row.hours,
    note: row.note,
    isHoliday: isStateHoliday(key),
    redundant: isRedundantDay(row.date, row.isWorkday, row.hours),
  };
}

/**
 * Ничего не меняет ли запись: совпадает ли она с тем, что дало бы правило БЕЗ неё.
 *
 * Определение сформулировано именно так — «результат без этой строки», — а не
 * как «похоже на пн–пт». Разница принципиальна: 4 января 2027 года это
 * понедельник, но государственный праздник, поэтому правило (праздник + день
 * недели) считает его нерабочим, и запись «рабочий день» является ИСКЛЮЧЕНИЕМ,
 * а не зеркалом. Более простая проверка «будний день ⇒ зеркало» запретила бы
 * объявить рабочим праздник среди недели — то есть отняла бы у администратора
 * ровно ту настройку, ради которой календарь и существует.
 *
 * Функция используется дважды:
 *  * чтобы запретить создание/изменение записи, которая ничего не меняет
 *    (такие строки перекрывали встроенные праздники — это и был дефект);
 *  * для признака `redundant` в ответе, чтобы администратор видел исторические
 *    зеркала и мог их снять.
 */
export function isRedundantDay(date: Date, isWorkday: boolean, hours: number): boolean {
  const key = date.toISOString().slice(0, 10);
  const day = weekday(new Date(`${key}T12:00:00Z`));
  const isWeekend = day === 0 || day === 6;
  // Правило без записи: праздник нерабочий, иначе решают будни/выходные.
  const expectedIsWorkday = !isStateHoliday(key) && !isWeekend;
  const expectedHours = expectedIsWorkday ? 8 : 0;
  return isWorkday === expectedIsWorkday && hours === expectedHours;
}

function parseOrThrow<Output, Input = unknown>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Проверьте правильность заполнения полей',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  return parsed.data;
}
