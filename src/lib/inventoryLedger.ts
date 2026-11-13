import type { POSState } from './types';

export type InventoryTransactionType =
  | 'PURCHASE_RECEIVE'
  | 'SALE'
  | 'SALE_REVERSAL'
  | 'REFUND'
  | 'EXCHANGE_RETURN'
  | 'STOCK_ADJUSTMENT'
  | 'PURCHASE_REVERSAL'
  | 'TRADE_IN'
  | 'REPAIR_PARTS' | 'UNIT_DELETE';

/**
 * Immutable inventory movement record. Quantity is signed from the inventory
 * perspective: positive adds stock, negative removes stock.
 */
export interface InventoryTransaction {
  id: string;
  type: InventoryTransactionType;
  productId: string;
  quantity: number;
  occurredAt: string;
  by?: string;
  machineId?: string;
  referenceId?: string;
  referenceNo?: string;
  unitIds?: string[];
  reason?: string;
}

/**
 * Defensive validation for imported/synced ledger records. Keeping this pure
 * makes it safe to reuse before accepting records from offline/cloud sources.
 */
export function isValidInventoryTransaction(value: unknown): value is InventoryTransaction {
  if (!value || typeof value !== 'object') return false;
  const tx = value as Partial<InventoryTransaction>;
  return (
    typeof tx.id === 'string' && tx.id.length > 0 &&
    typeof tx.type === 'string' &&
    ['PURCHASE_RECEIVE', 'SALE', 'SALE_REVERSAL', 'REFUND', 'EXCHANGE_RETURN', 'STOCK_ADJUSTMENT', 'PURCHASE_REVERSAL', 'TRADE_IN', 'REPAIR_PARTS', 'UNIT_DELETE'].includes(tx.type) &&
    typeof tx.productId === 'string' && tx.productId.length > 0 &&
    typeof tx.quantity === 'number' && Number.isFinite(tx.quantity) && tx.quantity !== 0 &&
    typeof tx.occurredAt === 'string' && !Number.isNaN(Date.parse(tx.occurredAt)) &&
    (tx.by === undefined || typeof tx.by === 'string') &&
    (tx.machineId === undefined || typeof tx.machineId === 'string') &&
    (tx.referenceId === undefined || typeof tx.referenceId === 'string') &&
    (tx.referenceNo === undefined || typeof tx.referenceNo === 'string') &&
    (tx.reason === undefined || typeof tx.reason === 'string') &&
    (tx.unitIds === undefined || (Array.isArray(tx.unitIds) && tx.unitIds.every(id => typeof id === 'string')))
  );
}

/**
 * Build a validated inventory movement record. Positive quantities add stock;
 * negative quantities remove stock. This keeps transaction construction
 * consistent across sales, returns, exchanges and stock adjustments.
 */
export function buildInventoryTransaction(input: Omit<InventoryTransaction, 'occurredAt'> & { occurredAt?: string }): InventoryTransaction | null {
  const transaction: InventoryTransaction = {
    ...input,
    occurredAt: input.occurredAt || new Date().toISOString(),
  };
  return isValidInventoryTransaction(transaction) ? transaction : null;
}

/**
 * Append-only helper. Existing records are never mutated or replaced.
 * Duplicate transaction ids are rejected to provide basic idempotency.
 */
export function appendInventoryTransaction(
  ledger: readonly InventoryTransaction[],
  transaction: InventoryTransaction,
): InventoryTransaction[] {
  if (!isValidInventoryTransaction(transaction)) return [...ledger];
  if (ledger.some(tx => tx.id === transaction.id)) return [...ledger];
  return [...ledger, transaction];
}


export type InventoryLedgerOperation = 'SALE' | 'SALE_REVERSAL' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT' | 'PURCHASE_REVERSAL' | 'REPAIR_PARTS' | 'UNIT_DELETE';

export function applyInventoryLedger(
  prev: POSState,
  next: POSState,
  operation: InventoryLedgerOperation,
  by?: string,
): POSState {
  const ledger = next.inventoryTransactions || prev.inventoryTransactions || [];
  const transactions: InventoryTransaction[] = [];
  const prevProducts = new Map(prev.products.map(p => [p.id, p]));
  const nextProducts = new Map(next.products.map(p => [p.id, p]));
  const now = new Date().toISOString();
  const add = (tx: Omit<InventoryTransaction, 'id' | 'occurredAt'> & { id: string }) => transactions.push({ ...tx, occurredAt: now, by });

  if (operation === 'SALE') {
    const ids = new Set(prev.sales.map(x => x.id));
    for (const sale of next.sales) if (!ids.has(sale.id)) {
      const componentQty = new Map<string, number>();
      for (const item of sale.items) if (item.qty > 0) {
        const product = nextProducts.get(item.productId);
        const kitLines = product?.isKit
          ? (next.kitItems || []).filter(k => k.kitProductId === item.productId && Number.isFinite(k.qty) && k.qty > 0)
          : [];
        if (kitLines.length) {
          for (const line of kitLines) componentQty.set(line.componentProductId, (componentQty.get(line.componentProductId) || 0) + line.qty * item.qty);
        } else {
          add({ id: 'inv:sale:' + sale.id + ':' + item.productId, type: 'SALE', productId: item.productId, quantity: -item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds });
        }
      }
      for (const [productId, quantity] of componentQty) {
        add({ id: 'inv:kit-sale:' + sale.id + ':' + productId, type: 'SALE', productId, quantity: -quantity, referenceId: sale.id, referenceNo: sale.billNo, reason: 'Kit BOM component consumed' });
      }
    }
    for (const sale of next.sales) if (!ids.has(sale.id) && sale.tradeIn?.addToInventory && sale.tradeIn.productId && sale.tradeIn.value > 0) {
      add({ id: 'inv:trade-in:' + sale.id, type: 'TRADE_IN', productId: sale.tradeIn.productId, quantity: 1, referenceId: sale.id, referenceNo: sale.billNo, unitIds: undefined, reason: `Trade-in value Rs. ${sale.tradeIn.value}` });
    }
  }

  if (operation === 'SALE_REVERSAL') {
    for (const sale of next.sales) {
      const old = prev.sales.find(x => x.id === sale.id);
      if (!old || old.status === 'reversed' || sale.status !== 'reversed') continue;
      for (const item of sale.items) if (item.qty > 0) {
        add({ id: 'inv:sale-reversal:' + sale.id + ':' + item.productId, type: 'SALE_REVERSAL', productId: item.productId, quantity: item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds, reason: 'Admin-approved bill reversal' });
      }
      if (sale.tradeIn?.addToInventory && sale.tradeIn.productId && sale.tradeIn.unitId) add({ id: 'inv:trade-in-reversal:' + sale.id, type: 'TRADE_IN', productId: sale.tradeIn.productId, quantity: -1, referenceId: sale.id, referenceNo: sale.billNo, reason: 'Trade-in removed by bill reversal' });
    }
  }

  if (operation === 'REFUND') {
    for (const sale of next.sales) {
      const old = prev.sales.find(x => x.id === sale.id);
      if (!old || old.status === 'refunded' || sale.status !== 'refunded') continue;
      for (const item of sale.items) if (item.qty > 0) {
        add({ id: 'inv:refund:' + sale.id + ':' + item.productId, type: 'REFUND', productId: item.productId, quantity: item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds });
      }
      if (sale.tradeIn?.addToInventory && sale.tradeIn.productId && sale.tradeIn.unitId) add({ id: 'inv:trade-in-refund:' + sale.id, type: 'TRADE_IN', productId: sale.tradeIn.productId, quantity: -1, referenceId: sale.id, referenceNo: sale.billNo, reason: 'Trade-in removed by full refund' });
    }
  }

  if (operation === 'PURCHASE_RECEIVE') {
    for (const purchase of next.purchases) {
      const old = prev.purchases.find(x => x.id === purchase.id);
      if (!old || old.status === 'received' || purchase.status !== 'received') continue;
      for (const item of purchase.items) if (item.qty > 0) {
        add({ id: 'inv:purchase:' + purchase.id + ':' + item.productId, type: 'PURCHASE_RECEIVE', productId: item.productId, quantity: item.qty, referenceId: purchase.id, referenceNo: purchase.poNo });
      }
    }
  }

  if (operation === 'EXCHANGE') {
    const ids = new Set(prev.exchanges.map(x => x.id));
    for (const ex of next.exchanges) if (!ids.has(ex.id)) {
      const returned = new Map<string, number>();
      for (const item of ex.items) if (item.qty > 0) {
        returned.set(item.productId, (returned.get(item.productId) || 0) + item.qty);
        add({ id: 'inv:exchange:' + ex.id + ':' + item.productId + ':return', type: 'EXCHANGE_RETURN', productId: item.productId, quantity: item.qty, referenceId: ex.id, referenceNo: ex.exNo, reason: ex.reason });
      }
      for (const [productId, qtyReturned] of returned) {
        const netDelta = (nextProducts.get(productId)?.stock || 0) - (prevProducts.get(productId)?.stock || 0);
        const outgoing = qtyReturned - netDelta;
        if (outgoing > 0) add({ id: 'inv:exchange:' + ex.id + ':' + productId + ':out', type: 'SALE', productId, quantity: -outgoing, referenceId: ex.id, referenceNo: ex.exNo, reason: ex.reason });
      }
    }
  }

  if (operation === 'PURCHASE_REVERSAL') {
    const ids = new Set((prev.purchaseReturns || []).map(x => x.id));
    for (const ret of next.purchaseReturns || []) if (!ids.has(ret.id)) for (const item of ret.items) if (item.qty > 0) {
      add({ id: 'inv:purchase-return:' + ret.id + ':' + item.itemIdx, type: 'PURCHASE_REVERSAL', productId: item.productId, quantity: -item.qty, referenceId: ret.id, referenceNo: ret.dnNo, unitIds: item.unitIds, reason: ret.reason });
    }
  }

  if (operation === 'REPAIR_PARTS') {
    for (const repair of next.repairs || []) {
      const old = (prev.repairs || []).find(x => x.id === repair.id);
      if (!old || old.partsDeductedAt || !repair.partsDeductedAt || repair.status !== 'delivered') continue;
      for (const part of repair.parts || []) if (part.productId && part.qty > 0) {
        add({ id: 'inv:repair-parts:' + repair.id + ':' + part.productId, type: 'REPAIR_PARTS', productId: part.productId, quantity: -part.qty, referenceId: repair.id, referenceNo: repair.jobNo, reason: 'Repair parts consumed on delivery' });
      }
    }
  }  if (operation === 'UNIT_DELETE') {
    const currentIds = new Set((next.units || []).map(u => u.id));
    for (const unit of prev.units || []) {
      if (currentIds.has(unit.id) || unit.status !== 'in_stock') continue;
      add({
        id: 'inv:unit-delete:' + unit.id,
        type: 'UNIT_DELETE',
        productId: unit.productId,
        quantity: -1,
        referenceId: unit.id,
        unitIds: [unit.id],
        reason: 'Inventory unit deleted',
      });
    }
  }



  if (operation === 'STOCK_ADJUSTMENT') {
    for (const [productId, product] of nextProducts) {
      const before = prevProducts.get(productId)?.stock;
      if (before === undefined) continue;
      const delta = product.stock - before;
      if (delta) add({ id: 'inv:adjust:' + productId + ':' + product.stock + ':' + delta, type: 'STOCK_ADJUSTMENT', productId, quantity: delta, reason: 'Stock adjustment' });
    }
  }

  let updated = ledger;
  for (const tx of transactions) updated = appendInventoryTransaction(updated, tx);
  return updated === next.inventoryTransactions ? next : { ...next, inventoryTransactions: updated };
}


