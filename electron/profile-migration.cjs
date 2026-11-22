'use strict';

const crypto = require('node:crypto');

const MIGRATION_JOURNAL_VERSION = 1;
const MIGRATION_PURPOSES = Object.freeze([
  'app_state',
  'sync_queue',
  'meta',
  'restore_checkpoint',
]);
const MIGRATION_PHASES = Object.freeze([
  'snapshotting',
  'copying',
  'verifying',
  'ready_to_cutover',
  'folder_primary',
  'blocked_recovery',
]);
const PHASE_TRANSITIONS = Object.freeze({
  snapshotting: new Set(['copying', 'blocked_recovery']),
  copying: new Set(['verifying', 'blocked_recovery']),
  verifying: new Set(['ready_to_cutover', 'blocked_recovery']),
  ready_to_cutover: new Set(['folder_primary', 'blocked_recovery']),
  folder_primary: new Set(['blocked_recovery']),
  blocked_recovery: new Set(['snapshotting', 'copying', 'verifying', 'ready_to_cutover', 'folder_primary']),
});

function assertPurpose(purpose) {
  if (!MIGRATION_PURPOSES.includes(purpose)) {
    throw new Error('Unsupported POS migration data purpose.');
  }
}

function cloneJournal(journal) {
  return JSON.parse(JSON.stringify(journal));
}

function validateMigrationJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'Migration journal must be an object.' };
  }
  if (value.version !== MIGRATION_JOURNAL_VERSION ||
      typeof value.migrationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.migrationId) ||
      typeof value.profileId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.profileId) ||
      !MIGRATION_PHASES.includes(value.phase) ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
      !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    return { valid: false, reason: 'Migration journal identity, version, phase or timestamp is invalid.' };
  }

  const keys = Object.keys(value.entries).sort();
  if (keys.length !== MIGRATION_PURPOSES.length ||
      keys.some((key, index) => key !== [...MIGRATION_PURPOSES].sort()[index])) {
    return { valid: false, reason: 'Migration journal must contain exactly the four POS data domains.' };
  }

  for (const purpose of MIGRATION_PURPOSES) {
    const entry = value.entries[purpose];
    if (!entry || !['pending', 'copied', 'verified'].includes(entry.status)) {
      return { valid: false, reason: 'Migration journal contains an invalid data-domain status.' };
    }
    if (entry.status === 'pending') {
      if (entry.revision !== undefined || entry.bytes !== undefined || entry.sha256 !== undefined) {
        return { valid: false, reason: 'Pending migration entries cannot contain copy metadata.' };
      }
    } else if (!Number.isSafeInteger(entry.revision) || entry.revision < 1 ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      return { valid: false, reason: 'Copied migration entries require a revision, byte count and SHA-256 digest.' };
    }
  }

  if (['verifying', 'ready_to_cutover', 'folder_primary'].includes(value.phase) &&
      MIGRATION_PURPOSES.some(purpose => value.entries[purpose].status === 'pending')) {
    return { valid: false, reason: 'All four data domains must be copied before verification or cutover.' };
  }
  if (['ready_to_cutover', 'folder_primary'].includes(value.phase) &&
      MIGRATION_PURPOSES.some(purpose => value.entries[purpose].status !== 'verified')) {
    return { valid: false, reason: 'Every data domain must be verified before cutover.' };
  }
  return { valid: true };
}

function assertValidJournal(journal) {
  const result = validateMigrationJournal(journal);
  if (!result.valid) throw new Error(result.reason);
}

function createMigrationJournal(profileId, now = new Date().toISOString(), migrationId = crypto.randomUUID()) {
  const journal = {
    version: MIGRATION_JOURNAL_VERSION,
    migrationId,
    profileId: String(profileId || '').toLowerCase(),
    phase: 'snapshotting',
    updatedAt: now,
    entries: Object.fromEntries(MIGRATION_PURPOSES.map(purpose => [purpose, { status: 'pending' }])),
  };
  assertValidJournal(journal);
  return journal;
}

function recordMigrationCopy(journal, purpose, details, now = new Date().toISOString()) {
  assertValidJournal(journal);
  assertPurpose(purpose);
  if (journal.phase !== 'copying') throw new Error('Migration copies can only be recorded during the copying phase.');
  const { revision, bytes, sha256 } = details || {};
  if (!Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(bytes) || bytes < 0 ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('Migration copy confirmation is invalid.');
  }
  const next = cloneJournal(journal);
  next.entries[purpose] = { status: 'copied', revision, bytes, sha256: sha256.toLowerCase() };
  next.updatedAt = now;
  assertValidJournal(next);
  return next;
}

function recordMigrationVerification(journal, purpose, details, now = new Date().toISOString()) {
  assertValidJournal(journal);
  assertPurpose(purpose);
  if (journal.phase !== 'verifying') throw new Error('Migration data can only be verified during the verifying phase.');
  const previous = journal.entries[purpose];
  const { revision, bytes, sha256 } = details || {};
  if (previous.status !== 'copied' || revision !== previous.revision ||
      bytes !== previous.bytes || typeof sha256 !== 'string' ||
      sha256.toLowerCase() !== previous.sha256) {
    throw new Error('Migration read-back verification does not match the copied payload.');
  }
  const next = cloneJournal(journal);
  next.entries[purpose].status = 'verified';
  next.updatedAt = now;
  assertValidJournal(next);
  return next;
}

function transitionMigrationJournal(journal, nextPhase, now = new Date().toISOString()) {
  assertValidJournal(journal);
  if (!MIGRATION_PHASES.includes(nextPhase) ||
      !PHASE_TRANSITIONS[journal.phase].has(nextPhase)) {
    throw new Error('The requested POS migration phase transition is not allowed.');
  }
  const next = cloneJournal(journal);
  next.phase = nextPhase;
  next.updatedAt = now;
  if (journal.phase === 'blocked_recovery' && nextPhase === 'snapshotting') {
    next.entries = Object.fromEntries(MIGRATION_PURPOSES.map(purpose => [
      purpose, { status: 'pending' },
    ]));
  }
  assertValidJournal(next);
  return next;
}

module.exports = {
  MIGRATION_JOURNAL_VERSION,
  MIGRATION_PURPOSES,
  MIGRATION_PHASES,
  createMigrationJournal,
  validateMigrationJournal,
  recordMigrationCopy,
  recordMigrationVerification,
  transitionMigrationJournal,
};
