-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('SHOPIFY_UNIT_COST', 'MANUAL', 'ESTIMATED', 'MISSING');

-- CreateTable
CREATE TABLE "Shop" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopifyGid" TEXT NOT NULL,
    "myshopifyDomain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryDomainHost" TEXT,
    "currencyCode" TEXT NOT NULL,
    "ianaTimezone" TEXT NOT NULL,
    "taxesIncluded" BOOLEAN NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMPTZ(3) NOT NULL,
    "uninstalledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "shopifyCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "shopifyUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "price" DECIMAL(20,6) NOT NULL,
    "priceCurrencyCode" TEXT NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "unitCost" DECIMAL(20,6),
    "unitCostCurrencyCode" TEXT,
    "shopifyUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "shopifyCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "shopifyUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "test" BOOLEAN NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "presentmentCurrencyCode" TEXT NOT NULL,
    "displayFinancialStatus" TEXT,
    "displayFulfillmentStatus" TEXT NOT NULL,
    "taxesIncluded" BOOLEAN NOT NULL,
    "dutiesIncluded" BOOLEAN NOT NULL,
    "customerShopifyGid" TEXT,
    "totalWeightGrams" BIGINT,
    "deletedAt" TIMESTAMPTZ(3),
    "totalTipReceived" DECIMAL(20,6) NOT NULL,
    "originalTotalDuties" DECIMAL(20,6),
    "currentTotalDuties" DECIMAL(20,6),
    "originalTotalAdditionalFees" DECIMAL(20,6),
    "currentTotalAdditionalFees" DECIMAL(20,6),
    "subtotalPrice" DECIMAL(20,6) NOT NULL,
    "totalPrice" DECIMAL(20,6) NOT NULL,
    "currentTotalPrice" DECIMAL(20,6) NOT NULL,
    "totalDiscounts" DECIMAL(20,6) NOT NULL,
    "currentTotalDiscounts" DECIMAL(20,6) NOT NULL,
    "totalTax" DECIMAL(20,6) NOT NULL,
    "currentTotalTax" DECIMAL(20,6) NOT NULL,
    "currentShippingPrice" DECIMAL(20,6) NOT NULL,
    "totalReceived" DECIMAL(20,6) NOT NULL,
    "netPayment" DECIMAL(20,6) NOT NULL,
    "totalRefunded" DECIMAL(20,6) NOT NULL,
    "totalRefundedShipping" DECIMAL(20,6) NOT NULL,
    "totalOutstanding" DECIMAL(20,6) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "productId" UUID,
    "variantId" UUID,
    "productShopifyGid" TEXT,
    "variantShopifyGid" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "currentQuantity" INTEGER NOT NULL,
    "refundableQuantity" INTEGER NOT NULL,
    "originalUnitPrice" DECIMAL(20,6) NOT NULL,
    "originalTotal" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "isGiftCard" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineDiscountAllocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLineDiscountAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineTax" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT,
    "rate" DECIMAL(30,15),
    "amount" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLineTax_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shopifyGid" TEXT,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "code" TEXT,
    "source" TEXT,
    "carrierIdentifier" TEXT,
    "isRemoved" BOOLEAN NOT NULL,
    "originalPrice" DECIMAL(20,6) NOT NULL,
    "discountedPrice" DECIMAL(20,6) NOT NULL,
    "currentDiscountedPrice" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShippingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingLineTax" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "shippingLineId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT,
    "rate" DECIMAL(30,15),
    "amount" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingLineTax_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTransaction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "refundId" UUID,
    "parentTransactionId" UUID,
    "shopifyGid" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "gateway" TEXT,
    "formattedGateway" TEXT,
    "amount" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "settlementCurrency" TEXT,
    "settlementCurrencyRate" DECIMAL(30,15),
    "processedAt" TIMESTAMPTZ(3),
    "shopifyCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "test" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrderTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionFee" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "flatFee" DECIMAL(20,6),
    "flatFeeName" TEXT,
    "rate" DECIMAL(30,15),
    "rateName" TEXT,
    "taxAmount" DECIMAL(20,6),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "shopifyCreatedAt" TIMESTAMPTZ(3),
    "shopifyUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "totalRefunded" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "shopifyGid" TEXT,
    "position" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "subtotal" DECIMAL(20,6) NOT NULL,
    "taxAmount" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "restockType" TEXT NOT NULL,
    "restocked" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RefundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundShippingLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "subtotalAmount" DECIMAL(20,6) NOT NULL,
    "taxAmount" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundShippingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundOrderAdjustment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "taxAmount" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundOrderAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineCostSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "inventoryItemShopifyGid" TEXT,
    "unitCost" DECIMAL(20,6),
    "currencyCode" TEXT,
    "source" "CostSource" NOT NULL,
    "historicalApproximation" BOOLEAN NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrderLineCostSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopifyGid_key" ON "Shop"("shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_myshopifyDomain_key" ON "Shop"("myshopifyDomain");

-- CreateIndex
CREATE INDEX "Product_shopId_shopifyUpdatedAt_idx" ON "Product"("shopId", "shopifyUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopId_shopifyGid_key" ON "Product"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopId_id_key" ON "Product"("shopId", "id");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE INDEX "ProductVariant_inventoryItemId_idx" ON "ProductVariant"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_shopId_shopifyGid_key" ON "ProductVariant"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_shopId_shopifyGid_key" ON "InventoryItem"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_shopId_id_key" ON "InventoryItem"("shopId", "id");

-- CreateIndex
CREATE INDEX "Order_shopId_processedAt_idx" ON "Order"("shopId", "processedAt");

-- CreateIndex
CREATE INDEX "Order_shopId_shopifyUpdatedAt_idx" ON "Order"("shopId", "shopifyUpdatedAt");

-- CreateIndex
CREATE INDEX "Order_shopId_customerShopifyGid_idx" ON "Order"("shopId", "customerShopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_shopifyGid_key" ON "Order"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_id_key" ON "Order"("shopId", "id");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE INDEX "OrderLine_productId_idx" ON "OrderLine"("productId");

-- CreateIndex
CREATE INDEX "OrderLine_variantId_idx" ON "OrderLine"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_shopId_shopifyGid_key" ON "OrderLine"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_shopId_id_key" ON "OrderLine"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineDiscountAllocation_orderLineId_position_key" ON "OrderLineDiscountAllocation"("orderLineId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineTax_orderLineId_position_key" ON "OrderLineTax"("orderLineId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingLine_shopId_shopifyGid_key" ON "ShippingLine"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingLine_orderId_position_key" ON "ShippingLine"("orderId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingLine_shopId_id_key" ON "ShippingLine"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingLineTax_shippingLineId_position_key" ON "ShippingLineTax"("shippingLineId", "position");

-- CreateIndex
CREATE INDEX "OrderTransaction_orderId_idx" ON "OrderTransaction"("orderId");

-- CreateIndex
CREATE INDEX "OrderTransaction_refundId_idx" ON "OrderTransaction"("refundId");

-- CreateIndex
CREATE INDEX "OrderTransaction_parentTransactionId_idx" ON "OrderTransaction"("parentTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderTransaction_shopId_shopifyGid_key" ON "OrderTransaction"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "OrderTransaction_shopId_id_key" ON "OrderTransaction"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionFee_transactionId_position_key" ON "TransactionFee"("transactionId", "position");

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_shopId_shopifyGid_key" ON "Refund"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_shopId_id_key" ON "Refund"("shopId", "id");

-- CreateIndex
CREATE INDEX "RefundLine_orderLineId_idx" ON "RefundLine"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundLine_shopId_shopifyGid_key" ON "RefundLine"("shopId", "shopifyGid");

-- CreateIndex
CREATE UNIQUE INDEX "RefundLine_refundId_position_key" ON "RefundLine"("refundId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RefundShippingLine_refundId_position_key" ON "RefundShippingLine"("refundId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RefundOrderAdjustment_refundId_position_key" ON "RefundOrderAdjustment"("refundId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineCostSnapshot_shopId_orderLineId_key" ON "OrderLineCostSnapshot"("shopId", "orderLineId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_shopId_productId_fkey" FOREIGN KEY ("shopId", "productId") REFERENCES "Product"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_shopId_inventoryItemId_fkey" FOREIGN KEY ("shopId", "inventoryItemId") REFERENCES "InventoryItem"("shopId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_shopId_orderId_fkey" FOREIGN KEY ("shopId", "orderId") REFERENCES "Order"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineDiscountAllocation" ADD CONSTRAINT "OrderLineDiscountAllocation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineDiscountAllocation" ADD CONSTRAINT "OrderLineDiscountAllocation_shopId_orderLineId_fkey" FOREIGN KEY ("shopId", "orderLineId") REFERENCES "OrderLine"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineTax" ADD CONSTRAINT "OrderLineTax_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineTax" ADD CONSTRAINT "OrderLineTax_shopId_orderLineId_fkey" FOREIGN KEY ("shopId", "orderLineId") REFERENCES "OrderLine"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingLine" ADD CONSTRAINT "ShippingLine_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingLine" ADD CONSTRAINT "ShippingLine_shopId_orderId_fkey" FOREIGN KEY ("shopId", "orderId") REFERENCES "Order"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingLineTax" ADD CONSTRAINT "ShippingLineTax_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingLineTax" ADD CONSTRAINT "ShippingLineTax_shopId_shippingLineId_fkey" FOREIGN KEY ("shopId", "shippingLineId") REFERENCES "ShippingLine"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTransaction" ADD CONSTRAINT "OrderTransaction_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTransaction" ADD CONSTRAINT "OrderTransaction_shopId_orderId_fkey" FOREIGN KEY ("shopId", "orderId") REFERENCES "Order"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTransaction" ADD CONSTRAINT "OrderTransaction_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTransaction" ADD CONSTRAINT "OrderTransaction_parentTransactionId_fkey" FOREIGN KEY ("parentTransactionId") REFERENCES "OrderTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionFee" ADD CONSTRAINT "TransactionFee_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionFee" ADD CONSTRAINT "TransactionFee_shopId_transactionId_fkey" FOREIGN KEY ("shopId", "transactionId") REFERENCES "OrderTransaction"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_shopId_orderId_fkey" FOREIGN KEY ("shopId", "orderId") REFERENCES "Order"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_shopId_refundId_fkey" FOREIGN KEY ("shopId", "refundId") REFERENCES "Refund"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_shopId_orderLineId_fkey" FOREIGN KEY ("shopId", "orderLineId") REFERENCES "OrderLine"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundShippingLine" ADD CONSTRAINT "RefundShippingLine_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundShippingLine" ADD CONSTRAINT "RefundShippingLine_shopId_refundId_fkey" FOREIGN KEY ("shopId", "refundId") REFERENCES "Refund"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundOrderAdjustment" ADD CONSTRAINT "RefundOrderAdjustment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundOrderAdjustment" ADD CONSTRAINT "RefundOrderAdjustment_shopId_refundId_fkey" FOREIGN KEY ("shopId", "refundId") REFERENCES "Refund"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineCostSnapshot" ADD CONSTRAINT "OrderLineCostSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineCostSnapshot" ADD CONSTRAINT "OrderLineCostSnapshot_shopId_orderLineId_fkey" FOREIGN KEY ("shopId", "orderLineId") REFERENCES "OrderLine"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PG-001: CHECK constraints written by hand (Prisma does not model CHECK constraints).
-- An unknown cost is NULL, never 0, and an amount never exists without its currency.

-- AddCheckConstraint
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_unitCost_currency_check"
    CHECK (("unitCost" IS NULL) = ("unitCostCurrencyCode" IS NULL));

-- AddCheckConstraint
ALTER TABLE "OrderLineCostSnapshot" ADD CONSTRAINT "OrderLineCostSnapshot_missing_check"
    CHECK (("source" = 'MISSING') = ("unitCost" IS NULL));

-- AddCheckConstraint
ALTER TABLE "OrderLineCostSnapshot" ADD CONSTRAINT "OrderLineCostSnapshot_unitCost_currency_check"
    CHECK (("unitCost" IS NULL) = ("currencyCode" IS NULL));
