import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STORAGE_QUOTA_WARNING_EVENT,
  dispatchStorageQuotaWarning,
  subscribeToStorageQuotaWarnings,
} from '../src/lib/storageOverflowEvents.ts';

test('QA quota injection uses the same shared event consumed by the production POS', () => {
  const target = new EventTarget();
  const received: string[] = [];
  const unsubscribe = subscribeToStorageQuotaWarnings(target, detail => received.push(detail.reason));

  dispatchStorageQuotaWarning(target, { reason: 'quota_exceeded' });
  target.dispatchEvent(new CustomEvent(STORAGE_QUOTA_WARNING_EVENT, { detail: { reason: 'unknown' } }));

  assert.deepEqual(received, ['quota_exceeded']);
  unsubscribe();
  dispatchStorageQuotaWarning(target, { reason: 'quota_exceeded' });
  assert.deepEqual(received, ['quota_exceeded']);
});
