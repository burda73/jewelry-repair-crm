-- Исправление словаря этапов в справочнике нормативов (дефект 26).
--
-- ПРОБЛЕМА. Существовали ТРИ несогласованных набора имён этапов:
--   1. справочник `stage_norm` — DISPATCH, DELIVERY_OUT, DELIVERY_IN, STORAGE;
--   2. домен (`ORDER_STAGE` в packages/shared) — QUEUE, LOGISTICS_OUT,
--      LOGISTICS_IN, PICKUP;
--   3. расчёт сроков искал норматив по имени СТАТУСА — QUEUED_FOR_DISPATCH,
--      IN_TRANSIT_TO_PRODUCTION, IN_TRANSIT_TO_STORE, READY_FOR_PICKUP.
--
-- Ни одно значение не совпадало, поэтому норматив не находился НИКОГДА и
-- `dueAt` не устанавливался, хотя справочник был заполнен (9 нормативов).
-- Проверено на проде: заказ MSK1-2609-000006 перешёл в QUEUED_FOR_DISPATCH
-- (переход с эффектом SET_DUE_AT) и остался с dueAt = NULL, а в истории
-- статусов поле `stage` содержало статус, а не этап.
--
-- ПОЧЕМУ ИМЕНА МЕНЯЮТСЯ В ТОЙ ЖЕ ВЕРСИИ, А НЕ СОЗДАЁТСЯ НОВАЯ. Версионирование
-- (задача 1.3.4) существует, чтобы по журналу объяснить сроки уже принятых
-- заказов. Здесь же меняются не значения нормативов, а ИСПРАВЛЯЮТСЯ их имена:
-- «24 рабочих часа для DISPATCH» и «24 рабочих часа для QUEUE» — один и тот же
-- норматив, названный так, чтобы расчёт мог его найти. Создание новой версии
-- оставило бы в истории строки, которые не найдёт ни один расчёт, — то есть
-- законсервировало бы дефект.
--
-- БЕЗОПАСНОСТЬ ПЕРЕИМЕНОВАНИЯ. Наборы имён не пересекаются, поэтому обновление
-- не может нарушить уникальный индекс `[version, stage, workType]`. Проверено
-- на проде до применения: в каждой версии не более одной строки на пару
-- (этап, тип работ), дублей нет.

-- 1. Нормативы: старые имена → канонические (NORM_STAGE).
UPDATE "stage_norm" SET "stage" = 'QUEUE'         WHERE "stage" = 'DISPATCH';
UPDATE "stage_norm" SET "stage" = 'LOGISTICS_OUT' WHERE "stage" = 'DELIVERY_OUT';
UPDATE "stage_norm" SET "stage" = 'LOGISTICS_IN'  WHERE "stage" = 'DELIVERY_IN';
UPDATE "stage_norm" SET "stage" = 'PICKUP'        WHERE "stage" = 'STORAGE';

-- 1b. Общий норматив производства для НЕРАСПОЗНАННОЙ сложности.
--
--     `Order.complexity` имеет значение по умолчанию `ANY`, а задать его пока
--     негде: калькуляция ещё не реализована (этап 1.7). В справочнике же были
--     только SIMPLE и COMPLEX, поэтому заказ с `complexity = 'ANY'` не нашёл бы
--     норматива — тот же дефект (срок не устанавливается), только по другой
--     причине. Проверено на проде: заказ MSK1-2609-000006 имеет complexity
--     'SIMPLE', но значение по умолчанию — 'ANY', и оно станет массовым, как
--     только появится создание заказов через интерфейс.
--
--     Значение 15 рабочих дней равно нормативу СЛОЖНОГО ремонта — намеренно
--     консервативно: нераспознанный заказ не должен получить обещание короче,
--     чем может потребовать работа. Конкретные SIMPLE/COMPLEX приоритетнее
--     (`pickStageNorm`), поэтому эта строка — запасной вариант.
--
--     `id` генерируется функцией: в схеме это `String @id @default(cuid())`,
--     но Prisma задаёт cuid на клиенте, а не в базе, поэтому в SQL значение
--     нужно построить явно. Формат cuid-подобный и уникальный.
INSERT INTO "stage_norm" (
  "id", "version", "stage", "workType", "value", "unit", "escalateToRole",
  "isActive", "effectiveFrom", "approvedById", "approvedAt", "createdAt"
)
SELECT
  'normseed' || substr(md5(random()::text || clock_timestamp()::text), 1, 16),
  src."version", 'PRODUCTION', 'ANY', 15, 'WORKDAY', 'PRODUCTION_MANAGER',
  src."isActive", src."effectiveFrom", src."approvedById", src."approvedAt", now()
FROM (
  SELECT DISTINCT "version", "isActive", "effectiveFrom", "approvedById", "approvedAt"
  FROM "stage_norm"
) AS src
WHERE NOT EXISTS (
  SELECT 1 FROM "stage_norm" n
  WHERE n."version" = src."version" AND n."stage" = 'PRODUCTION' AND n."workType" = 'ANY'
);

-- 2. История статусов: поле `stage` содержало СТАТУС (`QUEUED_FOR_DISPATCH`,
--    `ACCEPTED`, `CANCELLED`), из-за чего группировка «по этапам» давала
--    столько же групп, сколько статусов, и не сходилась со справочником
--    нормативов. Поле приводится к этапу; исходный статус остаётся в
--    `toStatus`, поэтому запись истории не теряет информации.
--
--    Терминальные статусы и `ACCEPTED` получают NULL: у них нет этапа с
--    нормативом (срок задаётся следующим этапом, а закрытый заказ никого не
--    торопит). NULL здесь означает «этап неприменим», а не «данные потеряны».
UPDATE "order_status_history"
SET "stage" = CASE "toStatus"::text
  WHEN 'AWAITING_APPROVAL'        THEN 'APPROVAL'
  WHEN 'AWAITING_PREPAYMENT'      THEN 'PREPAYMENT'
  WHEN 'QUEUED_FOR_DISPATCH'      THEN 'QUEUE'
  WHEN 'IN_TRANSIT_TO_PRODUCTION' THEN 'LOGISTICS_OUT'
  WHEN 'IN_PRODUCTION'            THEN 'PRODUCTION'
  WHEN 'REWORK'                   THEN 'PRODUCTION'
  WHEN 'IN_TRANSIT_TO_STORE'      THEN 'LOGISTICS_IN'
  WHEN 'READY_FOR_PICKUP'         THEN 'PICKUP'
  WHEN 'UNCLAIMED'                THEN 'PICKUP'
  WHEN 'DRAFT'                    THEN 'INTAKE'
  ELSE NULL
END
WHERE "stage" IS DISTINCT FROM CASE "toStatus"::text
  WHEN 'AWAITING_APPROVAL'        THEN 'APPROVAL'
  WHEN 'AWAITING_PREPAYMENT'      THEN 'PREPAYMENT'
  WHEN 'QUEUED_FOR_DISPATCH'      THEN 'QUEUE'
  WHEN 'IN_TRANSIT_TO_PRODUCTION' THEN 'LOGISTICS_OUT'
  WHEN 'IN_PRODUCTION'            THEN 'PRODUCTION'
  WHEN 'REWORK'                   THEN 'PRODUCTION'
  WHEN 'IN_TRANSIT_TO_STORE'      THEN 'LOGISTICS_IN'
  WHEN 'READY_FOR_PICKUP'         THEN 'PICKUP'
  WHEN 'UNCLAIMED'                THEN 'PICKUP'
  WHEN 'DRAFT'                    THEN 'INTAKE'
  ELSE NULL
END;

-- 3. Сроки уже принятых заказов, оставшиеся без `dueAt` из-за дефекта.
--
--    Пересчитывать их «назад» нельзя: норматив считается от момента входа в
--    статус, а этот момент для прежних переходов уже прошёл, и восстановленный
--    срок оказался бы в прошлом — заказ выглядел бы просроченным в день
--    появления исправления. Поэтому Backfill НЕ делается: новые переходы
--    получают срок сразу, а по прежним заказам срок появится при следующем
--    переходе. Это осознанное решение, а не пропуск; оно отражено в
--    docs/15-known-issues.md (дефект 26).
