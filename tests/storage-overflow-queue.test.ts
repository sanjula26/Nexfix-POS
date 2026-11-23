import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureOfflineStateWriteMarker } from '../src/lib/storageOverflowQueue.ts';

test('adds a durable state sync marker when quota prevented the final offline queue write', () => {
  const result = ensureOfflineStateWriteMarker([], false, {
    id: 'migration-marker-1',
    ts: '2026-11-23T06:00:00.000Z',
  });
  assert.deepEqual(result, [{
    type: 'state_write',
    id: 'migration-marker-1',
    ts: '2026-11-23T06:00:00.000Z',
    note: 'state_write_offline',
  }]);
});

test('does not duplicate a state sync marker committed before a later queue write failed', () => {
  const existing = [{
    type: 'state_write' as const,
    id: 'existing-marker',
    ts: '2026-11-23T06:00:00.000Z',
    note: 'state_write_offline',
  }];
  const result = ensureOfflineStateWriteMarker(existing, false, {
    id: 'must-not-be-used',
    ts: '2026-11-23T06:01:00.000Z',
  });
  assert.deepEqual(result, existing);
});

test('leaves the queue unchanged when the final state marker was confirmed saved', () => {
  const existing = [{
    type: 'sale_create' as const,
    id: 'sale:test-safe-fixture',
    ts: '2026-11-23T06:00:00.000Z',
    payload: '{"saleId":"test-safe-fixture"}',
  }];
  assert.deepEqual(ensureOfflineStateWriteMarker(existing, true), existing);
});
