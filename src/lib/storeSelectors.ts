import type { POSState, Role } from './types';
import { getSupplierOutstanding } from './supplierPayments';

/** Small, pure selectors for reading POS state without duplicating filtering logic in pages. */
export function selectActiveUser(state: POSState, userId: string) {
  return state.users.find(user => user.id === userId && user.active) || null;
}

export function selectViewingRole(state: POSState, userId: string): Role {
  return selectActiveUser(state, userId)?.role || 'admin';
}

export function selectSupplierOutstanding(state: POSState, supplierId: string): number {
  return getSupplierOutstanding(supplierId, state.purchases, state.supplierPayments || []);
}

export function selectPendingPurchases(state: POSState) {
  return state.purchases.filter(purchase => purchase.status === 'pending');
}

export function selectReceivedPurchases(state: POSState) {
  return state.purchases.filter(purchase => purchase.status === 'received');
}
