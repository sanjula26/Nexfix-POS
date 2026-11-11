import type { InventoryUnit, Product, Purchase } from './types';
import type { PurchaseReceivePlan } from './purchaseReconciliation';

export type PurchaseReceiveUnitDraft = Omit<InventoryUnit, 'id' | 'createdAt'>;

export interface PurchaseReceiveChanges {
  products: Product[];
  unitDrafts: PurchaseReceiveUnitDraft[];
}

/**
 * Build the local product and tracked-unit changes for a validated GRN plan.
 * IDs, timestamps, cloud commit and the final state commit remain caller-owned.
 */
export function buildPurchaseReceiveChanges(input: {
  purchase: Purchase;
  products: readonly Product[];
  plan: PurchaseReceivePlan;
  branchId: string;
}): PurchaseReceiveChanges {
  const unitDrafts: PurchaseReceiveUnitDraft[] = [];
  const products = input.products.map(product => {
    const delta = input.plan.productStockDelta.get(product.id);
    if (delta === undefined) return product;
    const cost = input.plan.productCost.get(product.id);
    const trackedQty = input.plan.trackedUnitCount.get(product.id) || 0;
    const purchaseItem = input.purchase.items.find(item => item.productId === product.id);

    if (trackedQty > 0 && (product.trackImei || product.trackSerial)) {
      for (const identifier of purchaseItem?.unitIdentifiers || []) {
        unitDrafts.push({
          productId: product.id,
          branchId: input.branchId,
          imei: product.trackImei ? identifier.imei?.trim() : undefined,
          serial: product.trackSerial ? identifier.serial?.trim() : undefined,
          status: 'in_stock',
          purchaseId: input.purchase.id,
          cost,
          expiryDate: purchaseItem?.expiryDate,
          note: 'From ' + input.purchase.poNo,
        });
      }
    }

    const sellingPrice = purchaseItem?.updateSellingPrice ? purchaseItem.sellingPrice : undefined;
    return {
      ...product,
      stock: product.stock + delta,
      ...(cost !== undefined ? { cost } : {}),
      ...(sellingPrice !== undefined ? { price: Math.round(sellingPrice * 100) / 100 } : {}),
    };
  });

  return { products, unitDrafts };
}
