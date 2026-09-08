import type { POSState, Product, Customer, Supplier } from './types';
import type { SupplierPayment } from './supplierPayments';
import { addSupplierPayment, deleteSupplierPayment } from './supplierPaymentsState';

/**
 * Pure, immutable state transitions for domain slices.
 * Keeping these outside store.tsx makes the main provider smaller and easier
 * to split further without changing business semantics.
 */
export function upsertProduct(state: POSState, product: Product): POSState {
  const exists = state.products.some(p => p.id === product.id);
  return { ...state, products: exists ? state.products.map(p => p.id === product.id ? product : p) : [product, ...state.products] };
}

export function removeProduct(state: POSState, productId: string): POSState {
  return { ...state, products: state.products.filter(p => p.id !== productId) };
}

export function upsertCustomer(state: POSState, customer: Customer): POSState {
  const exists = state.customers.some(c => c.id === customer.id);
  return { ...state, customers: exists ? state.customers.map(c => c.id === customer.id ? customer : c) : [customer, ...state.customers] };
}

export function removeCustomer(state: POSState, customerId: string): POSState {
  return { ...state, customers: state.customers.filter(c => c.id !== customerId) };
}

export function upsertSupplier(state: POSState, supplier: Supplier): POSState {
  const exists = state.suppliers.some(s => s.id === supplier.id);
  return { ...state, suppliers: exists ? state.suppliers.map(s => s.id === supplier.id ? supplier : s) : [supplier, ...state.suppliers] };
}

export function removeSupplier(state: POSState, supplierId: string): POSState {
  return { ...state, suppliers: state.suppliers.filter(s => s.id !== supplierId) };
}

export function addPaymentToState(state: POSState, payment: SupplierPayment): POSState {
  return { ...state, supplierPayments: addSupplierPayment(state.supplierPayments || [], payment) };
}

export function removePaymentFromState(state: POSState, paymentId: string): POSState {
  return { ...state, supplierPayments: deleteSupplierPayment(state.supplierPayments || [], paymentId) };
}
