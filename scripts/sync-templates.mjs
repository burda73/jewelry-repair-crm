#!/usr/bin/env node
/**
 * Синхронизация шаблонов уведомлений на боевом сервере.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Шаблоны — настроечные данные, и очистка тестовых
 * данных их сохраняет. Но пока список жил только в `seed.ts`, на боевом сервере
 * их неоткуда было взять: сид создаёт демонстрационные заказы и учётные записи,
 * и запускать его в продакшне нельзя. Новый шаблон появлялся в коде, тесты
 * проходили, а на сервере уведомление уходило по ЗАПАСНОМУ тексту: работало, но
 * не так, как задумано, — и заметить это можно было только прочитав сообщение.
 *
 * ПОЧЕМУ ТОЛЬКО ДОБАВЛЯЕТ, НО НЕ ПЕРЕЗАПИСЫВАЕТ. Текст шаблона может быть
 * изменён администратором под свою формулировку. Развёртывание, переписывающее
 * его обратно, отменяло бы правку при каждом выпуске. Поэтому существующие
 * записи не трогаются, а расхождение печатается: его видно, но решение
 * остаётся за человеком. Для намеренного обновления есть `--update-texts`.
 *
 * Использование:
 *   node scripts/sync-templates.mjs
 *   node scripts/sync-templates.mjs --update-texts
 *   DATABASE_URL=... node scripts/sync-templates.mjs
 */

import { PrismaClient } from '@prisma/client';
import { NOTIFICATION_TEMPLATES } from '@app/shared';

const updateTexts = process.argv.includes('--update-texts');

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.notificationTemplate.findMany({
    select: { code: true, channel: true, subject: true, body: true, isActive: true },
  });
  /*
   * Ключ — ПАРА «код + канал», а не один код. У одного кода два текста: короткий
   * для интерфейса и подробный для почты. Поиск по коду находил бы первый
   * попавшийся, считал его «существующим» и не создавал второй шаблон — почта
   * молча уходила бы по запасному тексту.
   */
  const byKey = new Map(
    existing.map((template) => [`${template.code}|${template.channel}`, template]),
  );

  let created = 0;
  let updated = 0;
  const drifted = [];

  for (const template of NOTIFICATION_TEMPLATES) {
    const current = byKey.get(`${template.code}|${template.channel}`);

    if (current === undefined) {
      await prisma.notificationTemplate.create({
        data: { ...template, locale: 'ru', isActive: true },
      });
      created += 1;
      continue;
    }

    if (current.subject === template.subject && current.body === template.body) continue;

    if (updateTexts) {
      await prisma.notificationTemplate.update({
        where: { code_channel: { code: template.code, channel: template.channel } },
        data: { subject: template.subject, body: template.body },
      });
      updated += 1;
      continue;
    }

    drifted.push(`${template.code} (${template.channel})`);
  }

  console.log(`Шаблонов в справочнике: ${NOTIFICATION_TEMPLATES.length}`);
  console.log(`  добавлено:        ${created}`);
  console.log(`  обновлено:        ${updated}`);
  console.log(`  расходится с кодом: ${drifted.length}`);
  for (const code of drifted) {
    console.log(`    ${code} — текст на сервере отличается (не перезаписан)`);
  }
  if (drifted.length > 0 && !updateTexts) {
    console.log('Для обновления текстов: node scripts/sync-templates.mjs --update-texts');
  }
}

main()
  .catch((error) => {
    console.error('Синхронизация не выполнена:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
