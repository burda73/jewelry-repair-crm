/**
 * Фотографии изделий (ТЗ п. 2.1: «Карточка заказа: клиент, изделие, фото…»).
 *
 * Фотофиксация при приёме защищает обе стороны: сотрудник фиксирует состояние
 * изделия до ремонта, клиент получает доказательство, что сдал. Поэтому снимок
 * привязан к КОНКРЕТНОМУ изделию заказа, а не к заказу целиком — в заказе может
 * быть несколько предметов.
 *
 * Файлы лежат на диске сервера, раздаются через API (`GET /photos/:id`).
 * В базе хранится только ключ объекта (`FileObject.objectKey`), поэтому переезд
 * на S3 не потребует миграции ссылок.
 */

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/** Виды фото: до ремонта, дефект, результат, после ремонта. */
export const PHOTO_KINDS = ['INTAKE', 'DEFECT', 'RESULT', 'AFTER_REPAIR'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

/** Фото в ответе API — без ключей хранилища. */
export interface PhotoView {
  id: string;
  itemId: string;
  kind: PhotoKind;
  caption: string | null;
  sortOrder: number;
  createdAt: Date;
  mimeType: string;
  sizeBytes: number;
  /** Адрес для показа. Ключ хранилища наружу не отдаётся. */
  url: string;
  thumbnailUrl: string;
}

@Injectable()
export class PhotosService {
  private readonly logger = new Logger(PhotosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Загрузить фотографии изделия.
   *
   * Порядок действий важен: сначала проверяется доступ к заказу через область
   * видимости, потом файлы пишутся на диск, и только затем появляются записи в
   * базе. Если файл не сохранился, в базе не остаётся «фото-призрак», которое
   * нельзя открыть; если запись не создалась, файл убирается.
   */
  async uploadPhotos(params: {
    orderId: string;
    itemId: string;
    kind: PhotoKind;
    caption: string | null;
    files: { buffer: Buffer; mimetype: string; originalname: string }[];
    user: AuthenticatedUser;
  }): Promise<PhotoView[]> {
    if (params.files.length === 0) {
      throw new BadRequestException({ code: 'NO_FILES', message: 'Не выбран ни один файл' });
    }

    // Область видимости — тот же фильтр, что и у карточки заказа: прикреплять
    // фото к чужому заказу нельзя.
    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scopes: params.user.scopes,
      storeIds: params.user.storeIds,
      userId: params.user.id,
    });
    const order = await this.prisma.order.findFirst({
      where: { AND: [{ id: params.orderId }, scopeFilter] },
      select: { id: true },
    });
    if (order === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }

    // Изделие обязано принадлежать этому заказу: иначе фото можно было бы
    // прикрепить к изделию другого заказа, зная только его идентификатор.
    const item = await this.prisma.item.findFirst({
      where: { id: params.itemId, orderId: params.orderId },
      select: { id: true, _count: { select: { photos: true } } },
    });
    if (item === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Изделие не найдено в заказе' });
    }

    const saved: { fileId: string; photoId: string }[] = [];
    let sortOrder = item._count.photos;

    for (const file of params.files) {
      let stored;
      try {
        stored = await this.storage.savePhoto({
          buffer: file.buffer,
          folder: `orders/${params.orderId}/items/${params.itemId}`,
        });
      } catch (error) {
        // Неизображение или слишком большой файл — понятная ошибка вместо 500.
        const message =
          error instanceof RangeError ? error.message : 'Не удалось обработать изображение';
        throw new BadRequestException({
          code: 'INVALID_IMAGE',
          message: `${file.originalname}: ${message}`,
        });
      }

      try {
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
          const photo = await tx.itemPhoto.create({
            data: {
              itemId: params.itemId,
              fileId: fileObject.id,
              kind: params.kind,
              caption: params.caption,
              sortOrder: sortOrder++,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: params.user.id,
              actorRole: params.user.primaryRole,
              action: 'PHOTO_UPLOAD',
              entity: 'ItemPhoto',
              entityId: photo.id,
              after: { orderId: params.orderId, itemId: params.itemId, kind: params.kind },
            },
          });
          return { fileId: fileObject.id, photoId: photo.id };
        });
        saved.push(result);
      } catch (error) {
        // Запись не создалась — убираем уже записанные файлы, чтобы на диске
        // не осталось мусора, на который никто не ссылается.
        await this.storage.remove(stored.objectKey);
        await this.storage.remove(stored.thumbnailKey);
        throw error;
      }
    }

    return this.listByItem(params.orderId, params.itemId, params.user);
  }

  /** Фотографии изделия. */
  async listByItem(orderId: string, itemId: string, user: AuthenticatedUser): Promise<PhotoView[]> {
    await this.assertOrderVisible(orderId, user);

    const photos = await this.prisma.itemPhoto.findMany({
      where: { itemId, item: { orderId } },
      include: { file: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return photos.map((photo) => this.toView(photo));
  }

  /**
   * Данные файла для отдачи по HTTP.
   *
   * Отдаётся через API, а не статикой: фотография изделия — это данные клиента,
   * доступ к ней должен проверяться правами и областью видимости. Прямая раздача
   * каталога отдала бы любой файл по угадываемому адресу.
   */
  async getFileForDownload(
    photoId: string,
    variant: 'full' | 'thumb',
    user: AuthenticatedUser,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const photo = await this.prisma.itemPhoto.findFirst({
      where: { id: photoId },
      include: { file: true, item: { select: { orderId: true } } },
    });
    if (photo === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Фотография не найдена' });
    }

    // Проверка доступа идёт ПО ЗАКАЗУ: фотография наследует его видимость.
    await this.assertOrderVisible(photo.item.orderId, user);

    /*
     * Уменьшенная копия лежит рядом с оригиналом и отличается суффиксом
     * `-thumb`. Если её нет (старые записи), отдаём оригинал: показать фото
     * целиком лучше, чем не показать ничего.
     */
    const key =
      variant === 'thumb'
        ? photo.file.objectKey.replace(/\.jpg$/, '-thumb.jpg')
        : photo.file.objectKey;

    let buffer: Buffer;
    try {
      buffer = await this.storage.read(key);
    } catch {
      buffer = await this.storage.read(photo.file.objectKey);
    }

    return {
      buffer,
      mimeType: photo.file.mimeType,
      fileName: `photo-${photo.id}.jpg`,
    };
  }

  /** Удалить фотографию. Файл убирается с диска вместе с записью. */
  async removePhoto(photoId: string, user: AuthenticatedUser): Promise<void> {
    const photo = await this.prisma.itemPhoto.findFirst({
      where: { id: photoId },
      include: { file: true, item: { select: { orderId: true } } },
    });
    if (photo === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Фотография не найдена' });
    }
    await this.assertOrderVisible(photo.item.orderId, user);

    await this.prisma.runInTransaction(async (tx) => {
      await tx.itemPhoto.delete({ where: { id: photoId } });
      await tx.fileObject.delete({ where: { id: photo.fileId } });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.primaryRole,
          action: 'PHOTO_DELETE',
          entity: 'ItemPhoto',
          entityId: photoId,
          before: { orderId: photo.item.orderId, kind: photo.kind },
        },
      });
    });

    // Файлы удаляются после успешной транзакции: если база откатится,
    // записи останутся, и файл должен остаться вместе с ними.
    await this.storage.remove(photo.file.objectKey);
    await this.storage.remove(photo.file.objectKey.replace(/\.jpg$/, '-thumb.jpg'));
    this.logger.log(`Фотография ${photoId} удалена`);
  }

  /** Проверка области видимости заказа — общая для всех операций с фото. */
  private async assertOrderVisible(orderId: string, user: AuthenticatedUser): Promise<void> {
    const scopeFilter = this.prisma.buildOrderScopeFilter({
      scopes: user.scopes,
      storeIds: user.storeIds,
      userId: user.id,
    });
    const order = await this.prisma.order.findFirst({
      where: { AND: [{ id: orderId }, scopeFilter] },
      select: { id: true },
    });
    if (order === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ не найден' });
    }
  }

  /** Преобразовать запись в ответ API, скрыв ключи хранилища. */
  private toView(photo: {
    id: string;
    itemId: string;
    kind: string;
    caption: string | null;
    sortOrder: number;
    createdAt: Date;
    file: { mimeType: string; sizeBytes: number };
  }): PhotoView {
    /*
     * Адрес включает префикс `/api/v1`.
     *
     * Иначе ссылка была бы нерабочей: браузер обращается к тому же источнику,
     * что и интерфейс, а прокси перенаправляет на API только пути `/api/v1/*`.
     * Ссылка `/photos/...` попадала в маршрутизацию Next и отдавала 404 —
     * миниатюры не отображались, хотя файл на сервере был.
     */
    const base = `/api/v1/photos/${photo.id}`;
    return {
      id: photo.id,
      itemId: photo.itemId,
      kind: photo.kind as PhotoKind,
      caption: photo.caption,
      sortOrder: photo.sortOrder,
      createdAt: photo.createdAt,
      mimeType: photo.file.mimeType,
      sizeBytes: photo.file.sizeBytes,
      url: base,
      thumbnailUrl: `${base}?variant=thumb`,
    };
  }
}
