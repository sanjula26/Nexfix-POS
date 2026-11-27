import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSaleCreateQueueInput } from '../src/lib/saleQueuePayload.ts';
import type { Sale } from '../src/lib/types.ts';

const baseSale = {
  id: 'sale-offline-1',
  branchId: 'branch-a',
  billNo: 'NFX-20261127-0012',
  date: '2026-11-27T06:30:00.000Z',
  cashierId: 'local-admin',
  cashierName: 'Admin',
  customerId: 'customer-local-1',
  customerName: 'Walk-in',
  items: [{ productId: 'usb-1', name: 'USB', qty: 2, price: 600, cost: 400, discount: 50, unitIds: ['unit-1', 'unit-2'] }],
  subtotal: 1150,
  discount: 100,
  tax: 105,
  shipping: 50,
  total: 1205,
  payment: 'cash',
  payments: [{ method: 'cash', amount: 1205 }],
  pointsRedeemed: 5,
  note: 'offline sale',
  amountPaid: 1205,
  change: 0,
  profit: 200,
  status: 'completed',
} satisfies Sale;

test('offline replay payload preserves branch, totals, line discounts and tracked units', () => {
  const input = buildSaleCreateQueueInput(baseSale, 'local-fallback');
  assert.equal(input.branchId, 'branch-a');
  assert.equal(input.discount, 100);
  assert.equal(input.taxPct, (105 / (1150 - 100)) * 100);
  assert.deepEqual(input.lines, [{
    productId: 'usb-1', qty: 2, discount: 50, price: 600, unitIds: ['unit-1', 'unit-2'],
  }]);
  assert.deepEqual(input.payments, [{ method: 'cash', amount: 1205 }]);
  assert.equal(input.customerId, 'customer-local-1');
  assert.equal(input.salesmanId, 'local-admin');
});

test('trade-in amount and identifiers are included only when the trade-in is added to inventory', () => {
  const sale = {
    ...baseSale,
    tradeIn: { productId: 'phone-1', value: 300, imei: '123456789012345', addToInventory: true, unitId: 'trade-unit-1' },
  } satisfies Sale;
  const input = buildSaleCreateQueueInput(sale);
  assert.equal(input.discount, sale.discount);
  assert.equal(input.tradeInValue, 300);
  assert.deepEqual(input.tradeIn, {
    unitId: 'trade-unit-1', productId: 'phone-1', value: 300, imei: '123456789012345', serial: undefined,
  });
});

test('non-inventory trade-in is represented as a discount without creating a tracked-unit job', () => {
  const sale = {
    ...baseSale,
    tradeIn: { productId: 'phone-1', value: 300, addToInventory: false },
  } satisfies Sale;
  const input = buildSaleCreateQueueInput(sale);
  assert.equal(input.tradeInValue, 300);
  assert.equal(input.discount, sale.discount + 300);
  assert.equal(input.tradeIn, undefined);
});

test('tax percentage is zero when the taxable base is zero', () => {
  const sale = { ...baseSale, subtotal: 100, discount: 100, tax: 0 } satisfies Sale;
  assert.equal(buildSaleCreateQueueInput(sale).taxPct, 0);
});
