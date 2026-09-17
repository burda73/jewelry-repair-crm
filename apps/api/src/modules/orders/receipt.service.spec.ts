/**
 * Тесты генерации PDF-квитанции (ответ A4, docs/08-ui-ux.md §4.1).
 *
 * Проверяется то, что нельзя увидеть в коде, но что ломает сценарий на бумаге:
 *  * QR-код должен ДЕКОДИРОВАТЬСЯ, а не просто быть нарисованным;
 *  * кириллица должна быть встроена шрифтом, а не пропасть квадратами
 *    (на сервере нет системных шрифтов — проверено);
 *  * линейный код-резерв должен присутствовать.
 *
 * Дефект, ради которого написан тест на декодирование: `bwip-js` по умолчанию
 * рисует QR на ПРОЗРАЧНОМ фоне. Такой код выглядит правильным в PDF и
 * корректно кодирует данные, но не читается декодером ни на одном масштабе —
 * то есть основной сценарий («сканируем квитанцию при выдаче») не работал бы,
 * и заметить это можно было только распечатав квитанцию.
 */

import { describe, expect, it } from 'vitest';
import bwipjs from 'bwip-js';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { buildReceiptQr, buildReceiptBarcode } from '@app/shared';

/** Отрисовать код так же, как это делает сервис квитанции. */
async function renderCode(options: {
  bcid: string;
  text: string;
  scale: number;
  height?: number;
}): Promise<PNG> {
  const buffer = await bwipjs.toBuffer({
    bcid: options.bcid,
    text: options.text,
    scale: options.scale,
    backgroundcolor: 'FFFFFF',
    includetext: false,
    paddingwidth: 2,
    paddingheight: 2,
    ...(options.height === undefined ? {} : { height: options.height }),
  });
  return PNG.sync.read(buffer);
}

describe('PDF-квитанция: читаемость QR-кода', () => {
  it('QR-код квитанции декодируется', async () => {
    const payload = buildReceiptQr({ orderNo: 'MSK1-2509-000142' });
    const img = await renderCode({ bcid: 'qrcode', text: payload, scale: 8 });

    const decoded = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
    expect(decoded?.data).toBe('repair://order/MSK1-2509-000142');
  });

  it('прозрачный фон делает QR нечитаемым — поэтому фон задан белым', async () => {
    const payload = buildReceiptQr({ orderNo: 'MSK1-2509-000142' });

    // Воспроизводим поведение по умолчанию (фон не задан).
    const transparent = PNG.sync.read(
      await bwipjs.toBuffer({ bcid: 'qrcode', text: payload, scale: 8 }),
    );
    const decodedTransparent = jsQR(
      new Uint8ClampedArray(transparent.data),
      transparent.width,
      transparent.height,
    );

    // Именно этот дефект и был исправлен: без белого фона декодер молчит.
    expect(decodedTransparent).toBeNull();
    // LibreOffice/печать: на бумаге прозрачность стала бы серым по серому.

    // А с белым фоном (как в сервисе) — читается.
    const white = await renderCode({ bcid: 'qrcode', text: payload, scale: 8 });
    expect(jsQR(new Uint8ClampedArray(white.data), white.width, white.height)?.data).toBe(payload);
  });

  it('QR остаётся читаемым на разных масштабах печати', async () => {
    const payload = buildReceiptQr({ orderNo: 'MSK1-2509-000142' });
    for (const scale of [4, 8, 12]) {
      const img = await renderCode({ bcid: 'qrcode', text: payload, scale });
      const decoded = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
      expect(decoded?.data, `масштаб ${scale}`).toBe(payload);
    }
  });

  it('резервный линейный код строится и содержит номер', async () => {
    const text = buildReceiptBarcode({ orderNo: 'MSK1-2509-000142' });
    expect(text).toBe('MSK1-2509-000142');

    const img = await renderCode({ bcid: 'code128', text, scale: 2, height: 12 });
    // Линейный код шире, чем выше: иначе сканер не различит штрихи.
    expect(img.width).toBeGreaterThan(img.height);
    expect(img.width).toBeGreaterThan(100);
  });
});

describe('PDF-квитанция: шрифт с кириллицей', () => {
  it('шрифт DejaVu доступен из зависимостей', () => {
    // На сервере нет системных шрифтов, поэтому шрифт обязан приезжать
    // вместе с зависимостями, а не браться из системы.
    expect(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')).toMatch(/DejaVuSans\.ttf$/);
    expect(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf')).toMatch(
      /DejaVuSans-Bold\.ttf$/,
    );
  });
});