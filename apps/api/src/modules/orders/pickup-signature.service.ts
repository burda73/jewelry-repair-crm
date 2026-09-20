import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Подпись клиента о получении изделия (ТЗ п. 2.8, дефект 66).
 *
 * ## Зачем этот сервис
 *
 * Переходы 18 и 21 (`READY_FOR_PICKUP`/`UNCLAIMED` → `COMPLETED`) охраняются
 * условием `PICKUP_SIGNATURE`, которое проверяет
 * `Order.pickupSignatureFileId != null`. Поле было в схеме с самого начала, но
 * **записать в него было нечем**: маршрута загрузки подписи не существовало ни
 * в API, ни в интерфейсе. Из-за этого выдача заказа — основной сценарий
 * приложения — упиралась в `409 PICKUP_SIGNATURE_REQUIRED` на последнем шаге.
 *
 * Дефект не находился раньше потому, что тесты подставляли
 * `pickupSignatureFileId: 'f-1'` фикстурой, обходя несуществующий маршрут:
 * проверялся guard, а не путь к нему.
 *
 * ## Почему подпись — файл, а не флаг
 *
 * ТЗ п. 2.8 требует «фиксацию подписи клиента» как условие выдачи, а
 * `docs/11-open-questions.md` (вопрос B3) оставляет за заказчиком выбор между
 * росчерком на экране, отметкой о факте и ЭЦП. Файл-росчерк покрывает наиболее
 * вероятный вариант и при этом не мешает: если заказчик выберет отметку о факте,
 * достаточно не требовать файл, а ЭЦП потребует отдельного модуля проверки.
 *
 * ## Почему не изображение предмета (как фото изделия)
 *
 * `saveRaw`, а не `savePhoto`: подпись — это документ, а не фотография изделия.
 * Пережатие через `sharp` испортило бы штрихи росчерка, а требование «не
 * меньше/не больше такого-то размера» к подписи неприменимо.
 */
@Injectable()
export class PickupSignatureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Приложить подпись клиента к заказу.
   *
   * Область видимости проверяется тем же фильтром, что и карточка заказа:
   * приложить подпись к чужому заказу нельзя (защита от IDOR,
   * `docs/10-nfr-security.md` §3.2).
   */
  async save(params: {
    orderId: string;
    file: { buffer: Buffer; mimetype: string; originalname: string } | undefined;
    user: AuthenticatedUser;
  }): Promise<{ orderId: string; fileId: string }> {
    if (params.file === undefined) {
      throw new BadRequestException({
        code: 'SIGNATURE_FILE_REQUIRED',
        message: 'Приложите файл подписи клиента',
      });
    }

    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scopes: params.user.scopes,
      storeIds: params.user.storeIds,
      userId: params.user.id,
    });

    const order = await this.prisma.order.findFirst({
      where: { AND: [{ id: params.orderId }, scopeFilter] },
      select: { id: true, status: true, pickupSignatureFileId: true },
    });
    if (order === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    /*
     * Подпись имеет смысл только на шаге выдачи. Принять её в другом статусе
     * значило бы открыть переход 18 в обход порядка: заказ ушёл бы в «Выдан»
     * прямо из «В работе», и деньги за работы не были бы приняты.
     */
    if (order.status !== 'READY_FOR_PICKUP' && order.status !== 'UNCLAIMED') {
      throw new BadRequestException({
        code: 'SIGNATURE_NOT_APPLICABLE',
        message: 'Подпись клиента фиксируется при выдаче готового заказа',
        details: { status: [order.status] },
      });
    }

    const extension = extensionFor(params.file.originalname, params.file.mimetype);
    const stored = await this.storage.saveRaw({
      buffer: params.file.buffer,
      folder: `orders/${params.orderId}/pickup-signature`,
      extension,
      mimeType: params.file.mimetype,
    });

    const result = await this.prisma.runInTransaction(async (tx) => {
      const fileObject = await tx.fileObject.create({
        data: {
          bucket: 'local',
          objectKey: stored.objectKey,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          uploadedById: params.user.id,
        },
      });

      /*
       * Перезапись допустима: клиент может расписаться заново (первый росчерк
       * не вышел), и заставлять администратора чистить поле в базе было бы
       * худшим решением. Прежний файл при этом остаётся в хранилище, а ссылка
       * на новый — в аудите, поэтому след не теряется.
       */
      await tx.order.update({
        where: { id: params.orderId },
        data: { pickupSignatureFileId: fileObject.id },
      });

      await tx.auditLog.create({
        data: {
          actorId: params.user.id,
          actorRole: params.user.primaryRole,
          action: 'PICKUP_SIGNATURE_SAVED',
          entity: 'Order',
          entityId: params.orderId,
          before:
            order.pickupSignatureFileId === null
              ? undefined
              : { pickupSignatureFileId: order.pickupSignatureFileId },
          after: { pickupSignatureFileId: fileObject.id },
        },
      });

      return { orderId: params.orderId, fileId: fileObject.id };
    });

    return result;
  }
}

/**
 * Расширение файла для ключа в хранилище.
 *
 * Берётся из имени файла, но только если оно короткое и безопасное: имя
 * приходит от клиента, и подставлять его в путь нельзя (`../` вывел бы файл за
 * пределы каталога). Если имя не распознано — расширение выводится из MIME-типа,
 * а при неизвестном типе используется `bin`: файл всё равно останется доступен
 * по точному MIME из `FileObject`.
 */
export function extensionFor(originalName: string, mimeType: string): string {
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(originalName)?.[1];
  if (fromName !== undefined) return fromName.toLowerCase();

  const fromMime = mimeType.split('/')[1];
  if (fromMime !== undefined && /^[a-z0-9]{1,5}$/i.test(fromMime)) return fromMime.toLowerCase();

  return 'bin';
}
