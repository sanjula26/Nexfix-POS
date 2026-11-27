import assert from 'node:assert/strict';
import test from 'node:test';
import { canUploadLegacySnapshot } from '../src/lib/offlineSnapshotGate.ts';

test('allows a legacy snapshot when no transaction queue operations remain', () => {
  assert.equal(canUploadLegacySnapshot([]), true);
});

test('allows the snapshot path for snapshot-only queue records', () => {
  assert.equal(canUploadLegacySnapshot(['state_write', 'backup', 'custom']), true);
});

test('blocks legacy snapshots while a sale transaction is still pending', () => {
  assert.equal(canUploadLegacySnapshot(['state_write', 'sale_create']), false);
});

test('blocks legacy snapshots while normalized GRN, return, repair or stock jobs remain', () => {
  for (const type of ['purchase_receive', 'return_create', 'repair_delivery', 'branch_stock_adjustment', 'inventory_units_add', 'sale_reversal_request']) {
    assert.equal(canUploadLegacySnapshot([type]), false, type);
  }
});
