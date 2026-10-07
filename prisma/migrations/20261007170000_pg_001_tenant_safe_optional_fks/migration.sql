-- DropForeignKey
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_productId_fkey";

-- DropForeignKey
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_variantId_fkey";

-- DropForeignKey
ALTER TABLE "OrderTransaction" DROP CONSTRAINT "OrderTransaction_parentTransactionId_fkey";

-- DropForeignKey
ALTER TABLE "OrderTransaction" DROP CONSTRAINT "OrderTransaction_refundId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineCostSnapshot_orderLineId_key" ON "OrderLineCostSnapshot"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_shopId_id_key" ON "ProductVariant"("shopId", "id");

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_shopId_productId_fkey" FOREIGN KEY ("shopId", "productId") REFERENCES "Product"("shopId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_shopId_variantId_fkey" FOREIGN KEY ("shopId", "variantId") REFERENCES "ProductVariant"("shopId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTransaction" ADD CONSTRAINT "OrderTransaction_shopId_refundId_fkey" FOREIGN KEY ("shopId", "refundId") REFERENCES "Refund"("shopId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTransaction" ADD CONSTRAINT "OrderTransaction_shopId_parentTransactionId_fkey" FOREIGN KEY ("shopId", "parentTransactionId") REFERENCES "OrderTransaction"("shopId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

