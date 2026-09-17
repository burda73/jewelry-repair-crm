/**
 * Проверка выбора цены по металлу.
 *
 * Здесь сосредоточен денежный риск: неверный выбор ставки означает неверную
 * сумму в квитанции. На сервере эта же функция используется для проверки
 * присланной цены, поэтому ослабление логики ослабило бы и защиту от
 * подделки суммы.
 */

import { describe, expect, it } from 'vitest';
import { calcWorksTotalByMetal, resolveItemPrice } from './price-by-metal.js';

/** Позиция с двумя ставками — как в реальном прейскуранте (позиция 1). */
const SOLDER = {
  priceMinor: 90000, // цена по умолчанию = золото
  priceFrom: false,
  metalCostSeparate: false,
  rates: [
    { metal: 'GOLD', priceMinor: 90000, isFrom: false },
    { metal: 'SILVER', priceMinor: 45000, isFrom: false },
  ],
};

describe('Выбор цены по металлу', () => {
  it('берёт ставку по металлу изделия', () => {
    expect(resolveItemPrice(SOLDER, 'GOLD').priceMinor).toBe(90000);
    expect(resolveItemPrice(SOLDER, 'SILVER').priceMinor).toBe(45000);
    expect(resolveItemPrice(SOLDER, 'SILVER').fromMetalRate).toBe(true);
    expect(resolveItemPrice(SOLDER, 'SILVER').usedFallback).toBe(false);
  });

  it('для серебра НЕ берёт цену золота', () => {
    // Главная проверка: если бы ставка игнорировалась, серебряный ремонт
    // стоил бы вдвое дороже — 900 ₽ вместо 450 ₽.
    const silver = resolveItemPrice(SOLDER, 'SILVER');
    expect(silver.priceMinor).not.toBe(SOLDER.priceMinor);
    expect(silver.priceMinor).toBe(45000);
  });

  it('без металла использует цену по умолчанию и помечает это', () => {
    for (const metal of [null, undefined, '']) {
      const result = resolveItemPrice(SOLDER, metal);
      expect(result.priceMinor).toBe(90000);
      expect(result.usedFallback).toBe(true);
      expect(result.fromMetalRate).toBe(false);
    }
  });

  it('неизвестный металл — цена по умолчанию с пометкой', () => {
    // Платина есть в перечислении, но ставки по ней в прейскуранте нет:
    // подставлять золотую цену молча нельзя, поэтому usedFallback = true.
    const result = resolveItemPrice(SOLDER, 'PLATINUM');
    expect(result.priceMinor).toBe(90000);
    expect(result.usedFallback).toBe(true);
  });

  it('позиция без разбивки по металлам работает одинаково для всех', () => {
    // Мойка в ультразвуке: цена не зависит от металла.
    const ultrasonic = { priceMinor: 30000, rates: [] };
    expect(resolveItemPrice(ultrasonic, 'GOLD').priceMinor).toBe(30000);
    expect(resolveItemPrice(ultrasonic, 'SILVER').priceMinor).toBe(30000);
    // Ставок нет вовсе — это и есть цена по умолчанию, помечаем честно.
    expect(resolveItemPrice(ultrasonic, 'GOLD').usedFallback).toBe(true);
  });

  it('«от» берётся из выбранной ставки, а не из позиции целиком', () => {
    /*
     * Смешанный случай: у золота фиксированная цена, у серебра — «от».
     * Признак позиции `priceFrom` здесь false, и для золота результат обязан
     * быть false, а для серебра — true. Если бы брали признак позиции,
     * серебряная цена выглядела бы окончательной.
     */
    const mixed = {
      priceMinor: 100000,
      priceFrom: false,
      rates: [
        { metal: 'GOLD', priceMinor: 100000, isFrom: false },
        { metal: 'SILVER', priceMinor: 50000, isFrom: true },
      ],
    };
    expect(resolveItemPrice(mixed, 'GOLD').isFrom).toBe(false);
    expect(resolveItemPrice(mixed, 'SILVER').isFrom).toBe(true);
  });

  it('признак цены по умолчанию «от» работает, когда ставки нет', () => {
    const fromOnly = { priceMinor: 7500, priceFrom: true, rates: [] };
    expect(resolveItemPrice(fromOnly, 'GOLD').isFrom).toBe(true);
    expect(resolveItemPrice(fromOnly, null).isFrom).toBe(true);
  });

  it('переносит признак «стоимость металла отдельно»', () => {
    // Позиция 24: «от» и металл отдельно одновременно.
    const separate = {
      priceMinor: 300000,
      priceFrom: true,
      metalCostSeparate: true,
      rates: [
        { metal: 'GOLD', priceMinor: 300000, isFrom: true },
        { metal: 'SILVER', priceMinor: 225000, isFrom: true },
      ],
    };
    const result = resolveItemPrice(separate, 'SILVER');
    expect(result.metalCostSeparate).toBe(true);
    expect(result.priceMinor).toBe(225000);
    expect(result.isFrom).toBe(true);
  });

  it('считает стоимость работ с учётом металла и количества', () => {
    const total = calcWorksTotalByMetal([
      { item: SOLDER, metal: 'SILVER', quantity: 2 }, // 450 × 2 = 900
      { item: SOLDER, metal: 'GOLD', quantity: 1 }, // 900 × 1 = 900
    ]);
    expect(total).toBe(180000);
  });

  it('итог по серебру вдвое меньше, чем по золоту, при равных работах', () => {
    const gold = calcWorksTotalByMetal([{ item: SOLDER, metal: 'GOLD', quantity: 1 }]);
    const silver = calcWorksTotalByMetal([{ item: SOLDER, metal: 'SILVER', quantity: 1 }]);
    expect(gold).toBe(90000);
    expect(silver).toBe(45000);
  });

  it('возвращает целые копейки, пригодные для расчёта', () => {
    const result = resolveItemPrice(SOLDER, 'SILVER');
    expect(Number.isSafeInteger(result.priceMinor)).toBe(true);
  });

  it('принимает свободный текст металла, а не только код', () => {
    /*
     * Регрессия на реальный дефект. В базе металл изделия хранится текстом
     * («Серебро», «Au585»), а ставки адресуются кодами (`SILVER`). Пока
     * сравнение шло напрямую, «Серебро» никогда не совпадало с `SILVER`,
     * применялась цена по умолчанию, и серебряный заказ считался по золотому
     * тарифу — вдвое дороже. Молча, без единой ошибки в логах.
     */
    expect(resolveItemPrice(SOLDER, 'Серебро').priceMinor).toBe(45000);
    expect(resolveItemPrice(SOLDER, 'серебро 925').priceMinor).toBe(45000);
    expect(resolveItemPrice(SOLDER, 'Ag925').priceMinor).toBe(45000);
    expect(resolveItemPrice(SOLDER, 'Золото 585').priceMinor).toBe(90000);
    expect(resolveItemPrice(SOLDER, 'Au585').priceMinor).toBe(90000);

    // И в этих случаях цена взята именно из ставки, без запасного варианта.
    expect(resolveItemPrice(SOLDER, 'Серебро').usedFallback).toBe(false);
    expect(resolveItemPrice(SOLDER, 'Серебро').fromMetalRate).toBe(true);
  });

  it('код металла и его текст дают одинаковый результат', () => {
    // Коды и текст — два представления одного и того же; расхождение между
    // ними означало бы разную цену у сервера и у интерфейса.
    for (const [code, text] of [
      ['GOLD', 'Золото 585'],
      ['SILVER', 'Серебро 925'],
    ] as const) {
      const byCode = resolveItemPrice(SOLDER, code);
      const byText = resolveItemPrice(SOLDER, text);
      expect(byText.priceMinor).toBe(byCode.priceMinor);
      expect(byText.usedFallback).toBe(byCode.usedFallback);
    }
  });

  it('не распознанный текст металла даёт цену по умолчанию', () => {
    // Угадывать нельзя: ошибка здесь — ошибка в деньгах клиента.
    const result = resolveItemPrice(SOLDER, 'нержавеющая сталь');
    expect(result.priceMinor).toBe(90000);
    expect(result.usedFallback).toBe(true);
  });
});
