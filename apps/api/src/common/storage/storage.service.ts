/**
 * Хранилище файлов (фото изделий, документы, записи звонков).
 *
 * Два драйвера:
 *  * `LOCAL` — файлы на диске сервера, раздача через API. Выбрано для текущей
 *    инфраструктуры: S3/MinIO в ней нет (ответ A1), а на диске LXC есть запас.
 *  * `S3` — объектное хранилище. Оставлено, чтобы переезд не требовал правки
 *    прикладного кода: сервисы работают с ключом объекта, а не с путём.
 *
 * Ключ объекта — единственное, что попадает в базу (`FileObject.objectKey`).
 * Драйвер по этому ключу решает, где искать файл, поэтому смена драйвера не
 * ломает ссылки в базе.
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import sharp from 'sharp';

/** Метаданные сохранённого файла. */
export interface StoredFile {
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
}

/** Результат подготовки фотографии: сам файл плюс уменьшенная копия. */
export interface StoredPhoto extends StoredFile {
  /** Ключ уменьшенной копии для списков — её показывают вместо оригинала. */
  thumbnailKey: string;
  width: number;
  height: number;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: 'LOCAL' | 'S3';
  private readonly localDir: string;
  private readonly maxBytes: number;

  constructor(private readonly config: ConfigService) {
    this.driver = this.config.get<'LOCAL' | 'S3'>('STORAGE_DRIVER') ?? 'LOCAL';
    this.localDir = resolve(this.config.get<string>('STORAGE_LOCAL_DIR') ?? '/opt/repair/data/files');
    this.maxBytes = this.config.get<number>('UPLOAD_MAX_BYTES') ?? 10 * 1024 * 1024;
  }

  async onModuleInit(): Promise<void> {
    if (this.driver === 'LOCAL') {
      /*
       * Каталог создаётся при старте: иначе первая же загрузка фото упала бы
       * с ENOENT, и выглядело бы это как «фото не загружаются» без причины.
       */
      await mkdir(this.localDir, { recursive: true });
      this.logger.log(`Хранилище файлов: локальный диск ${this.localDir}`);
      return;
    }
    this.logger.log('Хранилище файлов: S3');
  }

  /** Сколько байт разрешено загружать в одном файле. */
  get maxUploadBytes(): number {
    return this.maxBytes;
  }

  /**
   * Сохранить фотографию изделия.
   *
   * Изображение перекодируется в JPEG и уменьшается до разумного размера:
   *  * оригинал с телефона весит 3–8 МБ, за 5 лет это сотни гигабайт;
   *  * EXIF сохраняется повёрнутым (`rotate()`), иначе фото с телефона
   *    выглядело бы боком;
   *  * уменьшенная копия нужна спискам — отдавать полноразмерное фото
   *    для превью в карточке бессмысленно.
   *
   * Побочный эффект перекодирования: EXIF с геометкой телефона сотрудника
   * НЕ сохраняется. Это и требуется — фото изделия не должно содержать
   * персональные данные того, кто его снимал.
   */
  async savePhoto(params: {
    buffer: Buffer;
    folder: string;
    /** Имя уменьшенной копии: `thumb` для фото изделия. */
    thumbName?: string;
  }): Promise<StoredPhoto> {
    if (params.buffer.length === 0) {
      throw new RangeError('Пустой файл');
    }
    if (params.buffer.length > this.maxBytes) {
      throw new RangeError(
        `Файл больше допустимого размера (${Math.round(this.maxBytes / 1024 / 1024)} МБ)`,
      );
    }

    const image = sharp(params.buffer, { failOn: 'error' });
    const meta = await image.metadata();
    if (meta.width === undefined || meta.height === undefined) {
      throw new RangeError('Не удалось прочитать изображение');
    }

    // `rotate()` без аргументов применяет ориентацию из EXIF и убирает сам тег.
    const full = await sharp(params.buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    const thumb = await sharp(params.buffer)
      .rotate()
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();

    const base = `${params.folder}/${this.randomKey()}`;
    const objectKey = `${base}.jpg`;
    const thumbnailKey = `${base}-${params.thumbName ?? 'thumb'}.jpg`;

    await this.write(objectKey, full);
    await this.write(thumbnailKey, thumb);

    return {
      objectKey,
      thumbnailKey,
      mimeType: 'image/jpeg',
      sizeBytes: full.length,
      checksum: createHash('sha256').update(full).digest('hex'),
      // Размеры берём у итогового файла, а не у исходного: клиент показывает
      // превью, и оно должно соответствовать сохранённому изображению.
      width: (await sharp(full).metadata()).width ?? meta.width,
      height: (await sharp(full).metadata()).height ?? meta.height,
    };
  }

  /** Сохранить произвольный файл без обработки (документы, записи звонков). */
  async saveRaw(params: {
    buffer: Buffer;
    folder: string;
    extension: string;
    mimeType: string;
  }): Promise<StoredFile> {
    if (params.buffer.length > this.maxBytes) {
      throw new RangeError(
        `Файл больше допустимого размера (${Math.round(this.maxBytes / 1024 / 1024)} МБ)`,
      );
    }
    const objectKey = `${params.folder}/${this.randomKey()}.${params.extension}`;
    await this.write(objectKey, params.buffer);
    return {
      objectKey,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      checksum: createHash('sha256').update(params.buffer).digest('hex'),
    };
  }

  /** Прочитать файл по ключу. */
  async read(objectKey: string): Promise<Buffer> {
    this.assertSafeKey(objectKey);
    if (this.driver === 'LOCAL') {
      return readFile(this.absolutePath(objectKey));
    }
    throw new Error('Драйвер S3 не настроен: чтение недоступно');
  }

  /** Существует ли файл по ключу. */
  async exists(objectKey: string): Promise<boolean> {
    if (this.driver !== 'LOCAL') return false;
    try {
      this.assertSafeKey(objectKey);
      await stat(this.absolutePath(objectKey));
      return true;
    } catch {
      return false;
    }
  }

  /** Удалить файл. Отсутствие файла ошибкой не считается. */
  async remove(objectKey: string): Promise<void> {
    if (this.driver !== 'LOCAL') return;
    try {
      this.assertSafeKey(objectKey);
      await unlink(this.absolutePath(objectKey));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(`Не удалось удалить файл ${objectKey}: ${code ?? String(error)}`);
      }
    }
  }

  /** Записать файл на диск. */
  private async write(objectKey: string, buffer: Buffer): Promise<void> {
    if (this.driver === 'LOCAL') {
      const path = this.absolutePath(objectKey);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer);
      return;
    }
    throw new Error('Драйвер S3 не настроен: запись недоступна');
  }

  /** Полный путь к файлу с защитой от выхода за пределы каталога. */
  private absolutePath(objectKey: string): string {
    this.assertSafeKey(objectKey);
    const full = join(this.localDir, objectKey);
    /*
     * Ключ приходит из базы, но проверяем всё равно: если однажды ключ попадёт
     * из запроса, `../../etc/passwd` не должен стать доступен.
     */
    if (!full.startsWith(this.localDir + sep)) {
      throw new RangeError(`Недопустимый ключ объекта: ${objectKey}`);
    }
    return full;
  }

  /** Ключ не должен быть пустым, абсолютным или содержать переходы вверх. */
  private assertSafeKey(objectKey: string): void {
    if (objectKey.trim() === '') {
      throw new RangeError('Пустой ключ объекта');
    }
    const normalized = normalize(objectKey);
    if (normalized.startsWith('..') || normalized.includes(`..${sep}`) || normalized.startsWith(sep)) {
      throw new RangeError(`Недопустимый ключ объекта: ${objectKey}`);
    }
  }

  /** Случайный ключ объекта: `cuid`-подобные идентификаторы тут не нужны. */
  private randomKey(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}
