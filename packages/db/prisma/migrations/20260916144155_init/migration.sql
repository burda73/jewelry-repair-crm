-- CreateEnum
CREATE TYPE "role_code" AS ENUM ('RECEIVER', 'PRODUCTION_MANAGER', 'LOGISTICIAN', 'CASHIER', 'MANAGER', 'ADMIN', 'AUDITOR', 'CHIEF_ACCOUNTANT');

-- CreateEnum
CREATE TYPE "data_scope" AS ENUM ('STORE', 'STORE_PLUS_GLOBAL_SEARCH', 'PRODUCTION', 'ALL_STORES', 'READ_ALL');

-- CreateEnum
CREATE TYPE "price_list_status" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ARCHIVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'AWAITING_PREPAYMENT', 'ACCEPTED', 'QUEUED_FOR_DISPATCH', 'IN_TRANSIT_TO_PRODUCTION', 'IN_PRODUCTION', 'IN_TRANSIT_TO_STORE', 'READY_FOR_PICKUP', 'UNCLAIMED', 'COMPLETED', 'REFUSED', 'CANCELLED', 'REWORK');

-- CreateEnum
CREATE TYPE "priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "approval_channel" AS ENUM ('IN_PERSON', 'PHONE_VERBAL', 'SMS', 'MESSENGER', 'EMAIL');

-- CreateEnum
CREATE TYPE "approval_result" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NO_ANSWER', 'CHANGED');

-- CreateEnum
CREATE TYPE "payment_kind" AS ENUM ('PREPAYMENT', 'FINAL', 'ADDITIONAL', 'REFUND', 'REVERSAL');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "batch_status" AS ENUM ('DRAFT', 'ACT_FORMED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "batch_direction" AS ENUM ('TO_PRODUCTION', 'TO_STORE');

-- CreateEnum
CREATE TYPE "claim_status" AS ENUM ('OPENED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RESOLVED_REPAIR', 'RESOLVED_REFUND', 'CLOSED');

-- CreateEnum
CREATE TYPE "notification_channel_type" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'MESSENGER', 'PUSH');

-- CreateTable
CREATE TABLE "store" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workshop" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workshop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "role_code" NOT NULL,
    "storeId" TEXT,
    "scope" "data_scope" NOT NULL DEFAULT 'STORE',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedById" TEXT,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_store" (
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_store_pkey" PRIMARY KEY ("userId","storeId")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actorId" TEXT,
    "actorRole" "role_code",
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "storeId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_calendar" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "date" DATE NOT NULL,
    "isWorkday" BOOLEAN NOT NULL,
    "hours" INTEGER NOT NULL DEFAULT 8,
    "note" TEXT,

    CONSTRAINT "working_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_version" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storeId" TEXT,
    "status" "price_list_status" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "comment" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_list_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_category" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "work_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_item" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "categoryId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'шт',
    "priceMinor" INTEGER NOT NULL,
    "costMinor" INTEGER,
    "durationHours" INTEGER,
    "warrantyMonths" INTEGER NOT NULL DEFAULT 6,
    "requiresPrepayment" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "price_list_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stone_type" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'шт',
    "priceMinor" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stone_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "email" TEXT,
    "birthDate" TIMESTAMP(3),
    "consentCallRecording" BOOLEAN NOT NULL DEFAULT false,
    "consentMarketing" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'DRAFT',
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "customerId" TEXT NOT NULL,
    "createdStoreId" TEXT NOT NULL,
    "pickupStoreId" TEXT NOT NULL,
    "workshopId" TEXT,
    "createdById" TEXT NOT NULL,
    "productionManagerId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "worksTotalMinor" INTEGER NOT NULL DEFAULT 0,
    "stonesTotalMinor" INTEGER NOT NULL DEFAULT 0,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "totalAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "paidAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "prepaymentRequiredMinor" INTEGER NOT NULL DEFAULT 0,
    "requiresPrepayment" BOOLEAN NOT NULL DEFAULT false,
    "priceListVersionId" TEXT,
    "priceFixedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "promisedAt" TIMESTAMP(3),
    "complexity" TEXT NOT NULL DEFAULT 'ANY',
    "acceptedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "prepaymentConfirmedAt" TIMESTAMP(3),
    "productionStartedAt" TIMESTAMP(3),
    "productionFinishedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "pickupSignatureFileId" TEXT,
    "qrPayload" TEXT,
    "receiptPrintCount" INTEGER NOT NULL DEFAULT 0,
    "receiptLastPrintedAt" TIMESTAMP(3),
    "isWarranty" BOOLEAN NOT NULL DEFAULT false,
    "parentOrderId" TEXT,
    "warrantyMonths" INTEGER NOT NULL DEFAULT 6,
    "warrantyUntil" TIMESTAMP(3),
    "description" TEXT,
    "diagnosis" TEXT,
    "cancelReason" TEXT,
    "refusalReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "order_status",
    "toStatus" "order_status" NOT NULL,
    "stage" TEXT,
    "changedById" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "dueAtBefore" TIMESTAMP(3),
    "dueAtAfter" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metal" TEXT,
    "weightGram" DECIMAL(10,3),
    "size" TEXT,
    "hallmark" TEXT,
    "defects" TEXT,
    "completeness" TEXT,
    "inventoryNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_object" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainUntil" TIMESTAMP(3),

    CONSTRAINT "file_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_photo" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'INTAKE',
    "caption" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_work" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT,
    "priceListItemId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'шт',
    "unitPriceMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "durationHours" INTEGER,
    "warrantyMonths" INTEGER NOT NULL DEFAULT 6,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_work_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_stone" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT,
    "stoneTypeId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "caratWeight" DECIMAL(10,3),
    "unitPriceMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "comment" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_stone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calc_adjustment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "amountBeforeMinor" INTEGER NOT NULL,
    "amountAfterMinor" INTEGER NOT NULL,
    "deltaMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "adjustedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calc_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" "approval_channel" NOT NULL,
    "result" "approval_result" NOT NULL DEFAULT 'PENDING',
    "isVerbal" BOOLEAN NOT NULL DEFAULT false,
    "amountMinor" INTEGER NOT NULL,
    "termDays" INTEGER,
    "promisedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_recording" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "approvalId" TEXT,
    "customerId" TEXT,
    "fileId" TEXT,
    "externalId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "phoneFrom" TEXT,
    "phoneTo" TEXT,
    "extension" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "matchedBy" TEXT,
    "matchScore" DECIMAL(5,2),
    "linkedById" TEXT,
    "linkedAt" TIMESTAMP(3),
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_recording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "payment_kind" NOT NULL,
    "method" "payment_method" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'CONFIRMED',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "storeId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "receiptNo" TEXT,
    "kktShiftNo" TEXT,
    "fiscalDocNo" TEXT,
    "externalId" TEXT,
    "externalSystem" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncError" TEXT,
    "comment" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refusal_act" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "actNo" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "storageUntil" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3),
    "fileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refusal_act_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch" (
    "id" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "direction" "batch_direction" NOT NULL,
    "status" "batch_status" NOT NULL DEFAULT 'DRAFT',
    "fromStoreId" TEXT,
    "toStoreId" TEXT,
    "toWorkshopId" TEXT,
    "courierId" TEXT,
    "plannedAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "comment" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_item" (
    "batchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removeReason" TEXT,

    CONSTRAINT "batch_item_pkey" PRIMARY KEY ("batchId","orderId")
);

-- CreateTable
CREATE TABLE "batch_act" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "actNo" TEXT NOT NULL,
    "pdfFileId" TEXT,
    "signedByFromId" TEXT,
    "signedByToId" TEXT,
    "signedFromAt" TIMESTAMP(3),
    "signedToAt" TIMESTAMP(3),
    "itemsSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_act_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_photo" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "caption" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performer" (
    "id" TEXT NOT NULL,
    "workshopId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "specialization" TEXT,
    "grade" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_assignment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "performerId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "plannedHours" INTEGER,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_norm" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "workType" TEXT NOT NULL DEFAULT 'ANY',
    "value" INTEGER NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'WORKDAY',
    "escalateToRole" "role_code",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_norm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_claim" (
    "id" TEXT NOT NULL,
    "claimNo" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "claim_status" NOT NULL DEFAULT 'OPENED',
    "reason" TEXT NOT NULL,
    "clientStatement" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reviewerId" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "isWarrantyCase" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warranty_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "batchId" TEXT,
    "type" TEXT NOT NULL,
    "number" TEXT,
    "fileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_template" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "channel" "notification_channel_type" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'ru',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "customerId" TEXT,
    "orderId" TEXT,
    "templateCode" TEXT NOT NULL,
    "channel" "notification_channel_type" NOT NULL DEFAULT 'IN_APP',
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_outbox" (
    "id" TEXT NOT NULL,
    "system" TEXT NOT NULL DEFAULT '1C',
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_log" (
    "id" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestId" TEXT,
    "statusCode" INTEGER,
    "success" BOOLEAN NOT NULL,
    "request" JSONB,
    "response" JSONB,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counter" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_code_key" ON "store"("code");

-- CreateIndex
CREATE UNIQUE INDEX "workshop_code_key" ON "workshop"("code");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_isActive_idx" ON "user"("isActive");

-- CreateIndex
CREATE INDEX "user_role_userId_idx" ON "user_role"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_userId_role_storeId_key" ON "user_role"("userId", "role", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "user_session_refreshHash_key" ON "user_session"("refreshHash");

-- CreateIndex
CREATE INDEX "user_session_userId_idx" ON "user_session"("userId");

-- CreateIndex
CREATE INDEX "user_session_expiresAt_idx" ON "user_session"("expiresAt");

-- CreateIndex
CREATE INDEX "audit_log_entity_entityId_idx" ON "audit_log"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_actorId_createdAt_idx" ON "audit_log"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "working_calendar_date_idx" ON "working_calendar"("date");

-- CreateIndex
CREATE UNIQUE INDEX "working_calendar_storeId_date_key" ON "working_calendar"("storeId", "date");

-- CreateIndex
CREATE INDEX "price_list_version_status_effectiveFrom_idx" ON "price_list_version"("status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_version_storeId_version_key" ON "price_list_version"("storeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "work_category_code_key" ON "work_category"("code");

-- CreateIndex
CREATE INDEX "price_list_item_priceListId_isActive_idx" ON "price_list_item"("priceListId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_item_priceListId_code_key" ON "price_list_item"("priceListId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "stone_type_code_key" ON "stone_type"("code");

-- CreateIndex
CREATE INDEX "customer_phoneNormalized_idx" ON "customer"("phoneNormalized");

-- CreateIndex
CREATE INDEX "customer_fullName_idx" ON "customer"("fullName");

-- CreateIndex
CREATE UNIQUE INDEX "order_orderNo_key" ON "order"("orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "order_qrPayload_key" ON "order"("qrPayload");

-- CreateIndex
CREATE INDEX "order_status_dueAt_idx" ON "order"("status", "dueAt");

-- CreateIndex
CREATE INDEX "order_createdStoreId_status_idx" ON "order"("createdStoreId", "status");

-- CreateIndex
CREATE INDEX "order_customerId_idx" ON "order"("customerId");

-- CreateIndex
CREATE INDEX "order_createdAt_idx" ON "order"("createdAt");

-- CreateIndex
CREATE INDEX "order_productionManagerId_status_idx" ON "order"("productionManagerId", "status");

-- CreateIndex
CREATE INDEX "order_status_history_orderId_createdAt_idx" ON "order_status_history"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_status_history_toStatus_createdAt_idx" ON "order_status_history"("toStatus", "createdAt");

-- CreateIndex
CREATE INDEX "item_orderId_idx" ON "item"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "file_object_objectKey_key" ON "file_object"("objectKey");

-- CreateIndex
CREATE INDEX "file_object_retainUntil_idx" ON "file_object"("retainUntil");

-- CreateIndex
CREATE INDEX "item_photo_itemId_idx" ON "item_photo"("itemId");

-- CreateIndex
CREATE INDEX "order_work_orderId_idx" ON "order_work"("orderId");

-- CreateIndex
CREATE INDEX "order_stone_orderId_idx" ON "order_stone"("orderId");

-- CreateIndex
CREATE INDEX "calc_adjustment_orderId_idx" ON "calc_adjustment"("orderId");

-- CreateIndex
CREATE INDEX "approval_orderId_idx" ON "approval"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "call_recording_externalId_key" ON "call_recording"("externalId");

-- CreateIndex
CREATE INDEX "call_recording_orderId_idx" ON "call_recording"("orderId");

-- CreateIndex
CREATE INDEX "call_recording_phoneFrom_startedAt_idx" ON "call_recording"("phoneFrom", "startedAt");

-- CreateIndex
CREATE INDEX "call_recording_phoneTo_startedAt_idx" ON "call_recording"("phoneTo", "startedAt");

-- CreateIndex
CREATE INDEX "call_recording_retainUntil_idx" ON "call_recording"("retainUntil");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotencyKey_key" ON "payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_orderId_status_idx" ON "payment"("orderId", "status");

-- CreateIndex
CREATE INDEX "payment_storeId_paidAt_idx" ON "payment"("storeId", "paidAt");

-- CreateIndex
CREATE INDEX "payment_syncStatus_idx" ON "payment"("syncStatus");

-- CreateIndex
CREATE INDEX "payment_paidAt_idx" ON "payment"("paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "refusal_act_orderId_key" ON "refusal_act"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "refusal_act_actNo_key" ON "refusal_act"("actNo");

-- CreateIndex
CREATE UNIQUE INDEX "refusal_act_fileId_key" ON "refusal_act"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_batchNo_key" ON "batch"("batchNo");

-- CreateIndex
CREATE INDEX "batch_status_plannedAt_idx" ON "batch"("status", "plannedAt");

-- CreateIndex
CREATE INDEX "batch_item_orderId_idx" ON "batch_item"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_act_actNo_key" ON "batch_act"("actNo");

-- CreateIndex
CREATE UNIQUE INDEX "batch_act_pdfFileId_key" ON "batch_act"("pdfFileId");

-- CreateIndex
CREATE INDEX "batch_act_batchId_idx" ON "batch_act"("batchId");

-- CreateIndex
CREATE INDEX "performer_workshopId_isActive_idx" ON "performer"("workshopId", "isActive");

-- CreateIndex
CREATE INDEX "order_assignment_orderId_idx" ON "order_assignment"("orderId");

-- CreateIndex
CREATE INDEX "order_assignment_performerId_status_idx" ON "order_assignment"("performerId", "status");

-- CreateIndex
CREATE INDEX "stage_norm_stage_isActive_idx" ON "stage_norm"("stage", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "stage_norm_version_stage_workType_key" ON "stage_norm"("version", "stage", "workType");

-- CreateIndex
CREATE UNIQUE INDEX "warranty_claim_claimNo_key" ON "warranty_claim"("claimNo");

-- CreateIndex
CREATE INDEX "warranty_claim_orderId_idx" ON "warranty_claim"("orderId");

-- CreateIndex
CREATE INDEX "warranty_claim_status_dueAt_idx" ON "warranty_claim"("status", "dueAt");

-- CreateIndex
CREATE INDEX "document_orderId_idx" ON "document"("orderId");

-- CreateIndex
CREATE INDEX "document_batchId_idx" ON "document"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_code_key" ON "notification_template"("code");

-- CreateIndex
CREATE INDEX "notification_userId_status_idx" ON "notification"("userId", "status");

-- CreateIndex
CREATE INDEX "notification_status_createdAt_idx" ON "notification"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "integration_outbox_idempotencyKey_key" ON "integration_outbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "integration_outbox_status_nextRetryAt_idx" ON "integration_outbox"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "integration_outbox_aggregateType_aggregateId_idx" ON "integration_outbox"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "integration_log_system_createdAt_idx" ON "integration_log"("system", "createdAt");

-- CreateIndex
CREATE INDEX "integration_log_success_createdAt_idx" ON "integration_log"("success", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "counter_scope_key" ON "counter"("scope");

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_store" ADD CONSTRAINT "user_store_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_store" ADD CONSTRAINT "user_store_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_calendar" ADD CONSTRAINT "working_calendar_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_version" ADD CONSTRAINT "price_list_version_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "price_list_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "work_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_createdStoreId_fkey" FOREIGN KEY ("createdStoreId") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_pickupStoreId_fkey" FOREIGN KEY ("pickupStoreId") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_workshopId_fkey" FOREIGN KEY ("workshopId") REFERENCES "workshop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_productionManagerId_fkey" FOREIGN KEY ("productionManagerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_priceListVersionId_fkey" FOREIGN KEY ("priceListVersionId") REFERENCES "price_list_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_photo" ADD CONSTRAINT "item_photo_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_photo" ADD CONSTRAINT "item_photo_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_work" ADD CONSTRAINT "order_work_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_work" ADD CONSTRAINT "order_work_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_work" ADD CONSTRAINT "order_work_priceListItemId_fkey" FOREIGN KEY ("priceListItemId") REFERENCES "price_list_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_work" ADD CONSTRAINT "order_work_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stone" ADD CONSTRAINT "order_stone_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stone" ADD CONSTRAINT "order_stone_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stone" ADD CONSTRAINT "order_stone_stoneTypeId_fkey" FOREIGN KEY ("stoneTypeId") REFERENCES "stone_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stone" ADD CONSTRAINT "order_stone_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calc_adjustment" ADD CONSTRAINT "calc_adjustment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calc_adjustment" ADD CONSTRAINT "calc_adjustment_adjustedById_fkey" FOREIGN KEY ("adjustedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recording" ADD CONSTRAINT "call_recording_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recording" ADD CONSTRAINT "call_recording_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recording" ADD CONSTRAINT "call_recording_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recording" ADD CONSTRAINT "call_recording_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refusal_act" ADD CONSTRAINT "refusal_act_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refusal_act" ADD CONSTRAINT "refusal_act_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_fromStoreId_fkey" FOREIGN KEY ("fromStoreId") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_toStoreId_fkey" FOREIGN KEY ("toStoreId") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_toWorkshopId_fkey" FOREIGN KEY ("toWorkshopId") REFERENCES "workshop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_item" ADD CONSTRAINT "batch_item_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_item" ADD CONSTRAINT "batch_item_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_act" ADD CONSTRAINT "batch_act_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_act" ADD CONSTRAINT "batch_act_pdfFileId_fkey" FOREIGN KEY ("pdfFileId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_photo" ADD CONSTRAINT "batch_photo_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_photo" ADD CONSTRAINT "batch_photo_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performer" ADD CONSTRAINT "performer_workshopId_fkey" FOREIGN KEY ("workshopId") REFERENCES "workshop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_assignment" ADD CONSTRAINT "order_assignment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_assignment" ADD CONSTRAINT "order_assignment_performerId_fkey" FOREIGN KEY ("performerId") REFERENCES "performer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_assignment" ADD CONSTRAINT "order_assignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_claim" ADD CONSTRAINT "warranty_claim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_claim" ADD CONSTRAINT "warranty_claim_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
