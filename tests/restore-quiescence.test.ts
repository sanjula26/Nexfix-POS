import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBackupRestore, completeRestore, pauseRestoreWork } from '../src/lib/restore.ts';

test('restore and checkpoint cleanup are rejected while storage maintenance is paused', async () => {
  const release = await pauseRestoreWork();
  try {
    await assert.rejects(
      applyBackupRestore({} as never, {}),
      /restore is temporarily paused for safe storage maintenance/i,
    );
    await assert.rejects(
      completeRestore(),
      /restore checkpoint cleanup is temporarily paused for safe storage maintenance/i,
    );
  } finally {
    release();
  }
});

test('restore pause lease can be released idempotently', async () => {
  const release = await pauseRestoreWork();
  release();
  release();
  // With the gate open, restore reaches its ordinary admin check rather than
  // being rejected by the storage-maintenance boundary.
  await assert.rejects(
    applyBackupRestore({} as never, {}),
    /only an active admin can restore POS data/i,
  );
});
