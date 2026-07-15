-- CreateEnum
CREATE TYPE "StoreCategory" AS ENUM ('ecommerce', 'quick_commerce');

-- CreateEnum
CREATE TYPE "StoreHealth" AS ENUM ('healthy', 'degraded', 'down');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('tracking', 'paused', 'error');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('price_decrease', 'price_increase', 'discount_change', 'new_offer', 'pincode_available');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('info', 'warn', 'error');

-- CreateTable
CREATE TABLE "Owner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "telegramChatId" TEXT,
    "telegramBotToken" TEXT,
    "checkIntervalMin" INTEGER NOT NULL DEFAULT 30,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "pauseTracking" BOOLEAN NOT NULL DEFAULT false,
    "alertPriceDecrease" BOOLEAN NOT NULL DEFAULT true,
    "alertPriceIncrease" BOOLEAN NOT NULL DEFAULT true,
    "alertDiscountChange" BOOLEAN NOT NULL DEFAULT true,
    "alertNewOffer" BOOLEAN NOT NULL DEFAULT true,
    "alertPincodeAvailable" BOOLEAN NOT NULL DEFAULT true,
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Owner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "website" TEXT,
    "color" TEXT NOT NULL DEFAULT '#10B981',
    "category" "StoreCategory" NOT NULL DEFAULT 'ecommerce',
    "requiresPincode" BOOLEAN NOT NULL DEFAULT false,
    "status" "StoreHealth" NOT NULL DEFAULT 'healthy',
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "nickname" TEXT,
    "image" TEXT,
    "currentPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "oldPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "rating" DOUBLE PRECISION,
    "availability" TEXT,
    "targetPrice" DECIMAL(12,2),
    "status" "ProductStatus" NOT NULL DEFAULT 'tracking',
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastChecked" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPincode" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "lastAvailable" BOOLEAN,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPincode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "pincode" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "type" "AlertType" NOT NULL,
    "oldPrice" DECIMAL(12,2),
    "newPrice" DECIMAL(12,2),
    "message" TEXT,
    "pincode" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'info',
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Owner_email_key" ON "Owner"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Store_slug_key" ON "Store"("slug");

-- CreateIndex
CREATE INDEX "Product_storeId_idx" ON "Product"("storeId");

-- CreateIndex
CREATE INDEX "Product_status_idx" ON "Product"("status");

-- CreateIndex
CREATE INDEX "ProductPincode_productId_idx" ON "ProductPincode"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPincode_productId_pincode_key" ON "ProductPincode"("productId", "pincode");

-- CreateIndex
CREATE INDEX "PriceHistory_productId_checkedAt_idx" ON "PriceHistory"("productId", "checkedAt");

-- CreateIndex
CREATE INDEX "Notification_isRead_createdAt_idx" ON "Notification"("isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_productId_idx" ON "Notification"("productId");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_level_idx" ON "ActivityLog"("level");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPincode" ADD CONSTRAINT "ProductPincode_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
