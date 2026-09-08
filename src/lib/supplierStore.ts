import type { POSState } from './types';
import type { SupplierPayment } from './supplierPayments';
import { addSupplierPayment, deleteSupplierPayment } from './supplierPaymentsState';

/** Supplier-specific state transitions kept outside the main POS store. */
export function withSupplierPayment(state: POSState, payment: SupplierPayment): POSState {
  return {
    ...state,
    supplierPayments: addSupplierPayment(state.supplierPayments || [], payment),
  };
}

export function withoutSupplierPayment(state: POSState, paymentId: string): POSState {
  return {
    ...state,
    supplierPayments: deleteSupplierPayment(state.supplierPayments || [], paymentId),
  };
}
