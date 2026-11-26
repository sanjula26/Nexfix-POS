'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  LEGACY_ENVELOPE_FILE,
  MAX_COMMIT_MARKERS,
  generationEnvelopeFileName,
  generationCommitFileName,
  selectCommittedKeyGeneration,
} = require('../electron/profile-key-generation-journal.cjs');

const PROFILE_ID = 'd9d6f0e1-5b2d-4e21-9e72-0cce0d8c7a10';
const VALID_OPERATION_ID = '00000000-0000-4000-8000-000000000001';

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function makeEnvelope(profileId, generation) {
  return {
    format: 'nexfix-pos-key-envelope',
    version: 1,
    profileId,
    generationHint: generation,
  };
}

function validateEnvelope(envelope, expectedProfileId) {
  return {
    valid: envelope?.profileId === expectedProfileId &&
      envelope.format === 'nexfix-pos-key-envelope' &&
      envelope.version === 1,
    envelope,
  };
}

function makeLegacy() {
  const envelope = makeEnvelope(PROFILE_ID, 0);
  return { envelope, bytes: encode(envelope) };
}

function makeRecord(generation, previousCommitSha256, overrides = {}) {
  const envelope = makeEnvelope(PROFILE_ID, generation);
  const envelopeBytes = encode(envelope);
  const marker = {
    format: 'nexfix-pos-key-envelope-commit',
    version: 1,
    profileId: PROFILE_ID,
    generation,
    envelopeFileName: generationEnvelopeFileName(generation),
    envelopeSha256: hash(envelopeBytes),
    previousCommitSha256,
    operationId: VALID_OPERATION_ID,
    createdAt: '2026-11-26T00:00:00.000Z',
    ...overrides,
  };
  return {
    markerFileName: generationCommitFileName(generation),
    markerBytes: encode(marker),
    envelopeFileName: marker.envelopeFileName,
    envelopeBytes,
  };
}

function select(legacy, records) {
  return selectCommittedKeyGeneration({
    profileId: PROFILE_ID,
    legacyEnvelopeBytes: legacy.bytes,
    commitRecords: records,
    validateEnvelope,
  });
}

test('selects legacy generation zero when no final commit marker exists', () => {
  const legacy = makeLegacy();
  const selected = select(legacy, []);

  assert.equal(selected.generation, 0);
  assert.equal(selected.isLegacy, true);
  assert.equal(selected.envelopeFileName, LEGACY_ENVELOPE_FILE);
  assert.equal(selected.envelope.generationHint, 0);
  assert.equal(selected.operationId, null);
});

test('selects the highest consecutive committed generation in a valid hash chain', () => {
  const legacy = makeLegacy();
  const first = makeRecord(1, hash(legacy.bytes));
  const second = makeRecord(2, hash(first.markerBytes));

  const selected = select(legacy, [second, first]);

  assert.equal(selected.generation, 2);
  assert.equal(selected.isLegacy, false);
  assert.equal(selected.envelopeFileName, generationEnvelopeFileName(2));
  assert.equal(selected.envelope.generationHint, 2);
  assert.equal(selected.commitMarkerFileName, generationCommitFileName(2));
  assert.equal(selected.operationId, VALID_OPERATION_ID);
});

test('treats an envelope without a final marker as uncommitted legacy data', () => {
  const legacy = makeLegacy();
  const orphanEnvelopeBytes = encode(makeEnvelope(PROFILE_ID, 1));

  // The filesystem adapter supplies only final commit markers. An orphan
  // generation file is intentionally absent from commitRecords.
  assert.ok(orphanEnvelopeBytes.length > 0);
  const selected = select(legacy, []);

  assert.equal(selected.generation, 0);
  assert.equal(selected.envelope.generationHint, 0);
});

test('fails closed when a committed generation number is skipped', () => {
  const legacy = makeLegacy();
  const second = makeRecord(2, hash(legacy.bytes));

  assert.throws(() => select(legacy, [second]), /missing generation 1/);
});

test('fails closed when commit markers are duplicated or not consecutive', () => {
  const legacy = makeLegacy();
  const first = makeRecord(1, hash(legacy.bytes));

  assert.throws(() => select(legacy, [first, first]), /duplicated or incomplete/);
});

test('fails closed when the marker hash chain does not match the previous marker', () => {
  const legacy = makeLegacy();
  const first = makeRecord(1, '0'.repeat(64));

  assert.throws(() => select(legacy, [first]), /identity, chain or fields are invalid/);
});

test('fails closed when committed envelope bytes do not match the marker hash', () => {
  const legacy = makeLegacy();
  const first = makeRecord(1, hash(legacy.bytes));
  first.envelopeBytes = encode(makeEnvelope(PROFILE_ID, 9));

  assert.throws(() => select(legacy, [first]), /hash does not match/);
});

test('fails closed when an envelope validator rejects the committed envelope', () => {
  const legacy = makeLegacy();
  const first = makeRecord(1, hash(legacy.bytes));
  const selected = () => selectCommittedKeyGeneration({
    profileId: PROFILE_ID,
    legacyEnvelopeBytes: legacy.bytes,
    commitRecords: [first],
    validateEnvelope: () => ({ valid: false }),
  });

  assert.throws(selected, /failed structural validation/);
});

test('rejects wrong profile IDs, non-canonical filenames and marker path traversal', () => {
  const legacy = makeLegacy();
  const first = makeRecord(1, hash(legacy.bytes));

  assert.throws(
    () => selectCommittedKeyGeneration({
      profileId: 'd9d6f0e1-5b2d-4e21-9e72-0cce0d8c7a10',
      legacyEnvelopeBytes: legacy.bytes,
      commitRecords: [{ ...first, markerFileName: '../commit.json' }],
      validateEnvelope,
    }),
    /filename is invalid/,
  );

  const wrongProfileMarker = makeRecord(1, hash(legacy.bytes), {
    profileId: '4d6b9d1f-4f21-4a21-9b4a-3d3c7f0e1a22',
  });
  assert.throws(() => select(legacy, [wrongProfileMarker]), /identity, chain or fields are invalid/);
});

test('rejects malformed marker JSON, unknown marker fields and invalid timestamps', () => {
  const legacy = makeLegacy();
  const first = makeRecord(1, hash(legacy.bytes));
  assert.throws(
    () => select(legacy, [{ ...first, markerBytes: Buffer.from('{broken') }]),
    /not valid JSON/,
  );

  const withExtra = makeRecord(1, hash(legacy.bytes), { injected: true });
  assert.throws(() => select(legacy, [withExtra]), /unsupported fields/);

  const badTime = makeRecord(1, hash(legacy.bytes), { createdAt: 'not-a-time' });
  assert.throws(() => select(legacy, [badTime]), /identity, chain or fields are invalid/);
});

test('rejects missing envelope bytes and oversized journal input', () => {
  const legacy = makeLegacy();
  const first = makeRecord(1, hash(legacy.bytes));
  assert.throws(
    () => select(legacy, [{ ...first, envelopeBytes: undefined }]),
    /must be a byte buffer/,
  );
  assert.throws(
    () => selectCommittedKeyGeneration({
      profileId: PROFILE_ID,
      legacyEnvelopeBytes: legacy.bytes,
      commitRecords: new Array(MAX_COMMIT_MARKERS + 1).fill(first),
      validateEnvelope,
    }),
    /too many commit markers/,
  );
});
