/**
 * Тесты хранилища файлов.
 *
 * Проверяется в первую очередь защита пути: ключ объекта приходит из базы, но
 * проверка нужна — если однажды ключ попадёт из запроса, `../../etc/passwd`
 * не должен стать доступен. Это единственное место, где ошибка означала бы
 * чтение произвольного файла сервера.
 *
 * Обработка изображений проверяется на настоящем PNG, сгенерированном `sharp`:
 * так тест ловит и «sharp не работает», и потерю поворота EXIF.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageService } from './storage.service';

/** Подделка `ConfigService`: хранилищу нужны только эти значения. */
function makeService(dir: string, maxBytes = 10 * 1024 * 1024): StorageService {
  const values: Record<string, unknown> = {
    STORAGE_DRIVER: 'LOCAL',
    STORAGE_LOCAL_DIR: dir,
    UPLOAD_MAX_BYTES: maxBytes,
  };
  return new StorageService({
    get: (key: string) => values[key],
  } as never);
}

/** Настоящий PNG заданного размера. */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 60, b: 30 } },
  })
    .png()
    .toBuffer();
}

let dir: string;
let storage: StorageService;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'repair-storage-'));
  storage = makeService(dir);
  await storage.onModuleInit();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Хранилище: защита пути', () => {
  it('отклоняет переход вверх по каталогу', async () => {
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(/Недопустимый ключ/);
    await expect(storage.read('orders/../../../etc/passwd')).rejects.toThrow(/Недопустимый ключ/);
  });

  it('отклоняет абсолютный путь', async () => {
    await expect(storage.read('/etc/passwd')).rejects.toThrow(/Недопустимый ключ/);
  });

  it('отклоняет пустой ключ', async () => {
    await expect(storage.read('   ')).rejects.toThrow(/Пустой ключ/);
  });

  it('не считает существующим несуществующий файл', async () => {
    expect(await storage.exists('orders/x/нет.jpg')).toBe(false);
  });
});

describe('Хранилище: сохранение фотографий', () => {
  it('сохраняет фото и уменьшенную копию', async () => {
    const png = await makePng(2000, 1500);
    const saved = await storage.savePhoto({ buffer: png, folder: 'orders/o1/items/i1' });

    expect(saved.mimeType).toBe('image/jpeg');
    expect(saved.sizeBytes).toBeGreaterThan(0);
    expect(saved.checksum).toMatch(/^[0-9a-f]{64}$/);
    // Копия лежит рядом с оригиналом и отличается суффиксом.
    expect(saved.thumbnailKey).toMatch(/-thumb\.jpg$/);
    expect(saved.thumbnailKey.replace('-thumb.jpg', '.jpg')).toBe(saved.objectKey);

    // Оба файла реально записаны.
    expect(await storage.exists(saved.objectKey)).toBe(true);
    expect(await storage.exists(saved.thumbnailKey)).toBe(true);
  });

  it('уменьшает большое изображение до 1600 px по длинной стороне', async () => {
    // Фото с телефона весит мегабайты: без уменьшения диск кончится за год.
    const png = await makePng(4000, 3000);
    const saved = await storage.savePhoto({ buffer: png, folder: 'orders/o2/items/i2' });
    expect(Math.max(saved.width, saved.height)).toBeLessThanOrEqual(1600);
  });

  it('не увеличивает маленькое изображение', async () => {
    const png = await makePng(200, 150);
    const saved = await storage.savePhoto({ buffer: png, folder: 'orders/o3/items/i3' });
    expect(Math.max(saved.width, saved.height)).toBe(200);
  });

  it('уменьшенная копия действительно меньше оригинала', async () => {
    const png = await makePng(1600, 1200);
    const saved = await storage.savePhoto({ buffer: png, folder: 'orders/o4/items/i4' });
    const full = await readFile(join(dir, saved.objectKey));
    const thumb = await readFile(join(dir, saved.thumbnailKey));
    expect(thumb.length).toBeLessThan(full.length);
  });

  it('отклоняет файл больше допустимого размера', async () => {
    const small = makeService(dir, 100);
    await small.onModuleInit();
    const png = await makePng(500, 500);
    await expect(small.savePhoto({ buffer: png, folder: 'orders/o5/items/i5' })).rejects.toThrow(
      /больше допустимого/,
    );
  });

  it('отклоняет не-изображение', async () => {
    // Приёмщик может выбрать файл не того типа — ошибка должна быть понятной,
    // а не «внутренняя ошибка сервера».
    const text = Buffer.from('это не картинка, а текст');
    await expect(
      storage.savePhoto({ buffer: text, folder: 'orders/o6/items/i6' }),
    ).rejects.toThrow();
  });

  it('клон изображения сохраняет применённый поворот', async () => {
    // `rotate()` без аргументов должен убрать тег ориентации: иначе фото
    // с телефона показывалось бы боком.
    const rotated = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 90, b: 200 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const saved = await storage.savePhoto({ buffer: rotated, folder: 'orders/o7/items/i7' });
    const meta = await sharp(await readFile(join(dir, saved.objectKey))).metadata();
    // Ориентация применена к пикселям и тег убран: 400x200 → 200x400.
    expect(meta.orientation).toBeUndefined();
    expect(saved.width).toBe(200);
    expect(saved.height).toBe(400);
  });
});

describe('Хранилище: драйвер S3 объявлен, но не реализован', () => {
  /*
   * Это проверка ДОКУМЕНТИРОВАННОГО поведения, а не желаемого. `docs/05-integrations.md`
   * §4.2 прямо говорит: драйвер S3 в коде есть, но чтение и запись недоступны.
   *
   * Зачем фиксировать недоделку тестом. Без него «S3 не работает» — знание,
   * которое живёт только в документе, а документ расходится с кодом молча.
   * С ним попытка переезда на S3 упрётся в падающий тест, и это правильный
   * момент узнать о недостающей реализации — до выката, а не после.
   */
  /*
   * Экземпляр создаётся ВНУТРИ теста, а не в теле `describe`. Тело `describe`
   * выполняется при сборке набора — до `beforeAll`, — и `dir` там ещё
   * `undefined`. Драйвер в этом случае взял бы каталог по умолчанию
   * `/opt/repair/data/files`, файла бы не нашёл и вернул `false` по
   * СОВЕРШЕННО другой причине, чем проверяется. Тест проходил бы и на снятой
   * защите драйвера, то есть не проверял бы ничего.
   */
  const makeS3 = (): StorageService =>
    new StorageService({
      get: (key: string) =>
        ({
          STORAGE_DRIVER: 'S3',
          STORAGE_LOCAL_DIR: dir,
          UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
        })[key],
    } as never);

  it('при старте сообщает о драйвере S3, не падая', async () => {
    await expect(makeS3().onModuleInit()).resolves.toBeUndefined();
  });

  it('отказывает в чтении, а не возвращает пустые данные', async () => {
    // Пустой буфер выглядел бы как «файл повреждён» — и искали бы причину в файле.
    await expect(makeS3().read('orders/o1/items/i1/a.jpg')).rejects.toThrow(/S3 не настроен/);
  });

  it('отказывает в записи, а не теряет файл молча', async () => {
    const png = await makePng(50, 50);
    await expect(makeS3().savePhoto({ buffer: png, folder: 'orders/o2/items/i2' })).rejects.toThrow(
      /S3 не настроен/,
    );
  });

  it('не считает существующим файл, который лежит в локальном каталоге', async () => {
    const png = await makePng(50, 50);
    const saved = await storage.savePhoto({ buffer: png, folder: 'orders/o3/items/i3' });

    // Файл заведомо есть: тот же экземпляр с драйвером LOCAL его только что создал.
    expect(await storage.exists(saved.objectKey)).toBe(true);
    // Драйвер S3 не должен «увидеть» его в локальном каталоге.
    expect(await makeS3().exists(saved.objectKey)).toBe(false);
  });
});

describe('Хранилище: удаление', () => {
  it('удаляет файл', async () => {
    const png = await makePng(100, 100);
    const saved = await storage.savePhoto({ buffer: png, folder: 'orders/o8/items/i8' });
    await storage.remove(saved.objectKey);
    expect(await storage.exists(saved.objectKey)).toBe(false);
  });

  it('удаление отсутствующего файла не бросает ошибку', async () => {
    // Повторное удаление не должно ломать операцию: файл мог быть убран ранее.
    await expect(storage.remove('orders/o9/items/i9/нет.jpg')).resolves.toBeUndefined();
  });
});
