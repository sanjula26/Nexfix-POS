'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  KEY_ENVELOPE_FILE,
  createInitialProfileKeyEnvelope,
  persistNewProfileKeyEnvelope,
  readProfileKeyEnvelope,
  validateProfileKeyEnvelope,
  changeProfileLockPassphrase,
  resetProfileLockPassphraseWithRecoveryKey,
  rebindProfileDeviceKeyWithRecoveryKey,
  prepareProfileRecoveryKeyRotation,
  finalizeProfileRecoveryKeyRotation,
} = require('../electron/profile-key-store.cjs');
const {
  unwrapDataKeyWithRecoveryKey,
  unwrapDataKeyWithPassphrase,
  unwrapDataKeyWithOS,
} = require('../electron/profile-crypto.cjs');

const PROFILE_ID = 'd9d6f0e1-5b2d-4e21-9e72-0cce0d8c7a10';
const PASSPHRASE = 'Nexfix-Owner-Lock-2026';

function makeSafeStorage() {
  return {
    getSelectedStorageBackend: () => 'dpapi',
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from('mock-dpapi:' + value, 'utf8'),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('mock-dpapi:')) throw new Error('bad mock wrapper');
      return text.slice('mock-dpapi:'.length);
    },
  };
}


function makeDeviceSafeStorage(prefix) {
  return {
    getSelectedStorageBackend: () => 'dpapi',
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(prefix + value, 'utf8'),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith(prefix)) throw new Error('wrong device wrapper');
      return text.slice(prefix.length);
    },
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-key-envelope-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('creates a portable recovery, device and passphrase key envelope without storing raw keys', async () => {
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  assert.equal(validateProfileKeyEnvelope(created.envelope, PROFILE_ID).valid, true);
  const serialized = JSON.stringify(created.envelope);
  assert.equal(serialized.includes(created.recoveryKey), false);
  assert.equal(serialized.includes('dataKey'), false);

  const fromRecovery = unwrapDataKeyWithRecoveryKey(
    created.envelope.recoveryWrappedKey, created.recoveryKey, PROFILE_ID,
  );
  const fromPassphrase = await unwrapDataKeyWithPassphrase(
    created.envelope.passphraseWrappedKey, PASSPHRASE, PROFILE_ID,
  );
  const fromDevice = await unwrapDataKeyWithOS(
    created.envelope.osWrappedKey, PROFILE_ID, makeSafeStorage(),
  );
  assert.deepEqual(fromRecovery, fromPassphrase);
  assert.deepEqual(fromRecovery, fromDevice);
  fromRecovery.fill(0);
  fromPassphrase.fill(0);
  fromDevice.fill(0);
});

test('persists and reads back a key envelope without overwriting an existing one', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  const saved = persistNewProfileKeyEnvelope(directory, created.envelope);
  assert.deepEqual(saved, readProfileKeyEnvelope(directory, PROFILE_ID));
  assert.equal(fs.existsSync(path.join(directory, KEY_ENVELOPE_FILE)), true);
  assert.throws(() => persistNewProfileKeyEnvelope(directory, created.envelope));
});

test('rejects tampered envelopes, wrong profile IDs and symlinked key files', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  const tampered = structuredClone(created.envelope);
  tampered.recoveryWrappedKey.ciphertext = Buffer.alloc(32, 1).toString('base64');
  assert.equal(validateProfileKeyEnvelope(tampered, PROFILE_ID).valid, true);
  assert.throws(() => unwrapDataKeyWithRecoveryKey(
    tampered.recoveryWrappedKey, created.recoveryKey, PROFILE_ID,
  ), /authentication failed/);
  assert.equal(validateProfileKeyEnvelope(created.envelope, '4d6b9d1f-4f21-4a21-9b4a-3d3c7f0e1a22').valid, false);
  const withSecret = structuredClone(created.envelope);
  withSecret.recoveryWrappedKey.rawRecoveryKey = created.recoveryKey;
  assert.equal(validateProfileKeyEnvelope(withSecret, PROFILE_ID).valid, false);

  if (process.platform !== 'win32') {
    const outside = path.join(directory, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(created.envelope));
    fs.symlinkSync(outside, path.join(directory, KEY_ENVELOPE_FILE));
    assert.throws(() => readProfileKeyEnvelope(directory, PROFILE_ID), /symbolic link/);
  }
});

test('changes the folder-lock passphrase without changing the profile data key', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  persistNewProfileKeyEnvelope(directory, created.envelope);
  const before = unwrapDataKeyWithRecoveryKey(created.envelope.recoveryWrappedKey, created.recoveryKey, PROFILE_ID);

  await assert.rejects(
    changeProfileLockPassphrase(directory, PROFILE_ID, 'Wrong-Owner-Lock-2026', 'Nexfix-New-Lock-2026'),
    /authentication failed/,
  );
  const updated = await changeProfileLockPassphrase(directory, PROFILE_ID, PASSPHRASE, 'Nexfix-New-Lock-2026');
  assert.equal(updated.updatedAt > created.envelope.updatedAt, true);
  await assert.rejects(
    unwrapDataKeyWithPassphrase(updated.passphraseWrappedKey, PASSPHRASE, PROFILE_ID),
    /authentication failed/,
  );
  const after = await unwrapDataKeyWithPassphrase(updated.passphraseWrappedKey, 'Nexfix-New-Lock-2026', PROFILE_ID);
  assert.deepEqual(after, before);
  before.fill(0);
  after.fill(0);
});

test('resets a forgotten folder-lock passphrase with the portable recovery key', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  persistNewProfileKeyEnvelope(directory, created.envelope);
  const updated = await resetProfileLockPassphraseWithRecoveryKey(
    directory, PROFILE_ID, created.recoveryKey, 'Nexfix-Recovered-Lock-2026',
  );
  const recovered = await unwrapDataKeyWithPassphrase(
    updated.passphraseWrappedKey, 'Nexfix-Recovered-Lock-2026', PROFILE_ID,
  );
  const original = unwrapDataKeyWithRecoveryKey(
    updated.recoveryWrappedKey, created.recoveryKey, PROFILE_ID,
  );
  assert.deepEqual(recovered, original);
  recovered.fill(0);
  original.fill(0);
});

test('rebinds the device-specific wrapper after Windows reinstall using the recovery key', async (t) => {
  const directory = temporaryDirectory(t);
  const oldDevice = makeDeviceSafeStorage('old-windows-install:');
  const newDevice = makeDeviceSafeStorage('new-windows-install:');
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, oldDevice, PASSPHRASE);
  persistNewProfileKeyEnvelope(directory, created.envelope);

  const before = readProfileKeyEnvelope(directory, PROFILE_ID);
  await assert.rejects(
    rebindProfileDeviceKeyWithRecoveryKey(directory, PROFILE_ID, 'invalid-recovery-key', newDevice),
  );
  assert.deepEqual(readProfileKeyEnvelope(directory, PROFILE_ID), before);

  const rebound = await rebindProfileDeviceKeyWithRecoveryKey(
    directory, PROFILE_ID, created.recoveryKey, newDevice,
  );
  assert.notEqual(rebound.osWrappedKey.ciphertext, before.osWrappedKey.ciphertext);
  await assert.rejects(
    unwrapDataKeyWithOS(rebound.osWrappedKey, PROFILE_ID, oldDevice),
    /cannot unlock/,
  );
  const newDeviceKey = await unwrapDataKeyWithOS(rebound.osWrappedKey, PROFILE_ID, newDevice);
  const recoveryKeyData = unwrapDataKeyWithRecoveryKey(rebound.recoveryWrappedKey, created.recoveryKey, PROFILE_ID);
  const passphraseData = await unwrapDataKeyWithPassphrase(rebound.passphraseWrappedKey, PASSPHRASE, PROFILE_ID);
  assert.deepEqual(newDeviceKey, recoveryKeyData);
  assert.deepEqual(newDeviceKey, passphraseData);
  newDeviceKey.fill(0);
  recoveryKeyData.fill(0);
  passphraseData.fill(0);
});


test('prepares a replacement recovery key without changing the on-disk envelope', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  persistNewProfileKeyEnvelope(directory, created.envelope);
  const file = path.join(directory, KEY_ENVELOPE_FILE);
  const beforeBytes = fs.readFileSync(file);
  const pending = prepareProfileRecoveryKeyRotation(directory, PROFILE_ID, created.recoveryKey);
  assert.deepEqual(fs.readFileSync(file), beforeBytes);
  const unchanged = readProfileKeyEnvelope(directory, PROFILE_ID);
  const oldKeyData = unwrapDataKeyWithRecoveryKey(unchanged.recoveryWrappedKey, created.recoveryKey, PROFILE_ID);
  const pendingKeyData = unwrapDataKeyWithRecoveryKey(pending.recoveryWrappedKey, pending.recoveryKey, PROFILE_ID);
  assert.deepEqual(pendingKeyData, oldKeyData);
  assert.deepEqual(pending.dataKey, oldKeyData);
  assert.notEqual(pending.recoveryKey, created.recoveryKey);
  oldKeyData.fill(0);
  pendingKeyData.fill(0);
  pending.dataKey.fill(0);
});

test('rejects wrong old recovery key without changing the envelope', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  persistNewProfileKeyEnvelope(directory, created.envelope);
  const file = path.join(directory, KEY_ENVELOPE_FILE);
  const beforeBytes = fs.readFileSync(file);
  const wrongButWellFormedKey = (created.recoveryKey[0] === 'A' ? 'B' : 'A') +
    created.recoveryKey.slice(1);
  assert.equal(wrongButWellFormedKey.length, created.recoveryKey.length);
  assert.throws(
    () => prepareProfileRecoveryKeyRotation(directory, PROFILE_ID, wrongButWellFormedKey),
    /authentication failed/,
  );
  assert.deepEqual(fs.readFileSync(file), beforeBytes);
});

test('finalizes recovery-key rotation with envelope CAS and preserves other wrappers', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  persistNewProfileKeyEnvelope(directory, created.envelope);
  const pending = prepareProfileRecoveryKeyRotation(directory, PROFILE_ID, created.recoveryKey);
  const saved = finalizeProfileRecoveryKeyRotation(directory, pending);
  assert.deepEqual(saved.osWrappedKey, created.envelope.osWrappedKey);
  assert.deepEqual(saved.passphraseWrappedKey, created.envelope.passphraseWrappedKey);
  const newKeyData = unwrapDataKeyWithRecoveryKey(saved.recoveryWrappedKey, pending.recoveryKey, PROFILE_ID);
  const passphraseData = await unwrapDataKeyWithPassphrase(saved.passphraseWrappedKey, PASSPHRASE, PROFILE_ID);
  const deviceData = await unwrapDataKeyWithOS(saved.osWrappedKey, PROFILE_ID, makeSafeStorage());
  assert.deepEqual(newKeyData, pending.dataKey);
  assert.deepEqual(passphraseData, pending.dataKey);
  assert.deepEqual(deviceData, pending.dataKey);
  assert.throws(
    () => unwrapDataKeyWithRecoveryKey(saved.recoveryWrappedKey, created.recoveryKey, PROFILE_ID),
    /authentication failed/,
  );
  newKeyData.fill(0);
  passphraseData.fill(0);
  deviceData.fill(0);
  pending.dataKey.fill(0);
});

test('refuses finalization when the envelope changes after rotation preparation', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  persistNewProfileKeyEnvelope(directory, created.envelope);
  const pending = prepareProfileRecoveryKeyRotation(directory, PROFILE_ID, created.recoveryKey);
  const changed = {
    ...readProfileKeyEnvelope(directory, PROFILE_ID),
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  };
  fs.writeFileSync(path.join(directory, KEY_ENVELOPE_FILE), JSON.stringify(changed, null, 2) + '\n', 'utf8');
  const beforeFinalize = fs.readFileSync(path.join(directory, KEY_ENVELOPE_FILE));
  assert.throws(
    () => finalizeProfileRecoveryKeyRotation(directory, pending),
    /envelope changed during Recovery Key rotation/,
  );
  assert.deepEqual(fs.readFileSync(path.join(directory, KEY_ENVELOPE_FILE)), beforeFinalize);
  const stillOld = unwrapDataKeyWithRecoveryKey(
    readProfileKeyEnvelope(directory, PROFILE_ID).recoveryWrappedKey,
    created.recoveryKey,
    PROFILE_ID,
  );
  stillOld.fill(0);
  pending.dataKey.fill(0);
});

test('retries an already-applied Recovery Key rotation idempotently after a lost response', async (t) => {
  const directory = temporaryDirectory(t);
  const created = await createInitialProfileKeyEnvelope(PROFILE_ID, makeSafeStorage(), PASSPHRASE);
  persistNewProfileKeyEnvelope(directory, created.envelope);
  const pending = prepareProfileRecoveryKeyRotation(directory, PROFILE_ID, created.recoveryKey);

  const first = finalizeProfileRecoveryKeyRotation(directory, pending);
  const bytesAfterFirstFinalize = fs.readFileSync(path.join(directory, KEY_ENVELOPE_FILE));
  const retried = finalizeProfileRecoveryKeyRotation(directory, pending);

  assert.deepEqual(retried, first);
  assert.deepEqual(fs.readFileSync(path.join(directory, KEY_ENVELOPE_FILE)), bytesAfterFirstFinalize);
  const recovered = unwrapDataKeyWithRecoveryKey(retried.recoveryWrappedKey, pending.recoveryKey, PROFILE_ID);
  assert.deepEqual(recovered, pending.dataKey);
  assert.throws(
    () => unwrapDataKeyWithRecoveryKey(retried.recoveryWrappedKey, created.recoveryKey, PROFILE_ID),
    /authentication failed/,
  );
  recovered.fill(0);
  pending.dataKey.fill(0);
});
