import type { POSState } from './types';

type NormalizedCatalogSyncState = Pick<POSState, 'products' | 'customers' | 'suppliers' | 'kitItems' | 'settings'>;

/**
 * Fingerprint only data that requires the normalized catalog reconciliation.
 * Operational stock/balance changes are committed through their dedicated RPCs,
 * and tracked-unit create/delete paths have their own atomic/queue handlers.
 * Keeping them out prevents every sale or credit settlement from re-uploading
 * every product, supplier, customer, and kit definition.
 */
export function buildNormalizedCatalogSyncFingerprint(state: NormalizedCatalogSyncState): string {
  return JSON.stringify({
    branchId: state.settings.branchId || '',
    products: state.products.map(product => [
      product.id,
      product.name,
      product.sku,
      product.barcode,
      product.cost,
      product.price,
      product.reorderLevel,
      product.trackImei,
      product.trackSerial,
      product.trackExpiry,
      product.warrantyMonths,
      product.isKit,
      product.isService,
      product.active,
      product.supplierId,
      product.attributes,
    ]),
    customers: state.customers.map(customer => [
      customer.id,
      customer.name,
      customer.phone,
      customer.email,
      customer.nic,
      customer.address,
      customer.creditLimit,
    ]),
    suppliers: state.suppliers.map(supplier => [
      supplier.id,
      supplier.name,
      supplier.contactPerson,
      supplier.phone,
      supplier.email,
      supplier.address,
    ]),
    kits: (state.kitItems || []).map(item => [
      item.id,
      item.kitProductId,
      item.componentProductId,
      item.qty,
    ]),
  });
}
