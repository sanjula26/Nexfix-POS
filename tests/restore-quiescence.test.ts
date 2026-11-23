import assert from 'node:assert/strict';
import test from 'node:test';
import { pauseRestoreWork, runRestoreWork } from '../src/lib/restoreWorkGate.ts';

test('restore operations are rejected while the storage maintenance lease is held', async () => {
  const release = await pauseRestoreWork();
  try {
    await assert.rejects(
      runRestoreWork(() => 'unsafe', 'POS restore is temporarily paused for safe storage maintenance.'),
      /restore is temporarily paused for safe storage maintenance/i,
    );
    await assert.rejects(
      runRestoreWork(() => undefined, 'POS restore checkpoint cleanup is temporarily paused for safe storage maintenance.'),
      /restore checkpoint cleanup is temporarily paused for safe storage maintenance/i,
    );
  } finally {
    release();
  }
});

test('restore gate drains active work and reopens after an idempotent release', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  const active = runRestoreWork(async () => { started(); await pending; return 'complete'; });
  await didStart;
  const pause = pauseRestoreWork();
  await assert.rejects(
    runRestoreWork(() => 'blocked'),
    /restore is temporarily paused for safe storage maintenance/i,
  );
  finish();
  assert.equal(await active, 'complete');
  const release = await pause;
  release();
  release();
  assert.equal(await runRestoreWork(() => 'resumed'), 'resumed');
});
