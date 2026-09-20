-- Дефект 76: цех-отправитель партии «в магазин».
--
-- Поля не было, поэтому отправку из цеха можно было записать только как «из
-- магазина»: в акте приёма-передачи отправителем значился магазин, хотя изделия
-- передал цех. Столбец nullable — партии «в цех» отправляет магазин, и для них
-- он остаётся пустым.
ALTER TABLE "batch" ADD COLUMN "fromWorkshopId" TEXT;

ALTER TABLE "batch" ADD CONSTRAINT "batch_fromWorkshopId_fkey"
  FOREIGN KEY ("fromWorkshopId") REFERENCES "workshop"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
