'use strict';

const crypto = require('node:crypto');

const KEY_ENVELOPE_FORMAT = 'nexfix-pos-key-envelope';
const KEY_ENVELOPE_VERSION = 1;
const COMMIT_FORMAT = 'nexfix-pos-key-envelope-commit';
const COMMIT_VERSION = 1;
const LEGACY_ENVELOPE_FILE = 'nexfix-key-envelope.json';
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_COMMIT_BYTES = 4 * 1024;
const MAX_COMMIT_MARKERS = 1024;
const MAX_GENERATION = 99_999_999;

const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_FILE_PATTERN = /^nexfix-key-envelope\.commit\.g([0-9]{8})\.json$/;

const COMMIT_KEYS = Object.freeze([
  'format',
  'version',
  'profileId',
  'generation',
  'envelopeFileName',
  'envelopeSha256',
  'previousCommitSha256',
  'operationId',
  'createdAt',
].sort());

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function generationSuffix(generation) {
  if (!Number.isSafeInteger(generation) || generation <= 0 || generation > MAX_GENERATION) {
    throw new Error('Recovery Key journal generation number is outside the supported range.');
  }
  return String(generation).padStart(8, '0');
}

function generationEnvelopeFileName(generation) {
  return `nexfix-key-envelope.g${generationSuffix(generation)}.json`;
}

function generationCommitFileName(generation) {
  return `nexfix-key-envelope.commit.g${generationSuffix(generation)}.json`;
}

function toBoundedBuffer(value, maxBytes, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`${label} must be a byte buffer.`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length <= 0 || bytes.length > maxBytes) {
    throw new Error(`${label} has an invalid size.`);
  }
  return bytes;
}

function parseJsonBytes(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return parsed;
}

function validateEnvelope(envelope, expectedProfileId, validateEnvelopeFn) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      envelope.format !== KEY_ENVELOPE_FORMAT ||
      envelope.version !== KEY_ENVELOPE_VERSION ||
      envelope.profileId !== expectedProfileId) {
    throw new Error('Recovery Key journal envelope identity or version is invalid.');
  }

  let result;
  try {
    result = validateEnvelopeFn(envelope, expectedProfileId);
  } catch {
    throw new Error('Recovery Key journal envelope failed structural validation.');
  }
  if (!result || result.valid !== true) {
    throw new Error('Recovery Key journal envelope failed structural validation.');
  }
  return result.envelope ?? envelope;
}

/**
 * Pure startup selector for the proposed append-only key-envelope journal.
 *
 * The filesystem adapter is responsible for enumerating only final commit
 * marker files and loading the matching envelope bytes. This function performs
 * no I/O, does not mutate files, and is intentionally not wired to production
 * key-store/session code yet.
 *
 * Every supplied final marker must be valid and linked. A malformed or
 * incomplete final marker fails closed; an uncommitted envelope with no final
 * marker is not supplied and therefore cannot become active.
 */
function selectCommittedKeyGeneration({
  profileId,
  legacyEnvelopeBytes,
  commitRecords = [],
  validateEnvelope: validateEnvelopeFn,
}) {
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId) ||
      profileId !== profileId.toLowerCase()) {
    throw new Error('Recovery Key journal profile ID is invalid.');
  }
  if (typeof validateEnvelopeFn !== 'function') {
    throw new Error('Recovery Key journal requires an envelope validator.');
  }
  if (!Array.isArray(commitRecords) || commitRecords.length > MAX_COMMIT_MARKERS) {
    throw new Error('Recovery Key journal has too many commit markers.');
  }

  const legacyBytes = toBoundedBuffer(
    legacyEnvelopeBytes,
    MAX_ENVELOPE_BYTES,
    'Legacy Recovery Key envelope',
  );
  const legacyParsed = parseJsonBytes(legacyBytes, 'Legacy Recovery Key envelope');
  const legacyEnvelope = validateEnvelope(legacyParsed, profileId, validateEnvelopeFn);

  if (commitRecords.length === 0) {
    return {
      generation: 0,
      isLegacy: true,
      envelopeFileName: LEGACY_ENVELOPE_FILE,
      envelope: legacyEnvelope,
      envelopeSha256: sha256(legacyBytes),
      commitMarkerSha256: null,
      operationId: null,
    };
  }

  const normalized = commitRecords.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Recovery Key journal commit record is invalid.');
    }
    const name = record.markerFileName;
    const match = typeof name === 'string' ? name.match(COMMIT_FILE_PATTERN) : null;
    if (!match) throw new Error('Recovery Key journal commit marker filename is invalid.');
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation <= 0 ||
        generation > MAX_GENERATION ||
        String(generation).padStart(8, '0') !== match[1] ||
        name !== generationCommitFileName(generation)) {
      throw new Error('Recovery Key journal generation number is invalid.');
    }
    return { ...record, generation };
  }).sort((a, b) => a.generation - b.generation);

  if (normalized[0].generation !== 1) {
    throw new Error('Recovery Key journal is missing generation 1.');
  }

  let expectedPreviousHash = sha256(legacyBytes);
  const seenOperationIds = new Set();
  let selected = null;

  for (let index = 0; index < normalized.length; index += 1) {
    const record = normalized[index];
    const expectedGeneration = index + 1;
    if (record.generation !== expectedGeneration) {
      throw new Error('Recovery Key journal generations are duplicated or incomplete.');
    }

    const markerBytes = toBoundedBuffer(
      record.markerBytes,
      MAX_COMMIT_BYTES,
      'Recovery Key commit marker',
    );
    const markerText = markerBytes.toString('utf8');
    const marker = parseJsonBytes(markerBytes, 'Recovery Key commit marker');
    if (JSON.stringify(marker) !== markerText) {
      throw new Error('Recovery Key commit marker JSON is not canonical.');
    }

    const keys = Object.keys(marker).sort();
    if (keys.length !== COMMIT_KEYS.length ||
        keys.some((key, keyIndex) => key !== COMMIT_KEYS[keyIndex])) {
      throw new Error('Recovery Key commit marker contains unsupported fields.');
    }

    if (marker.format !== COMMIT_FORMAT ||
        marker.version !== COMMIT_VERSION ||
        marker.profileId !== profileId ||
        marker.generation !== expectedGeneration ||
        marker.envelopeFileName !== generationEnvelopeFileName(expectedGeneration) ||
        typeof marker.envelopeSha256 !== 'string' || !HASH_PATTERN.test(marker.envelopeSha256) ||
        marker.previousCommitSha256 !== expectedPreviousHash ||
        typeof marker.operationId !== 'string' || !UUID_PATTERN.test(marker.operationId) ||
        seenOperationIds.has(marker.operationId) ||
        typeof marker.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(marker.createdAt)) ||
        new Date(marker.createdAt).toISOString() !== marker.createdAt ||
        record.envelopeFileName !== marker.envelopeFileName) {
      throw new Error('Recovery Key commit marker identity, chain or fields are invalid.');
    }
    seenOperationIds.add(marker.operationId);

    const envelopeBytes = toBoundedBuffer(
      record.envelopeBytes,
      MAX_ENVELOPE_BYTES,
      'Committed Recovery Key envelope',
    );
    const actualEnvelopeHash = sha256(envelopeBytes);
    if (actualEnvelopeHash !== marker.envelopeSha256) {
      throw new Error('Committed Recovery Key envelope hash does not match its marker.');
    }

    const parsedEnvelope = parseJsonBytes(envelopeBytes, 'Committed Recovery Key envelope');
    const envelope = validateEnvelope(parsedEnvelope, profileId, validateEnvelopeFn);
    const markerHash = sha256(markerBytes);

    selected = {
      generation: expectedGeneration,
      isLegacy: false,
      envelopeFileName: marker.envelopeFileName,
      envelope,
      envelopeSha256: actualEnvelopeHash,
      commitMarkerFileName: record.markerFileName,
      commitMarkerSha256: markerHash,
      operationId: marker.operationId,
    };
    expectedPreviousHash = markerHash;
  }

  return selected;
}

module.exports = {
  LEGACY_ENVELOPE_FILE,
  MAX_ENVELOPE_BYTES,
  MAX_COMMIT_BYTES,
  MAX_COMMIT_MARKERS,
  generationEnvelopeFileName,
  generationCommitFileName,
  selectCommittedKeyGeneration,
};
