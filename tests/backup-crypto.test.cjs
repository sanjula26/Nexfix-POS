const assert = require('node:assert/strict');
const test = require('node:test');
const { webcrypto } = require('node:crypto');

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const values = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  },
});

let backupCrypto;
async function loadBackupCrypto() {
  if (!backupCrypto) backupCrypto = await import('../src/lib/backupCrypto.ts');
  return backupCrypto;
}

test('encrypted Drive backup round-trips with its shop Recovery Key', async () => {
  const { encryptBackupState, decryptBackupEnvelope, isEncryptedBackupEnvelope, getRecoveryKey } = await loadBackupCrypto();
  const state = {
    shopName: 'Nexfix Test Shop',
    products: [{ id: 'p-1', name: 'Test device', description: 'සිංහල පරීක්ෂණය' }],
  };

  const envelope = await encryptBackupState(state, 'shop-crypto-a', 'manual', '2026-11-12T10:00:00.000Z');
  assert.equal(envelope.v, 2);
  assert.equal(isEncryptedBackupEnvelope(envelope), true);
  assert.ok(getRecoveryKey('shop-crypto-a'));
  assert.deepEqual(await decryptBackupEnvelope(envelope), state);
});

test('shop-scoped Recovery Keys cannot decrypt another shop backup', async () => {
  const { encryptBackupState, decryptBackupEnvelope, ensureRecoveryKey, getRecoveryKey } = await loadBackupCrypto();
  const envelope = await encryptBackupState(
    { products: [{ id: 'private-shop-a' }] },
    'shop-crypto-a',
    'auto',
    '2026-11-12T10:01:00.000Z',
  );
  const keyA = getRecoveryKey('shop-crypto-a');
  const keyB = ensureRecoveryKey('shop-crypto-b');
  assert.ok(keyA);
  assert.ok(keyB);
  assert.notEqual(keyA, keyB);

  const relabelled = { ...envelope, shopId: 'shop-crypto-b' };
  await assert.rejects(
    () => decryptBackupEnvelope(relabelled),
    /Recovery Key is wrong or the encrypted backup is corrupted/,
  );
});

test('tampered encrypted backup ciphertext fails closed', async () => {
  const { encryptBackupState, decryptBackupEnvelope } = await loadBackupCrypto();
  const envelope = await encryptBackupState(
    { sales: [{ id: 'sale-tamper-test' }] },
    'shop-crypto-tamper',
    'manual',
    '2026-11-12T10:02:00.000Z',
  );
  const first = envelope.ciphertext[0];
  const tampered = {
    ...envelope,
    ciphertext: (first === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1),
  };

  await assert.rejects(
    () => decryptBackupEnvelope(tampered),
    /Recovery Key is wrong or the encrypted backup is corrupted/,
  );
});

test('invalid Recovery Key input does not replace the saved shop key', async () => {
  const { ensureRecoveryKey, getRecoveryKey, setRecoveryKey } = await loadBackupCrypto();
  const original = ensureRecoveryKey('shop-crypto-key-check');
  const result = setRecoveryKey('not-a-valid-256-bit-key', 'shop-crypto-key-check');

  assert.equal(result.ok, false);
  assert.equal(getRecoveryKey('shop-crypto-key-check'), original);
});
