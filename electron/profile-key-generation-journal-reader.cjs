'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_ENVELOPE_BYTES,
  MAX_COMMIT_BYTES,
  MAX_COMMIT_MARKERS,
  generationEnvelopeFileName,
  generationCommitFileName,
  selectCommittedKeyGeneration,
} = require('./profile-key-generation-journal.cjs');
const { validateProfileKeyEnvelope } = require('./profile-key-store.cjs');

const LEGACY_ENVELOPE_FILE = 'nexfix-key-envelope.json';
const COMMIT_PREFIX = 'nexfix-key-envelope.commit.';
const COMMIT_NAME_PATTERN = /^nexfix-key-envelope\.commit\.g([0-9]{8})\.json$/;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

function statRegularFile(fsApi, filePath, label, maxBytes) {
  let stat;
  try {
    stat = fsApi.lstatSync(filePath);
  } catch {
    throw new Error(`${label} is missing or cannot be inspected.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular, non-symbolic-link file.`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error(`${label} exceeds its allowed size or is empty.`);
  }
  return stat;
}

function assertFileUnchanged(fsApi, filePath, before, label) {
  let after;
  try {
    after = fsApi.lstatSync(filePath);
  } catch {
    throw new Error(`${label} changed while it was being read.`);
  }
  if (after.isSymbolicLink() || !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs) {
    throw new Error(`${label} changed while it was being read.`);
  }
}

function readRegularFile(fsApi, filePath, label, maxBytes, total) {
  const before = statRegularFile(fsApi, filePath, label, maxBytes);
  total.bytes += before.size;
  if (total.bytes > MAX_TOTAL_BYTES) {
    throw new Error('Recovery Key journal exceeds the total read-size limit.');
  }

  let bytes;
  try {
    bytes = fsApi.readFileSync(filePath);
  } catch {
    throw new Error(`${label} could not be read.`);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== before.size || bytes.length > maxBytes) {
    throw new Error(`${label} changed size while it was being read.`);
  }
  assertFileUnchanged(fsApi, filePath, before, label);
  return bytes;
}

/**
 * Reads a bounded snapshot of the legacy envelope and final generation commit
 * markers, then delegates all cryptographic/schema selection to the pure
 * journal selector.
 *
 * This read-only prototype rejects symbolic links and non-regular files and
 * checks that file identity/size/timestamps stay stable around path-based
 * reads. It does not eliminate every path-swap/reparse-point TOCTOU race:
 * production integration still requires a reviewed native handle-based
 * reparse-point-safe adapter and crash tests. This module is not wired to
 * startup or key-store/session code.
 */
function readKeyGenerationJournal(profileDirectory, profileId, options = {}) {
  const fsApi = options.fsApi ?? fs;
  const pathApi = options.pathApi ?? path;
  const envelopeValidator = options.validateEnvelope ?? validateProfileKeyEnvelope;

  if (typeof profileDirectory !== 'string' || !pathApi.isAbsolute(profileDirectory)) {
    throw new Error('An absolute POS profile directory is required.');
  }
  if (typeof envelopeValidator !== 'function') {
    throw new Error('Recovery Key journal requires an envelope validator.');
  }

  let directoryStat;
  try {
    directoryStat = fsApi.lstatSync(profileDirectory);
  } catch {
    throw new Error('The POS profile directory is unavailable.');
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('The POS profile directory must be a real, non-symbolic-link folder.');
  }

  let canonicalDirectory;
  try {
    canonicalDirectory = fsApi.realpathSync(profileDirectory);
  } catch {
    throw new Error('The POS profile directory cannot be resolved.');
  }
  const canonicalStat = fsApi.lstatSync(canonicalDirectory);
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) {
    throw new Error('The resolved POS profile directory is not a normal folder.');
  }

  let entries;
  try {
    entries = fsApi.readdirSync(canonicalDirectory, { encoding: 'utf8' });
  } catch {
    throw new Error('The POS profile journal directory cannot be listed.');
  }
  if (!Array.isArray(entries) || entries.some(name => typeof name !== 'string')) {
    throw new Error('The POS profile journal directory listing is invalid.');
  }

  const markerNames = entries.filter(name => name.startsWith(COMMIT_PREFIX));
  if (markerNames.length > MAX_COMMIT_MARKERS) {
    throw new Error('Recovery Key journal has too many commit markers.');
  }
  for (const name of markerNames) {
    const match = name.match(COMMIT_NAME_PATTERN);
    if (!match) {
      throw new Error('Recovery Key journal contains a non-canonical commit marker filename.');
    }
    const generation = Number(match[1]);
    if (generation <= 0 || generation > 99_999_999 ||
        name !== generationCommitFileName(generation)) {
      throw new Error('Recovery Key journal contains an invalid commit marker generation.');
    }
  }

  const total = { bytes: 0 };
  const legacyPath = pathApi.join(canonicalDirectory, LEGACY_ENVELOPE_FILE);
  const legacyEnvelopeBytes = readRegularFile(
    fsApi,
    legacyPath,
    'Legacy POS profile key envelope',
    MAX_ENVELOPE_BYTES,
    total,
  );

  const commitRecords = markerNames.map(markerFileName => {
    const generation = Number(markerFileName.match(COMMIT_NAME_PATTERN)[1]);
    const markerPath = pathApi.join(canonicalDirectory, markerFileName);
    const envelopeFileName = generationEnvelopeFileName(generation);
    const envelopePath = pathApi.join(canonicalDirectory, envelopeFileName);
    return {
      markerFileName,
      markerBytes: readRegularFile(
        fsApi,
        markerPath,
        'Recovery Key commit marker',
        MAX_COMMIT_BYTES,
        total,
      ),
      envelopeFileName,
      envelopeBytes: readRegularFile(
        fsApi,
        envelopePath,
        'Committed Recovery Key envelope',
        MAX_ENVELOPE_BYTES,
        total,
      ),
    };
  });

  return selectCommittedKeyGeneration({
    profileId,
    legacyEnvelopeBytes,
    commitRecords,
    validateEnvelope: envelopeValidator,
  });
}

module.exports = {
  MAX_TOTAL_BYTES,
  readKeyGenerationJournal,
};
