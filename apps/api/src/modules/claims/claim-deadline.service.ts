/**
 * Предупреждение о сроке рассмотрения рекламации (задача 6.6, ТЗ п. 2.9).
 *
 * ЗАЧЕМ ЭТО НУЖНО. Срок 10 рабочих дней — обязательство перед потребителем, и
 * наступить он может незаметно: рекламаций немного, каждая живёт своей жизнью, а
 * сотрудник, который её ведёт, может заболеть или уйти в смену. Напоминание
 * снимает с памяти человека то, что обязана держать система.
 *
 * ПОЧЕМУ ПРЕДУПРЕЖДЕНИЕ ОДНО, А НЕ ЕЖЕДНЕВНОЕ. Ежедневное напоминание об одном
 * и том же превращается в фон, который перестают читать, — вместе с настоящими
 * событиями. Одинокая отметка `warningSentAt` гарантирует, что рекламация
 * предупреждается ровно один раз, а дальше о ней говорит список просроченных.
 *
 * ПОЧЕМУ АДРЕСАТ — РАССМАТРИВАЮЩИЙ, А НЕ ВСЕ МЕНЕДЖЕРЫ. Рекламация уже кем-то
 * взята в работу; рассылка всем размывает ответственность и создаёт ситуацию
 * «это сделает кто-то другой».
 */

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimsService } from './claims.service';
import { NotificationsService, TEMPLATE_CODE } from '../notifications/notifications.service';

/** Итог прогона — для журнала и ручного запуска. */
export interface ClaimDeadlineRunResult {
  /** Сколько рекламаций со близким сроком просмотрено. */
  scanned: number;
  /** Сколько предупреждений разослано. */
  warned: number;
  /** Рекламации без рассматривающего: предупредить некого. */
  withoutReviewer: number;
}

@Injectable()
export class ClaimDeadlineService {
  private readonly logger = new Logger(ClaimDeadlineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Прогон предупреждений.
   *
   * ПОРЯДОК ВАЖЕН: сначала рассылка, потом отметка. Если отметить до отправки, а
   * отправка упадёт, рекламация останется без предупреждения НАВСЕГДА — повторный
   * прогон её уже не увидит. Обратный порядок даёт в худшем случае повторное
   * письмо, что несравнимо дешевле пропущенного срока.
   */
  async run(): Promise<ClaimDeadlineRunResult> {
    const due = await this.claims.findNeedingWarning();

    let warned = 0;
    let withoutReviewer = 0;

    for (const claim of due) {
      const claimRow = await this.prisma.warrantyClaim.findUnique({
        where: { id: claim.id },
        select: {
          reviewerId: true,
          reviewer: { select: { id: true, email: true } },
        },
      });

      const reviewer = claimRow?.reviewer ?? null;
      if (reviewer === null) {
        /*
         * Рекламация без рассматривающего — это не «нет адресата», а сигнал о
         * проблеме: обращение открыто, но никем не взято. Считаем отдельно,
         * чтобы это было видно в журнале воркера.
         */
        withoutReviewer += 1;
        this.logger.warn(
          `Рекламация ${claim.claimNo}: срок близко, но рассматривающий не назначен`,
        );
        continue;
      }

      await this.notifications.notifyStaff({
        code: TEMPLATE_CODE.CLAIM_DEADLINE,
        userId: reviewer.id,
        email: reviewer.email,
        values: {
          claimNo: claim.claimNo,
          dueDate: claim.dueAt.toISOString().slice(0, 10),
        },
        fallbackSubject: `Срок рекламации ${claim.claimNo}`,
        fallbackBody: `По рекламации ${claim.claimNo} истекает срок рассмотрения ${claim.dueAt
          .toISOString()
          .slice(0, 10)}.`,
      });

      await this.claims.markWarningSent(claim.id);
      warned += 1;
    }

    return { scanned: due.length, warned, withoutReviewer };
  }
}
