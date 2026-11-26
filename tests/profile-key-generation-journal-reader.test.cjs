'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PROFILE_CRYPTO_FORMAT } = require('../electron/profile-crypto.cjs');
const { generationEnvelopeFileName, generationCommitFileName } = require('../electron/profile-key-generation-journal.cjs');
const { readKeyGenerationJournal, MAX_TOTAL_BYTES, MAX_DIRECTORY_ENTRIES } = require('../electron/profile-key-generation-journal-reader.cjs');

const PROFILE_ID = 'd9d6f0e1-5b2d-4e21-9e72-0cce0d8c7a10';

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function makeEnvelope(marker = 1) {
  return {
    format: 'nexfix-pos-key-envelope',
    version: 1,
    profileId: PROFILE_ID,
    osWrappedKey: {
      format: PROFILE_CRYPTO_FORMAT,
      version: 1,
      provider: 'electron-safeStorage',
      profileId: PROFILE_ID,
      ciphertext: Buffer.alloc(16, marker).toString('base64'),
    },
    recoveryWrappedKey: {
      format: PROFILE_CRYPTO_FORMAT,
      version: 1,
      algorithm: 'AES-256-GCM',
      profileId: PROFILE_ID,
      iv: Buffer.alloc(12, marker).toString('base64'),
      ciphertext: Buffer.alloc(32, marker).toString('base64'),
      tag: Buffer.alloc(16, marker).toString('base64'),
    },
    updatedAt: '2026-11-26T00:00:00.000Z',
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-key-journal-reader-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeExclusive(filePath, bytes) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeLegacy(directory) {
  const bytes = encode(makeEnvelope(1));
  writeExclusive(path.join(directory, 'nexfix-key-envelope.json'), bytes);
  return bytes;
}

function writeGeneration(directory, generation, previousCommitSha256, operationIdSuffix) {
  const envelopeBytes = encode(makeEnvelope(generation + 1));
  const envelopeFileName = generationEnvelopeFileName(generation);
  writeExclusive(path.join(directory, envelopeFileName), envelopeBytes);

  const marker = {
    format: 'nexfix-pos-key-envelope-commit',
    version: 1,
    profileId: PROFILE_ID,
    generation,
    envelopeFileName,
    envelopeSha256: hash(envelopeBytes),
    previousCommitSha256,
    operationId: `00000000-0000-4000-8000-${String(operationIdSuffix).padStart(12, '0')}`,
    createdAt: '2026-11-26T00:00:00.000Z',
  };
  const markerBytes = encode(marker);
  const finalName = generationCommitFileName(generation);
  const tempName = `.nexfix-key-envelope.commit.g${String(generation).padStart(8, '0')}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  writeExclusive(path.join(directory, tempName), markerBytes);
  fs.renameSync(path.join(directory, tempName), path.join(directory, finalName));
  return hash(markerBytes);
}

test('reads the legacy envelope and ignores an orphan generation file and hidden temp marker', (t) => {
  const directory = temporaryDirectory(t);
  const legacy = writeLegacy(directory);
  writeExclusive(path.join(directory, generationEnvelopeFileName(1)), encode(makeEnvelope(2)));
  writeExclusive(path.join(directory, '.nexfix-key-envelope.commit.g00000001.partial.tmp'), Buffer.from('{broken'));

  const selected = readKeyGenerationJournal(directory, PROFILE_ID);
  assert.equal(selected.generation, 0);
  assert.equal(selected.isLegacy, true);
  assert.equal(selected.envelopeSha256, hash(legacy));
});

test('reads a final marker and matching envelope to select a committed generation', (t) => {
  const directory = temporaryDirectory(t);
  const legacy = writeLegacy(directory);
  writeGeneration(directory, 1, hash(legacy), 1);

  const selected = readKeyGenerationJournal(directory, PROFILE_ID);
  assert.equal(selected.generation, 1);
  assert.equal(selected.isLegacy, false);
  assert.equal(selected.envelopeFileName, generationEnvelopeFileName(1));
});

test('loads all committed generations so the selector can verify the entire hash chain', (t) => {
  const directory = temporaryDirectory(t);
  const legacy = writeLegacy(directory);
  const firstHash = writeGeneration(directory, 1, hash(legacy), 1);
  writeGeneration(directory, 2, firstHash, 2);

  const selected = readKeyGenerationJournal(directory, PROFILE_ID);
  assert.equal(selected.generation, 2);
  assert.equal(selected.operationId, '00000000-0000-4000-8000-000000000002');
});

test('fails closed when a final marker is present but its envelope file is missing', (t) => {
  const directory = temporaryDirectory(t);
  const legacy = writeLegacy(directory);
  const markerBytes = encode({
    format: 'nexfix-pos-key-envelope-commit',
    version: 1,
    profileId: PROFILE_ID,
    generation: 1,
    envelopeFileName: generationEnvelopeFileName(1),
    envelopeSha256: '0'.repeat(64),
    previousCommitSha256: hash(legacy),
    operationId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-11-26T00:00:00.000Z',
  });
  writeExclusive(path.join(directory, generationCommitFileName(1)), markerBytes);
  assert.throws(() => readKeyGenerationJournal(directory, PROFILE_ID), /Committed Recovery Key envelope is missing/);
});

test('rejects case-variant final marker names instead of falling back to the legacy envelope', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  const nonCanonicalName = generationCommitFileName(1).toUpperCase();
  writeExclusive(path.join(directory, nonCanonicalName), Buffer.from('{}'));
  assert.throws(
    () => readKeyGenerationJournal(directory, PROFILE_ID),
    /non-canonical commit marker filename/,
  );
});

test('rejects malformed final-marker-like filenames instead of silently ignoring them', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  writeExclusive(path.join(directory, 'nexfix-key-envelope.commit.g1.json'), Buffer.from('{}'));
  assert.throws(() => readKeyGenerationJournal(directory, PROFILE_ID), /non-canonical commit marker filename/);
});

test('rejects empty, oversized and non-regular final marker files', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  const marker = path.join(directory, generationCommitFileName(1));
  fs.writeFileSync(marker, Buffer.alloc(4 * 1024 + 1, 0x7b));
  assert.throws(() => readKeyGenerationJournal(directory, PROFILE_ID), /exceeds its allowed size or is empty/);
});

test('rejects a missing legacy envelope and an invalid profile directory', (t) => {
  const directory = temporaryDirectory(t);
  assert.throws(() => readKeyGenerationJournal(directory, PROFILE_ID), /Legacy POS profile key envelope is missing/);
  assert.throws(() => readKeyGenerationJournal(path.join(directory, 'missing'), PROFILE_ID), /directory is unavailable/);
  assert.throws(() => readKeyGenerationJournal('relative-profile-path', PROFILE_ID), /absolute POS profile directory/);
});

test('caps the number of final commit markers before opening marker contents', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  for (let generation = 1; generation <= 1025; generation += 1) {
    const name = generationCommitFileName(generation);
    fs.writeFileSync(path.join(directory, name), Buffer.from('{}'));
  }
  assert.throws(() => readKeyGenerationJournal(directory, PROFILE_ID), /too many commit markers/);
});

test('rejects symbolic-link profile folders and envelope files where symlinks are supported', (t) => {
  if (process.platform === 'win32') return t.skip('Windows symlink creation may require elevated privileges.');
  const parent = temporaryDirectory(t);
  const realDirectory = path.join(parent, 'real');
  fs.mkdirSync(realDirectory);
  writeLegacy(realDirectory);
  const linkedDirectory = path.join(parent, 'linked');
  fs.symlinkSync(realDirectory, linkedDirectory, 'dir');
  assert.throws(() => readKeyGenerationJournal(linkedDirectory, PROFILE_ID), /real, non-symbolic-link folder/);

  const directory = temporaryDirectory(t);
  const outside = path.join(directory, 'outside.json');
  fs.writeFileSync(outside, encode(makeEnvelope()));
  fs.symlinkSync(outside, path.join(directory, 'nexfix-key-envelope.json'));
  assert.throws(() => readKeyGenerationJournal(directory, PROFILE_ID), /regular, non-symbolic-link file/);
});

const CHILD_SCRIPT = String.raw`
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const directory = process.argv[1];
const profileId = process.argv[2];
const phase = process.argv[3];
const format = 'nexfix-pos-profile-crypto';

function writeFlushed(filePath, bytes) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

const legacyPath = path.join(directory, 'nexfix-key-envelope.json');
const legacyBytes = fs.readFileSync(legacyPath);
const envelope = {
  format: 'nexfix-pos-key-envelope',
  version: 1,
  profileId,
  osWrappedKey: {
    format, version: 1, provider: 'electron-safeStorage', profileId,
    ciphertext: Buffer.alloc(16, 2).toString('base64'),
  },
  recoveryWrappedKey: {
    format, version: 1, algorithm: 'AES-256-GCM', profileId,
    iv: Buffer.alloc(12, 2).toString('base64'),
    ciphertext: Buffer.alloc(32, 2).toString('base64'),
    tag: Buffer.alloc(16, 2).toString('base64'),
  },
  updatedAt: '2026-11-26T00:00:00.000Z',
};
const envelopeBytes = Buffer.from(JSON.stringify(envelope));
const envelopeName = 'nexfix-key-envelope.g00000001.json';
const envelopeTemp = path.join(directory, '.nexfix-key-envelope.g00000001.tmp');
writeFlushed(envelopeTemp, envelopeBytes);
fs.renameSync(envelopeTemp, path.join(directory, envelopeName));

if (phase === 'after-envelope') process.exit(21);

const marker = {
  format: 'nexfix-pos-key-envelope-commit',
  version: 1,
  profileId,
  generation: 1,
  envelopeFileName: envelopeName,
  envelopeSha256: crypto.createHash('sha256').update(envelopeBytes).digest('hex'),
  previousCommitSha256: crypto.createHash('sha256').update(legacyBytes).digest('hex'),
  operationId: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-11-26T00:00:00.000Z',
};
const markerBytes = Buffer.from(JSON.stringify(marker));
const markerTemp = path.join(directory, '.nexfix-key-envelope.commit.g00000001.child.tmp');
if (phase === 'partial-marker') {
  writeFlushed(markerTemp, markerBytes.subarray(0, Math.floor(markerBytes.length / 2)));
  process.exit(22);
}
writeFlushed(markerTemp, markerBytes);
fs.renameSync(markerTemp, path.join(directory, 'nexfix-key-envelope.commit.g00000001.json'));
process.exit(23);
`;

test('selects the old generation after a child process exits before the commit marker is published', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  const child = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, directory, PROFILE_ID, 'after-envelope'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(child.status, 21, child.stderr);
  const selected = readKeyGenerationJournal(directory, PROFILE_ID);
  assert.equal(selected.generation, 0);
});

test('selects the old generation when a child process leaves only a partial hidden marker temp file', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  const child = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, directory, PROFILE_ID, 'partial-marker'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(child.status, 22, child.stderr);
  const selected = readKeyGenerationJournal(directory, PROFILE_ID);
  assert.equal(selected.generation, 0);
});

test('selects the new generation after a child process exits after final commit marker publication', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  const child = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, directory, PROFILE_ID, 'after-marker'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(child.status, 23, child.stderr);
  const selected = readKeyGenerationJournal(directory, PROFILE_ID);
  assert.equal(selected.generation, 1);
});


test('bounds directory enumeration and closes the directory handle when the limit is exceeded', (t) => {
  const directory = temporaryDirectory(t);
  let readCount = 0;
  let closed = false;
  const fsApi = {
    lstatSync: fs.lstatSync.bind(fs),
    realpathSync: fs.realpathSync.bind(fs),
    opendirSync: () => ({
      readSync: () => {
        readCount += 1;
        return { name: 'flood-entry-' + readCount };
      },
      closeSync: () => { closed = true; },
    }),
  };

  assert.throws(
    () => readKeyGenerationJournal(directory, PROFILE_ID, { fsApi }),
    /too many entries/,
  );
  assert.equal(readCount, MAX_DIRECTORY_ENTRIES + 1);
  assert.equal(closed, true);
});

test('rejects a profile directory whose metadata changes during the read snapshot', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  const canonicalDirectory = fs.realpathSync(directory);
  const originalLstat = fs.lstatSync.bind(fs);
  let canonicalChecks = 0;
  const changeOnCheck = directory === canonicalDirectory ? 3 : 2;
  const fsApi = {
    lstatSync: (filePath) => {
      const stat = originalLstat(filePath);
      if (filePath === canonicalDirectory) {
        canonicalChecks += 1;
        if (canonicalChecks === changeOnCheck) {
          return new Proxy(stat, {
            get(target, key) {
              if (key === 'mtimeMs') return target.mtimeMs + 1;
              return Reflect.get(target, key, target);
            },
          });
        }
      }
      return stat;
    },
    realpathSync: fs.realpathSync.bind(fs),
    opendirSync: fs.opendirSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    fstatSync: fs.fstatSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    closeSync: fs.closeSync.bind(fs),
  };

  assert.throws(
    () => readKeyGenerationJournal(directory, PROFILE_ID, { fsApi }),
    /changed while it was being read/,
  );
  assert.equal(canonicalChecks, changeOnCheck);
});


test('rejects a file handle that resolves to a different object than the lstat snapshot', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  const legacyPath = path.join(directory, 'nexfix-key-envelope.json');
  const alternatePath = path.join(directory, 'alternate-envelope.json');
  writeExclusive(alternatePath, encode(makeEnvelope(9)));
  let closed = 0;
  let pathReadAttempted = false;
  const fsApi = {
    lstatSync: fs.lstatSync.bind(fs),
    realpathSync: fs.realpathSync.bind(fs),
    opendirSync: fs.opendirSync.bind(fs),
    openSync: (filePath, flags) => fs.openSync(filePath === legacyPath ? alternatePath : filePath, flags),
    fstatSync: fs.fstatSync.bind(fs),
    readFileSync: (source, ...args) => {
      if (source === legacyPath) pathReadAttempted = true;
      return fs.readFileSync(source, ...args);
    },
    closeSync: (descriptor) => {
      closed += 1;
      return fs.closeSync(descriptor);
    },
  };

  assert.throws(
    () => readKeyGenerationJournal(directory, PROFILE_ID, { fsApi }),
    /changed while it was being read/,
  );
  assert.equal(pathReadAttempted, false);
  assert.equal(closed, 1);
});

test('reads through an opened handle and rejects a pathname replacement after the handle was opened', (t) => {
  const directory = temporaryDirectory(t);
  writeLegacy(directory);
  const legacyPath = path.join(directory, 'nexfix-key-envelope.json');
  const alternatePath = path.join(directory, 'alternate-envelope.json');
  writeExclusive(alternatePath, encode(makeEnvelope(10)));
  const originalLstat = fs.lstatSync.bind(fs);
  let legacyPathChecks = 0;
  let handleReads = 0;
  let closed = 0;
  const fsApi = {
    lstatSync: (filePath) => {
      if (filePath === legacyPath) {
        legacyPathChecks += 1;
        if (legacyPathChecks > 1) return originalLstat(alternatePath);
      }
      return originalLstat(filePath);
    },
    realpathSync: fs.realpathSync.bind(fs),
    opendirSync: fs.opendirSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    fstatSync: fs.fstatSync.bind(fs),
    readFileSync: (source, ...args) => {
      if (typeof source === 'number') handleReads += 1;
      return fs.readFileSync(source, ...args);
    },
    closeSync: (descriptor) => {
      closed += 1;
      return fs.closeSync(descriptor);
    },
  };

  assert.throws(
    () => readKeyGenerationJournal(directory, PROFILE_ID, { fsApi }),
    /changed while it was being read/,
  );
  assert.equal(handleReads, 1);
  assert.equal(legacyPathChecks, 2);
  assert.equal(closed, 1);
});
