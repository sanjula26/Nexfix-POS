'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MIGRATION_PURPOSES,
  createMigrationJournal,
  validateMigrationJournal,
  recordMigrationCopy,
  recordMigrationVerification,
  transitionMigrationJournal,
} = require('../electron/profile-migration.cjs');

const PROFILE_ID = 'd9d6f0e1-5b2d-4e21-9e72-0cce0d8c7a10';
const HASH = 'a'.repeat(64);
const NOW = '2026-11-22T08:00:00.000Z';

function copiedJournal() {
  let journal = createMigrationJournal(PROFILE_ID, NOW);
  journal = transitionMigrationJournal(journal, 'copying', NOW);
  for (const purpose of MIGRATION_PURPOSES) {
    journal = recordMigrationCopy(journal, purpose, { revision: 1, bytes: 12, sha256: HASH }, NOW);
  }
  return transitionMigrationJournal(journal, 'verifying', NOW);
}

test('creates a versioned journal with exactly the four coordinated POS data domains', () => {
  const journal = createMigrationJournal(PROFILE_ID, NOW);
  assert.equal(journal.version, 1);
  assert.equal(journal.phase, 'snapshotting');
  assert.deepEqual(Object.keys(journal.entries).sort(), [...MIGRATION_PURPOSES].sort());
  assert.ok(MIGRATION_PURPOSES.every(purpose => journal.entries[purpose].status === 'pending'));
  assert.equal(validateMigrationJournal(journal).valid, true);
});

test('requires copy confirmations for every domain before entering verification', () => {
  let journal = createMigrationJournal(PROFILE_ID, NOW);
  journal = transitionMigrationJournal(journal, 'copying', NOW);
  journal = recordMigrationCopy(journal, 'app_state', { revision: 1, bytes: 12, sha256: HASH }, NOW);
  assert.throws(() => transitionMigrationJournal(journal, 'verifying', NOW), /All four data domains/);
  assert.throws(() => recordMigrationCopy(journal, 'cookies', { revision: 1, bytes: 1, sha256: HASH }, NOW), /Unsupported/);
});

test('requires read-back metadata to match before the journal can authorize cutover', () => {
  let journal = copiedJournal();
  assert.throws(() => recordMigrationVerification(journal, 'app_state', {
    revision: 2, bytes: 12, sha256: HASH,
  }, NOW), /does not match/);
  assert.throws(() => transitionMigrationJournal(journal, 'ready_to_cutover', NOW), /Every data domain/);

  for (const purpose of MIGRATION_PURPOSES) {
    journal = recordMigrationVerification(journal, purpose, {
      revision: 1, bytes: 12, sha256: HASH,
    }, NOW);
  }
  journal = transitionMigrationJournal(journal, 'ready_to_cutover', NOW);
  assert.equal(journal.phase, 'ready_to_cutover');
  assert.equal(validateMigrationJournal(journal).valid, true);
});

test('only allows folder-primary after all domains are verified and preserves prior journal values', () => {
  const verified = MIGRATION_PURPOSES.reduce((journal, purpose) =>
    recordMigrationVerification(journal, purpose, { revision: 1, bytes: 12, sha256: HASH }, NOW),
    copiedJournal());
  const ready = transitionMigrationJournal(verified, 'ready_to_cutover', NOW);
  const active = transitionMigrationJournal(ready, 'folder_primary', NOW);
  assert.equal(active.phase, 'folder_primary');
  assert.equal(ready.phase, 'ready_to_cutover');
  assert.ok(MIGRATION_PURPOSES.every(purpose => active.entries[purpose].status === 'verified'));
  assert.throws(() => transitionMigrationJournal(active, 'copying', NOW), /not allowed/);
});

test('blocked recovery requires a fresh snapshot and clears old copy evidence', () => {
  let journal = copiedJournal();
  journal = transitionMigrationJournal(journal, 'blocked_recovery', NOW);
  assert.throws(() => transitionMigrationJournal(journal, 'folder_primary', NOW), /not allowed/);
  journal = transitionMigrationJournal(journal, 'snapshotting', NOW);
  assert.ok(MIGRATION_PURPOSES.every(purpose => journal.entries[purpose].status === 'pending'));
  assert.equal(journal.phase, 'snapshotting');
});

test('rejects malformed identities, incomplete domains and unsafe cutover journals', () => {
  const journal = createMigrationJournal(PROFILE_ID, NOW);
  assert.equal(validateMigrationJournal({ ...journal, profileId: '../other' }).valid, false);
  assert.equal(validateMigrationJournal({
    ...journal,
    entries: { app_state: { status: 'pending' } },
  }).valid, false);
  const unsafe = {
    ...journal,
    phase: 'folder_primary',
    entries: Object.fromEntries(MIGRATION_PURPOSES.map(purpose => [
      purpose, { status: 'copied', revision: 1, bytes: 12, sha256: HASH },
    ])),
  };
  assert.equal(validateMigrationJournal(unsafe).valid, false);
});
