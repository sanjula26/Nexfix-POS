import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBranchStockDeltas,
  cacheBranchStock,
  cacheBranchStockProduct,
  cacheDefaultBranchId,
  cachePOSDeviceBranchId,
  getCachedBranchStock,
  getCachedPOSDeviceBranchId,
  getDefaultBranchId,
  getPOSBranchId,
  hasCachedBranchStock,
  isBranchStockCacheReady,
  isLocalMainStockReady,
} from '../src/lib/branchStock.ts';

type MemoryValues = Map<string, string>;

function withLocalStorage(run: (values: MemoryValues) => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values: MemoryValues = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
    },
  });

  try {
    run(values);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('branch stock cache is isolated by branch and refresh replaces the branch snapshot', () => {
  withLocalStorage(() => {
    cacheBranchStock('branch-a', [
      { product_id: 'product-1', qty: 4 },
      { product_id: 'product-2', qty: '7' },
    ]);
    cacheBranchStock('branch-b', [{ product_id: 'product-1', qty: 12 }]);

    assert.equal(getCachedBranchStock('branch-a', 'product-1'), 4);
    assert.equal(getCachedBranchStock('branch-a', 'product-2'), 7);
    assert.equal(getCachedBranchStock('branch-b', 'product-1'), 12);

    cacheBranchStock('branch-a', [{ product_id: 'product-1', qty: 5 }]);
    assert.equal(getCachedBranchStock('branch-a', 'product-1'), 5);
    assert.equal(getCachedBranchStock('branch-a', 'product-2'), null);
    assert.equal(getCachedBranchStock('branch-b', 'product-1'), 12);
  });
});

test('branch stock cache ignores invalid rows and never writes local-main stock', () => {
  withLocalStorage(() => {
    cacheBranchStock('branch-a', [
      { product_id: 'negative', qty: -1 },
      { product_id: 'not-a-number', qty: 'not-a-number' },
      { product_id: 'infinite', qty: Number.POSITIVE_INFINITY },
      { product_id: '', qty: 8 },
    ]);
    cacheBranchStock('local-main', [{ product_id: 'product-1', qty: 99 }]);

    assert.equal(getCachedBranchStock('branch-a', 'negative'), null);
    assert.equal(getCachedBranchStock('branch-a', 'not-a-number'), null);
    assert.equal(getCachedBranchStock('branch-a', 'infinite'), null);
    assert.equal(getCachedBranchStock('local-main', 'product-1'), null);
    assert.equal(hasCachedBranchStock('local-main'), false);
  });
});

test('incremental server cache updates preserve other products and reject invalid quantities', () => {
  withLocalStorage(() => {
    cacheBranchStock('branch-a', [
      { product_id: 'product-1', qty: 4 },
      { product_id: 'product-2', qty: 8 },
    ]);

    assert.equal(cacheBranchStockProduct('branch-a', 'product-1', 6), true);
    assert.equal(getCachedBranchStock('branch-a', 'product-1'), 6);
    assert.equal(getCachedBranchStock('branch-a', 'product-2'), 8);

    assert.equal(cacheBranchStockProduct('branch-a', 'product-3', -1), false);
    assert.equal(cacheBranchStockProduct('branch-a', 'product-3', 1.5), false);
    assert.equal(cacheBranchStockProduct('branch-a', '', 1), false);
    assert.equal(cacheBranchStockProduct('local-main', 'product-1', 2), false);
    assert.equal(getCachedBranchStock('branch-a', 'product-1'), 6);
    assert.equal(getCachedBranchStock('branch-a', 'product-2'), 8);
  });
});

test('stock delta batches are atomic and reject missing or negative quantities', () => {
  withLocalStorage(() => {
    cacheBranchStock('branch-a', [
      { product_id: 'product-1', qty: 5 },
      { product_id: 'product-2', qty: 2 },
    ]);

    assert.equal(applyBranchStockDeltas('branch-a', { 'product-1': 2, 'product-2': -3 }), false);
    assert.equal(getCachedBranchStock('branch-a', 'product-1'), 5);
    assert.equal(getCachedBranchStock('branch-a', 'product-2'), 2);

    assert.equal(applyBranchStockDeltas('branch-a', { 'product-1': -2, 'product-2': 3 }), true);
    assert.equal(getCachedBranchStock('branch-a', 'product-1'), 3);
    assert.equal(getCachedBranchStock('branch-a', 'product-2'), 5);
    assert.equal(applyBranchStockDeltas('branch-a', { 'missing-product': -1 }), false);
    assert.equal(getCachedBranchStock('branch-a', 'product-1'), 3);
  });
});

test('branch cache readiness requires the selected branch or its previously verified offline device branch', () => {
  assert.equal(isBranchStockCacheReady('branch-a', 'branch-a', true), true);
  assert.equal(isBranchStockCacheReady('branch-a', 'branch-b', true), false);
  assert.equal(isBranchStockCacheReady('branch-a', 'branch-b', true, 'branch-a', true), true);
  assert.equal(isBranchStockCacheReady('branch-a', 'branch-b', true, 'branch-b', true), false);
  assert.equal(isBranchStockCacheReady('branch-a', 'branch-a', false), false);
  assert.equal(isBranchStockCacheReady('local-main', 'local-main', true), false);

  assert.equal(isLocalMainStockReady('', false), true);
  assert.equal(isLocalMainStockReady('shop-1', false), false);
  assert.equal(isLocalMainStockReady('', true), false);
});

test('default and device branch caches remain scoped to the correct shop', () => {
  withLocalStorage(() => {
    cacheDefaultBranchId('shop-1', 'branch-default');
    cacheDefaultBranchId('shop-2', 'branch-other');
    cachePOSDeviceBranchId('shop-1', 'branch-device');

    assert.equal(getDefaultBranchId('shop-1'), 'branch-default');
    assert.equal(getDefaultBranchId('shop-2'), 'branch-other');
    assert.equal(getCachedPOSDeviceBranchId('shop-1'), 'branch-device');
    assert.equal(getCachedPOSDeviceBranchId('shop-2'), null);
    assert.equal(getPOSBranchId('shop-1', 'stale-settings-branch'), 'branch-device');
    assert.equal(getPOSBranchId('shop-2', 'configured-branch'), 'configured-branch');
  });
});
