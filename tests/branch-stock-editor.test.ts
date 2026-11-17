import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBranchStockEdit } from '../src/lib/branchStockEditor.ts';

const base = {
  expectedShopId: 'shop-a',
  expectedBranchId: 'branch-a',
  selectedShopId: 'shop-a',
  selectedBranchId: 'branch-a',
  expectedQuantity: 8,
  nextQuantity: 11,
};

test('accepts a valid branch stock increase and decrease', () => {
  assert.deepEqual(validateBranchStockEdit(base), { ok: true, delta: 3 });
  assert.deepEqual(validateBranchStockEdit({ ...base, nextQuantity: 2 }), { ok: true, delta: -6 });
});

test('rejects shop or branch changes while the editor is open', () => {
  assert.equal(validateBranchStockEdit({ ...base, selectedShopId: 'shop-b' }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, selectedBranchId: 'branch-b' }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, expectedBranchId: null }).ok, false);
});

test('rejects missing, negative, fractional, or unsafe expected quantities', () => {
  for (const expectedQuantity of [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateBranchStockEdit({ ...base, expectedQuantity }).ok, false);
  }
});

test('rejects negative, fractional, or unsafe target quantities', () => {
  for (const nextQuantity of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateBranchStockEdit({ ...base, nextQuantity }).ok, false);
  }
});

test('rejects adjustments larger than one million units', () => {
  assert.equal(validateBranchStockEdit({ ...base, expectedQuantity: 0, nextQuantity: 1_000_001 }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, expectedQuantity: 1_000_001, nextQuantity: 0 }).ok, false);
});

test('allows an unchanged quantity and enforces a caller-supplied delta limit', () => {
  assert.deepEqual(validateBranchStockEdit({ ...base, nextQuantity: 8 }), { ok: true, delta: 0 });
  assert.equal(validateBranchStockEdit({ ...base, nextQuantity: 10, maxDelta: 1 }).ok, false);
});

import { buildBranchStockAdjustmentRpcRequest } from '../src/lib/branchStockRpc.ts';

const branchStockRpcBase = {
  shopId: 'shop-1',
  branchId: 'requested-branch',
  deviceId: 'device-1',
  productId: 'product-1',
  delta: 4,
  note: 'Inventory editor stock change',
  adjustmentId: 'adjustment-1',
};

test('branch stock editor sends expected quantity through the compare-and-set RPC', () => {
  const request = buildBranchStockAdjustmentRpcRequest(
    { ...branchStockRpcBase, expectedBranchQty: 9 },
    'resolved-branch',
  );
  assert.equal(request.rpcName, 'adjust_branch_stock_atomic_expected');
  assert.deepEqual(request.rpcArgs, {
    p_shop_id: 'shop-1',
    p_branch_id: 'resolved-branch',
    p_device_id: 'device-1',
    p_product_id: 'product-1',
    p_delta: 4,
    p_note: 'Inventory editor stock change',
    p_adjustment_id: 'adjustment-1',
    p_expected_branch_qty: 9,
  });
});

test('branch stock legacy adjustments keep the existing RPC contract without an expected quantity', () => {
  const request = buildBranchStockAdjustmentRpcRequest(branchStockRpcBase, 'resolved-branch');
  assert.equal(request.rpcName, 'adjust_branch_stock_atomic');
  assert.equal(Object.hasOwn(request.rpcArgs, 'p_expected_branch_qty'), false);
});

test('zero is a valid expected branch quantity and still selects compare-and-set', () => {
  const request = buildBranchStockAdjustmentRpcRequest(
    { ...branchStockRpcBase, expectedBranchQty: 0 },
    'resolved-branch',
  );
  assert.equal(request.rpcName, 'adjust_branch_stock_atomic_expected');
  assert.equal(request.rpcArgs.p_expected_branch_qty, 0);
});
