export type InventoryTransactionType =
  | 'PURCHASE_RECEIVE'
  | 'SALE'
  | 'SALE_REVERSAL'
  | 'REFUND'
  | 'EXCHANGE_RETURN'
  | 'STOCK_ADJUSTMENT'
  | 'PURCHASE_REVERSAL';

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
    ['PURCHASE_RECEIVE', 'SALE', 'SALE_REVERSAL', 'REFUND', 'EXCHANGE_RETURN', 'STOCK_ADJUSTMENT', 'PURCHASE_REVERSAL'].includes(tx.type) &&
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
