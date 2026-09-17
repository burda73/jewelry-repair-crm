-- CreateEnum
CREATE TYPE "metal_kind" AS ENUM ('GOLD', 'SILVER', 'PLATINUM');

-- AlterTable
ALTER TABLE "price_list_item" ADD COLUMN     "metalCostSeparate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceFrom" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "price_list_item_rate" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "metal" "metal_kind" NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "isFrom" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "price_list_item_rate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_list_item_rate_metal_idx" ON "price_list_item_rate"("metal");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_item_rate_itemId_metal_key" ON "price_list_item_rate"("itemId", "metal");

-- AddForeignKey
ALTER TABLE "price_list_item_rate" ADD CONSTRAINT "price_list_item_rate_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "price_list_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
