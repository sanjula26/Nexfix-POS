import assert from 'node:assert/strict';
import test from 'node:test';
import { runAutomaticPOSOverflowMigration, type AutomaticOverflowDependencies } from '../src/lib/storageOverflowAutoMigration.ts';

function harness(overrides: Partial<AutomaticOverflowDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: AutomaticOverflowDependencies = {
    getFolder: async () => ({ ok: true, available: true, storageMode: 'indexeddb', folderPath: 'C:/NexfixData' }),
    discoverProfiles: async () => ({
      available: [{ directory: 'C:/NexfixData/Nexfix POS Data', profileId: 'profile-123' }],
      duplicates: [],
      invalid: [],
    }),
    getProfileStatus: async () => ({ unlocked: true, profile: { profileId: 'profile-123' } }),
    unlockWithOS: async () => { calls.push('unlock-os'); },
    migrate: async () => { calls.push('migrate'); },
    ...overrides,
  };
  return { dependencies, calls };
}

test('automatically migrates when the selected profile is already unlocked', async () => {
  const h = harness();
  const result = await runAutomaticPOSOverflowMigration(h.dependencies);
  assert.deepEqual(result, { status: 'migrated', profileId: 'profile-123' });
  assert.deepEqual(h.calls, ['migrate']);
});

test('automatically unlocks the selected profile with Windows OS protection before migration', async () => {
  const h = harness({
    getProfileStatus: async () => ({ unlocked: false }),
  });
  const result = await runAutomaticPOSOverflowMigration(h.dependencies);
  assert.deepEqual(result, { status: 'migrated', profileId: 'profile-123' });
  assert.deepEqual(h.calls, ['unlock-os', 'migrate']);
});

test('returns a manual unlock requirement when Windows OS unlock is unavailable', async () => {
  const h = harness({
    getProfileStatus: async () => ({ unlocked: false }),
    unlockWithOS: async () => { throw new Error('OS key unavailable'); },
  });
  const result = await runAutomaticPOSOverflowMigration(h.dependencies);
  assert.deepEqual(result, { status: 'unlock_required', profileDirectory: 'C:/NexfixData/Nexfix POS Data' });
  assert.deepEqual(h.calls, []);
});

test('refuses to migrate if the selected folder is unavailable or no longer IndexedDB-primary', async () => {
  for (const folder of [
    { ok: false, available: false, storageMode: 'indexeddb' as const, folderPath: null },
    { ok: true, available: false, storageMode: 'indexeddb' as const, folderPath: 'C:/NexfixData' },
    { ok: true, available: true, storageMode: 'folder_primary' as const, folderPath: 'C:/NexfixData' },
  ]) {
    const h = harness({ getFolder: async () => folder });
    await assert.rejects(runAutomaticPOSOverflowMigration(h.dependencies), /overflow folder is unavailable/);
    assert.deepEqual(h.calls, []);
  }
});

test('refuses ambiguous, invalid, missing or duplicate profiles without migration', async () => {
  const cases = [
    { available: [], duplicates: [], invalid: [] },
    { available: [{ directory: 'profile', profileId: 'profile-123' }], duplicates: [{ profileId: 'profile-123' }], invalid: [] },
    { available: [{ directory: 'profile', profileId: 'profile-123' }], duplicates: [], invalid: [{ directory: 'bad' }] },
    { available: [{ directory: 'one', profileId: 'profile-123' }, { directory: 'two', profileId: 'profile-456' }], duplicates: [], invalid: [] },
  ];
  for (const discovery of cases) {
    const h = harness({ discoverProfiles: async () => discovery });
    await assert.rejects(runAutomaticPOSOverflowMigration(h.dependencies), /exactly one valid encrypted POS profile/);
    assert.deepEqual(h.calls, []);
  }
});

test('refuses to use a different profile already unlocked in this app session', async () => {
  const h = harness({
    getProfileStatus: async () => ({ unlocked: true, profile: { profileId: 'another-profile' } }),
  });
  await assert.rejects(runAutomaticPOSOverflowMigration(h.dependencies), /different encrypted POS profile/);
  assert.deepEqual(h.calls, []);
});
