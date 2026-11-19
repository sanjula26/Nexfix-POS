import type { POSState } from './types';
import { isValidInventoryTransaction } from './inventoryLedger.ts';
import { hasValidCustomerCreditPayment } from './creditPaymentBackupValidation.ts';

export interface BackupEnvelope {
  _meta: { app: 'Nexfix POS'; version: 2; exportedAt: string; kind: 'manual' | 'auto' };
  state: POSState;
}

function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasPlainObjectShape(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasArray(value: unknown): value is unknown[] { return Array.isArray(value); }

function hasUniqueStringIds(value: unknown[]): boolean {
  const ids = new Set<string>();
  for (const item of value) {
    if (!hasPlainObjectShape(item) || typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

function hasValidCounters(value: Record<string, unknown>): boolean {
  const keys = ['bill', 'po', 'ex', 'job', 'quote', 'claim'];
  if (value.grn !== undefined) keys.push('grn');
  if (value.dn !== undefined) keys.push('dn');
  return keys.every((key) => {
    const n = value[key];
    return typeof n === 'number' && Number.isInteger(n) && n >= 0;
  });
}

function hasStringFields(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string');
}

function hasNumberFields(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function hasValidRecordCollection(
  value: unknown,
  validate: (record: Record<string, unknown>) => boolean,
): value is unknown[] {
  return hasArray(value) && hasUniqueStringIds(value)
    && value.every((item) => hasPlainObjectShape(item) && validate(item));
}

function hasValidSaleItem(value: unknown): boolean {
  return hasPlainObjectShape(value)
    && hasStringFields(value, ['productId', 'name'])
    && hasNumberFields(value, ['qty', 'price', 'cost'])
    && Number(value.qty) > 0;
}

function hasValidPurchaseItem(value: unknown): boolean {
  return hasPlainObjectShape(value)
    && hasStringFields(value, ['productId', 'name'])
    && hasNumberFields(value, ['qty', 'cost'])
    && Number(value.qty) > 0;
}

function hasValidSettings(value: unknown): boolean {
  if (!hasPlainObjectShape(value)) return false;
  return hasStringFields(value, [
    'shopName', 'tagline', 'address', 'phone', 'email', 'receiptFooter', 'adminPinHash',
  ]) && hasNumberFields(value, [
    'taxDefault', 'lowStockDefault', 'exchangeDays', 'openingFloat',
  ]) && typeof value.whatsappReceipts === 'boolean'
    && (value.categories === undefined || hasArray(value.categories) && value.categories.every((item) => typeof item === 'string'))
    && (value.brands === undefined || hasArray(value.brands) && value.brands.every((item) => typeof item === 'string'))
    && (value.promotions === undefined || hasArray(value.promotions));
}

function hasValidPermissions(value: unknown): boolean {
  if (!hasPlainObjectShape(value)) return false;
  return ['admin', 'cashier'].every((role) => hasPlainObjectShape(value[role])
    && Object.values(value[role] as Record<string, unknown>).every((flag) => typeof flag === 'boolean'))
    && ['manager', 'technician'].every((role) => value[role] === undefined
      || hasPlainObjectShape(value[role])
        && Object.values(value[role] as Record<string, unknown>).every((flag) => typeof flag === 'boolean'));
}

/** Strictly validate persisted POS records before hydration or restore. */
export function hasValidPOSStateShape(value: unknown): value is POSState {
  if (!hasPlainObjectShape(value)) return false;
  const state = value as Record<string, unknown>;
  const requiredArrays = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'expenses', 'exchanges', 'users', 'audit', 'held', 'sessions', 'units', 'repairs'];
  if (!requiredArrays.every((key) => hasArray(state[key]))) return false;
  if (!hasValidSettings(state.settings) || !hasValidPermissions(state.permissions)) return false;
  if (!hasPlainObjectShape(state.counters) || !hasValidCounters(state.counters)) return false;
  if ('kitItems' in state && !hasArray(state.kitItems)) return false;
  if ('quotations' in state && !hasArray(state.quotations)) return false;
  if ('warrantyClaims' in state && !hasArray(state.warrantyClaims)) return false;
  if ('purchaseReturns' in state && !hasArray(state.purchaseReturns)) return false;
  if ('supplierPayments' in state && !hasArray(state.supplierPayments)) return false;
  if ('customerCreditPayments' in state && (!hasArray(state.customerCreditPayments) || !state.customerCreditPayments.every(hasValidCustomerCreditPayment))) return false;
  if ('inventoryTransactions' in state && !hasArray(state.inventoryTransactions)) return false;
  if ('grns' in state && !hasArray(state.grns)) return false;
  if ('reverseRequests' in state && !hasArray(state.reverseRequests)) return false;
  const idCollections = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'expenses', 'exchanges', 'users', 'audit', 'held', 'sessions', 'units', 'repairs', 'kitItems', 'quotations', 'warrantyClaims', 'purchaseReturns', 'supplierPayments', 'customerCreditPayments', 'grns', 'reverseRequests'];
  for (const key of idCollections) {
    const collection = state[key];
    if (collection !== undefined && (!hasArray(collection) || !hasUniqueStringIds(collection))) return false;
  }
  if (state.inventoryTransactions !== undefined) {
    const ledger = state.inventoryTransactions;
    if (!hasArray(ledger) || !ledger.every(isValidInventoryTransaction) || !hasUniqueStringIds(ledger)) return false;
  }
  const users = state.users as unknown[];
  const recordChecks: Array<[string, (record: Record<string, unknown>) => boolean]> = [
    ['products', (r) => hasStringFields(r, ['name', 'sku', 'barcode', 'category', 'brand'])
      && hasNumberFields(r, ['cost', 'price', 'stock', 'reorderLevel'])
      && typeof r.trackImei === 'boolean' && typeof r.active === 'boolean' && isValidIsoDate(r.createdAt)],
    ['customers', (r) => hasStringFields(r, ['name', 'phone']) && hasNumberFields(r, ['creditBalance', 'loyaltyPoints']) && isValidIsoDate(r.createdAt)],
    ['suppliers', (r) => hasStringFields(r, ['name', 'phone']) && isValidIsoDate(r.createdAt)],
    ['sales', (r) => hasStringFields(r, ['billNo', 'cashierId', 'cashierName', 'customerName'])
      && isValidIsoDate(r.date) && hasArray(r.items) && r.items.every(hasValidSaleItem)
      && hasNumberFields(r, ['subtotal', 'discount', 'tax', 'total', 'amountPaid', 'change', 'profit'])
      && ['cash', 'card', 'bank', 'mobile', 'credit'].includes(String(r.payment))
      && ['completed', 'refunded', 'reversed', 'exchanged'].includes(String(r.status))],
    ['purchases', (r) => hasStringFields(r, ['poNo', 'supplierId', 'supplierName'])
      && isValidIsoDate(r.date) && hasArray(r.items) && r.items.every(hasValidPurchaseItem)
      && hasNumberFields(r, ['total']) && ['pending', 'received'].includes(String(r.status))],
    ['expenses', (r) => hasStringFields(r, ['category', 'note', 'by']) && isValidIsoDate(r.date) && hasNumberFields(r, ['amount'])],
    ['exchanges', (r) => hasStringFields(r, ['exNo', 'billNo', 'customerName', 'reason', 'by'])
      && isValidIsoDate(r.date) && hasArray(r.items) && r.items.every((item) => hasPlainObjectShape(item)
        && hasStringFields(item, ['productId', 'name']) && hasNumberFields(item, ['qty', 'amount']))
      && hasNumberFields(r, ['refund', 'additional'])],
    ['audit', (r) => hasStringFields(r, ['user', 'action', 'entity', 'details']) && isValidIsoDate(r.time)],
    ['held', (r) => hasStringFields(r, ['label']) && isValidIsoDate(r.heldAt) && hasArray(r.lines)
      && r.lines.every((line) => hasPlainObjectShape(line) && hasStringFields(line, ['productId'])
        && hasNumberFields(line, ['qty']) && Number(line.qty) > 0)],
    ['sessions', (r) => hasStringFields(r, ['cashierId', 'cashierName', 'date'])
      && hasNumberFields(r, ['opening']) && typeof r.closed === 'boolean'],
    ['units', (r) => hasStringFields(r, ['productId']) && isValidIsoDate(r.createdAt)
      && ['in_stock', 'sold', 'returned', 'reserved', 'defective', 'in_repair'].includes(String(r.status))],
    ['repairs', (r) => hasStringFields(r, ['jobNo', 'customerName', 'deviceType', 'deviceBrand', 'deviceModel', 'fault', 'by'])
      && isValidIsoDate(r.receivedAt) && hasNumberFields(r, ['laborCost']) && hasArray(r.parts)
      && ['received', 'diagnosed', 'waiting_parts', 'in_repair', 'ready', 'delivered', 'cancelled'].includes(String(r.status))],
    ['kitItems', (r) => hasStringFields(r, ['kitProductId', 'componentProductId']) && hasNumberFields(r, ['qty']) && Number(r.qty) > 0],
    ['quotations', (r) => hasStringFields(r, ['quoteNo', 'customerName', 'by'])
      && isValidIsoDate(r.createdAt) && hasArray(r.items) && hasNumberFields(r, ['subtotal', 'discount', 'tax', 'total'])
      && ['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted'].includes(String(r.status))],
    ['warrantyClaims', (r) => hasStringFields(r, ['claimNo', 'productName', 'issueDescription', 'by'])
      && isValidIsoDate(r.createdAt) && ['open', 'approved', 'rejected', 'replaced', 'repaired', 'closed'].includes(String(r.status))],
    ['purchaseReturns', (r) => hasStringFields(r, ['dnNo', 'purchaseId', 'poNo', 'supplierId', 'supplierName', 'reason', 'by'])
      && isValidIsoDate(r.date) && hasArray(r.items) && hasNumberFields(r, ['total'])],
    ['supplierPayments', (r) => hasStringFields(r, ['supplierId', 'method', 'by'])
      && isValidIsoDate(r.date) && hasNumberFields(r, ['amount']) && Number(r.amount) > 0
      && ['cash', 'card', 'bank', 'mobile'].includes(String(r.method))],
    ['grns', (r) => hasStringFields(r, ['grnNumber', 'supplierId', 'supplierName', 'supplierInvoiceNo', 'createdBy'])
      && isValidIsoDate(r.date) && hasArray(r.items) && hasNumberFields(r, ['totalCost'])
      && ['draft', 'processed'].includes(String(r.status))],
    ['reverseRequests', (r) => hasStringFields(r, ['saleId', 'billNo', 'reason', 'requestedBy'])
      && isValidIsoDate(r.requestedAt) && ['pending', 'approved', 'rejected'].includes(String(r.status))],
  ];
  for (const [key, validate] of recordChecks) {
    const collection = state[key];
    if (collection !== undefined && !hasValidRecordCollection(collection, validate)) return false;
  }
  if (!users.every((u) => {
    if (!hasPlainObjectShape(u)) return false;
    return typeof u.id === 'string' && u.id.length > 0
      && typeof u.name === 'string'
      && typeof u.email === 'string'
      && typeof u.password === 'string'
      && (u.role === 'admin' || u.role === 'cashier' || u.role === 'manager' || u.role === 'technician')
      && typeof u.active === 'boolean'
      && typeof u.createdAt === 'string'
      && isValidIsoDate(u.createdAt);
  })) return false;
  return true;
}

function normalizeRestoredState(state: POSState): POSState {
  return {
    ...state,
    kitItems: state.kitItems ?? [],
    quotations: state.quotations ?? [],
    warrantyClaims: state.warrantyClaims ?? [],
    purchaseReturns: state.purchaseReturns ?? [],
    supplierPayments: state.supplierPayments ?? [],
    customerCreditPayments: state.customerCreditPayments ?? [],
    inventoryTransactions: state.inventoryTransactions ?? [],
    grns: state.grns ?? [],
    reverseRequests: state.reverseRequests ?? [],
  };
}

export function validateBackup(input: unknown): input is BackupEnvelope {
  if (!hasPlainObjectShape(input)) return false;
  const value = input as Partial<BackupEnvelope>;
  const meta = value._meta;
  if (!hasPlainObjectShape(meta)) return false;
  return meta.app === 'Nexfix POS' && meta.version === 2 &&
    isValidIsoDate(meta.exportedAt) &&
    (meta.kind === 'manual' || meta.kind === 'auto') &&
    hasValidStateShape(value.state);
}

export function parseBackup(raw: string): BackupEnvelope | null {
  try { const parsed: unknown = JSON.parse(raw); return validateBackup(parsed) ? parsed : null; } catch { return null; }
}

export function validateBackupForRestore(input: unknown): BackupEnvelope {
  if (!validateBackup(input)) throw new Error('Invalid or unsupported Nexfix POS backup. Restore was not performed.');
  return { ...input, state: normalizeRestoredState(input.state) };
}

