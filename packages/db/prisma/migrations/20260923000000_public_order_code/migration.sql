-- Коды подтверждения для публичной проверки статуса заказа (задача 5.11).
--
-- ЗАЧЕМ ТАБЛИЦА. Публичный эндпоинт открыт без входа и отдаёт данные чужого
-- заказа по УГАДЫВАЕМОМУ номеру: формат «МСК1-2509-000001» содержит код
-- магазина, месяц и последовательный номер. Без второго фактора перебор номеров
-- давал бы чужие статусы и суммы, поэтому доступ требует кода, отправленного на
-- телефон клиента из этого заказа.
--
-- ПОЧЕМУ ХЕШ, А НЕ КОД. Четыре цифры — не секрет в смысле стойкости (их спасают
-- срок жизни и счётчик попыток), но открытый текст означал бы, что сотрудник с
-- доступом к базе или утечка дампа дают вход в чужой заказ без знания телефона
-- клиента. Хеш стоит одну операцию и убирает этот класс случаев.
--
-- Счётчик запросов идёт по нормализованному телефону, а не по IP: SMS платные, и
-- «выкачивают» их с множества адресов на один номер — ограничение по IP такой
-- сценарий не остановило бы.

CREATE TABLE "public_order_code" (
  "id"              TEXT NOT NULL,
  "orderId"         TEXT NOT NULL,
  "codeHash"        TEXT NOT NULL,
  "phoneNormalized" TEXT NOT NULL,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "usedAt"          TIMESTAMP(3),
  "ip"              TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "public_order_code_pkey" PRIMARY KEY ("id")
);

-- Удаление заказа уносит его коды: код без заказа бессмыслен и является лишними
-- персональными данными.
ALTER TABLE "public_order_code"
  ADD CONSTRAINT "public_order_code_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "public_order_code_orderId_idx" ON "public_order_code"("orderId");

-- Составной индекс под счётчик запросов: выборка идёт по паре
-- «телефон + окно времени», и раздельные индексы здесь не помогли бы.
CREATE INDEX "public_order_code_phoneNormalized_createdAt_idx"
  ON "public_order_code"("phoneNormalized", "createdAt");

-- Индекс под очистку истёкших кодов: их удаляет воркер, и без индекса он
-- сканировал бы таблицу целиком.
CREATE INDEX "public_order_code_expiresAt_idx" ON "public_order_code"("expiresAt");
