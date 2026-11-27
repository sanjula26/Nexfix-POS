import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchStorageQuotaWarning,
  subscribeToStorageQuotaWarnings,
  dispatchStoragePrimaryCommitted,
  subscribeToStoragePrimaryCommitted,
  type StorageQuotaWarning,
} from '../src/lib/storageOverflowEvents.ts';

test('quota warning event reaches the storage controller listener with the original detail', () => {
  const target = new EventTarget();
  const received: StorageQuotaWarning[] = [];
  const unsubscribe = subscribeToStorageQuotaWarnings(target, detail => received.push(detail));
  const warning: StorageQuotaWarning = {
    reason: 'quota_exceeded',
    usage: 950,
    quota: 1000,
    ratio: 0.95,
  };

  dispatchStorageQuotaWarning(target, warning);

  assert.deepEqual(received, [warning]);
  unsubscribe();
  dispatchStorageQuotaWarning(target, { reason: 'near_quota', ratio: 0.86 });
  assert.deepEqual(received, [warning]);
});

test('quota warning listener ignores invalid event details', () => {
  const target = new EventTarget();
  const received: StorageQuotaWarning[] = [];
  const unsubscribe = subscribeToStorageQuotaWarnings(target, detail => received.push(detail));
  target.dispatchEvent(new CustomEvent('nexfix:storage-quota-warning', {
    detail: { reason: 'unknown' },
  }));
  assert.deepEqual(received, []);
  unsubscribe();
});


test('encrypted storage cutover notification is delivered only to active subscribers', () => {
  const target = new EventTarget();
  let calls = 0;
  const unsubscribe = subscribeToStoragePrimaryCommitted(target, () => { calls += 1; });
  dispatchStoragePrimaryCommitted(target);
  assert.equal(calls, 1);
  unsubscribe();
  dispatchStoragePrimaryCommitted(target);
  assert.equal(calls, 1);
});
