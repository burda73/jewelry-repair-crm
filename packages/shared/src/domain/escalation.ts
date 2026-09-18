/**
 * Эскалации просрочки (задача 2.8, ТЗ п. 2.7).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Просроченный заказ сам о себе не сообщает: приёмщик узнаёт о
 * нём, когда клиент позвонит и спросит, где изделие. Дашборд показывает
 * просрочки, но смотреть в него надо самому, и в занятой смене этого не делает
 * никто. Эскалация переворачивает это: система замечает срок и говорит о нём
 * ответственному, а если тот не отреагировал — его руководителю.
 *
 * ПОЧЕМУ ДВА УРОВНЯ, А НЕ ОДНО УВЕДОМЛЕНИЕ. Одно уведомление либо уходит
 * ответственному (и тогда никто не подстрахует), либо сразу руководителю (и
 * тогда эскалация превращается в доносительство за каждую задержку на час).
 * Два уровня дают исполнителю время решить вопрос самому и подключают
 * руководителя только тогда, когда просрочка стала проблемой, а не сигналом.
 *
 * ПОЧЕМУ ПОРОГ ИЗМЕРЯЕТСЯ В РАБОЧИХ ЧАСАХ. «Просрочка больше суток» по
 * календарю означает, что заказ, просроченный в пятницу вечером, эскалируется
 * руководителю в субботу — то есть когда никто не работает и решить ничего
 * нельзя. Сутки рабочих часов — это примерно один рабочий день, и порог
 * срабатывает тогда, когда у ответственного действительно была возможность
 * отреагировать.
 */

import {
  HOUR_MS,
  WORK_DAY_START_HOUR,
  isWorkday,
  toDateKey,
  type WorkingCalendar,
} from '../utils/dates.js';

/** Уровни эскалации. Числа хранятся в `Order.escalationLevel`. */
export const ESCALATION_LEVEL = {
  /** Оповещён только ответственный за этап. */
  RESPONSIBLE: 1,
  /** Дополнительно оповещён руководитель: просрочка больше рабочего дня. */
  MANAGER: 2,
} as const;

export type EscalationLevel = (typeof ESCALATION_LEVEL)[keyof typeof ESCALATION_LEVEL];

/**
 * Порог подключения руководителя — 9 рабочих часов.
 *
 * Ровно один рабочий день: рабочий день в системе длится с 10:00 до 19:00
 * (`addWorkingHours`), то есть 9 часов. Порог выражен через ту же функцию, что
 * и нормативы, — иначе «один рабочий день» в эскалации и в расчёте срока
 * означал бы разное, и объяснить разницу было бы нечем.
 */
export const MANAGER_ESCALATION_HOURS = 9;

/** Состояние эскалации заказа на момент проверки. */
export interface EscalationState {
  /** Просрочен ли заказ: `now > dueAt`. */
  isOverdue: boolean;
  /** Сколько рабочих часов просрочки. 0, если не просрочен. */
  overdueWorkingHours: number;
  /** Нужен ли уровень руководителя. */
  needsManager: boolean;
  /** Целевой уровень эскалации: 0 — не нужна, 1 — ответственный, 2 — и руководитель. */
  level: EscalationLevel | 0;
}

/**
 * Оценить, нужна ли эскалация и на каком уровне.
 *
 * Функция ЧИСТАЯ: время и календарь передаются снаружи. Воркер, читающий
 * системные часы внутри правила, невозможно проверить тестом на границах, а
 * именно там и живут все ошибки («порог срабатывает на день раньше»).
 *
 * @param dueAt        нормативный срок заказа; `null` — срок не задан
 * @param now          момент проверки
 * @param calendar     рабочий календарь для отсчёта рабочих часов
 * @param escalatedAt  когда эскалация отправлялась в последний раз
 * @param currentLevel достигнутый уровень эскалации
 */
export function assessEscalation(params: {
  dueAt: Date | null;
  now: Date;
  calendar: WorkingCalendar;
  escalatedAt?: Date | null;
  currentLevel?: number;
}): EscalationState {
  const { dueAt, now, calendar } = params;
  const currentLevel = params.currentLevel ?? 0;

  /*
   * Заказ без срока эскалировать нельзя: `dueAt` не задан — значит, норматив
   * для этапа не найден, и «просрочка» была бы выдумкой. Порождать уведомления
   * из отсутствия данных хуже, чем не порождать их вовсе: ложная тревога учит
   * игнорировать настоящую.
   */
  if (dueAt === null || now.getTime() <= dueAt.getTime()) {
    return { isOverdue: false, overdueWorkingHours: 0, needsManager: false, level: 0 };
  }

  const overdueWorkingHours = countWorkingHours(dueAt, now, calendar);
  const needsManager = overdueWorkingHours >= MANAGER_ESCALATION_HOURS;

  /*
   * Уровень не понижается: однажды подключённый руководитель остаётся в курсе.
   * Иначе повторный расчёт после срабатывания календарного выходного дал бы
   * уровень ниже достигнутого, и воркер «забыл бы», что руководителя уже
   * оповестили, — и оповестил бы его заново.
   */
  const target: EscalationLevel | 0 = needsManager
    ? ESCALATION_LEVEL.MANAGER
    : ESCALATION_LEVEL.RESPONSIBLE;

  return {
    isOverdue: true,
    overdueWorkingHours,
    needsManager,
    level: (Math.max(target, currentLevel) as EscalationLevel | 0) ?? target,
  };
}

/**
 * Нужно ли оповещать на этом уровне ПОВТОРНО.
 *
 * Уведомление отправляется только при ПОВЫШЕНИИ уровня. Ежедневное повторение
 * одного и того же сообщения превращает ленту в шум, и настоящее событие в ней
 * теряется. Порог выражается уровнем, а не временем: «уже оповещали на этом
 * уровне» — это факт, а «оповещали час назад» требует хранить время каждой
 * отправки.
 */
export function shouldEscalateAgain(state: EscalationState, currentLevel: number): boolean {
  return state.isOverdue && state.level > currentLevel;
}

/**
 * Сколько РАБОЧИХ часов между двумя моментами.
 *
 * Считается по тому же календарю и тем же границам рабочего дня
 * (`WORK_DAY_START_HOUR..WORK_DAY_END_HOUR`), что и нормативы: иначе «просрочено
 * на 9 рабочих часов» означало бы одно в расчёте срока и другое в эскалации.
 *
 * Считается НАПРЯМУЮ, а не разностью через `addWorkingHours`: та функция
 * отсчитывает часы целыми шагами и начинает счёт с текущей минуты, поэтому её
 * «обратный ход» давал бы сдвиг на час на каждой границе. Прямой подсчёт
 * суммирует реальные пересечения интервала с рабочими окнами.
 */
export function countWorkingHours(from: Date, to: Date, calendar: WorkingCalendar): number {
  if (to.getTime() <= from.getTime()) return 0;

  /*
   * Ограничение в год: заказ, «просроченный» на годы, означает сбой данных, а
   * не реальную просрочку. Без ограничения цикл по дням шёл бы десятилетиями и
   * подвесил бы воркер.
   */
  const MAX_DAYS = 400;
  let total = 0;

  /*
   * Перебор идёт по КАЛЕНДАРНЫМ ДАТАМ, а не прибавлением суток к моменту
   * времени. Прибавление 24 часов к началу, взятому в середине дня, сдвигало бы
   * курсор на ту же половину дня и последние сутки могли оказаться ПОСЛЕ `to`,
   * из-за чего цикл обрывался до их обработки: просрочка «с пятницы вечера до
   * утра понедельника» теряла понедельник.
   */
  let dateKey = toDateKey(from);
  for (let day = 0; day < MAX_DAYS; day += 1) {
    const dayStart = new Date(`${dateKey}T00:00:00+03:00`);
    // Сутки целиком позже `to` — дальше считать нечего.
    if (dayStart.getTime() > to.getTime()) break;

    if (isWorkday(dayStart, calendar)) {
      const start = localHourInstant(dayStart, WORK_DAY_START_HOUR);
      const end = localHourInstant(
        dayStart,
        WORK_DAY_START_HOUR + workdayHours(dayStart, calendar),
      );

      // Пересечение интервала [from, to] с рабочим окном этого дня.
      const overlapStart = Math.max(from.getTime(), start.getTime());
      const overlapEnd = Math.min(to.getTime(), end.getTime());
      if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / HOUR_MS;
    }

    dateKey = nextDateKey(dateKey);
  }

  return total;
}

/** Следующая календарная дата для ключа `ГГГГ-ММ-ДД`. */
function nextDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Момент, когда в московских сутках даты `date` наступает указанный час. */
function localHourInstant(date: Date, hour: number): Date {
  const key = toDateKey(date);
  return new Date(`${key}T${String(hour).padStart(2, '0')}:00:00+03:00`);
}

/** Длительность рабочего дня в часах: исключение календаря важнее значения по умолчанию. */
function workdayHours(date: Date, calendar: WorkingCalendar): number {
  const override = calendar.overrides.get(toDateKey(date));
  if (override?.hours !== undefined && override.hours > 0) return override.hours;
  return calendar.defaultHours > 0 ? calendar.defaultHours : 9;
}
