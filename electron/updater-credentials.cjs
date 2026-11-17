function normalizeUpdaterDeviceCredential(payload) {
  const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
  const deviceId = typeof payload?.deviceId === 'string' ? payload.deviceId.trim() : '';
  if (!token || token.length < 64 || token.length > 512 || !deviceId || deviceId.length > 200) return null;
  return { token, deviceId };
}

function parseStoredUpdaterDeviceCredential(value) {
  const decrypted = typeof value === 'string' ? value.trim() : '';
  if (!decrypted) return null;
  let token = '';
  let deviceId = '';
  try {
    const parsed = JSON.parse(decrypted);
    token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    deviceId = typeof parsed?.deviceId === 'string' ? parsed.deviceId.trim() : '';
  } catch {
    // Legacy v3.0.1279 records stored only the token. The renderer can supply
    // the current device ID during explicit re-authorization.
    token = decrypted;
  }
  if (!token || token.length < 64 || token.length > 512 || deviceId.length > 200) return null;
  return { token, deviceId };
}

function buildUpdaterRequestHeaders(token, deviceId, mode = 'bearer') {
  if (typeof token !== 'string' || !token || typeof deviceId !== 'string' || !deviceId) return null;
  return {
    ...(mode === 'device'
      ? { 'X-Nexfix-Update-Token': token }
      : { Authorization: `Bearer ${token}` }),
    'X-Nexfix-Device': deviceId,
    'Cache-Control': 'no-cache',
  };
}

function saveEncryptedUpdaterCredential(payload, safeStorage, currentRecord = {}) {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS secure storage is unavailable' };
  }
  const credential = normalizeUpdaterDeviceCredential(payload);
  if (!credential) return { ok: false, error: 'Invalid Windows updater authorization token' };
  try {
    const encrypted = safeStorage.encryptString(JSON.stringify(credential)).toString('base64');
    return {
      ok: true,
      record: { ...currentRecord, cloudUpdaterDeviceToken: encrypted, cloudUpdaterDeviceTokenVersion: 1, version: 2 },
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function loadEncryptedUpdaterCredential(record, safeStorage) {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS secure storage is unavailable' };
  }
  try {
    const encrypted = record?.cloudUpdaterDeviceToken;
    if (typeof encrypted !== 'string' || !encrypted) return { ok: true, found: false };
    const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64')).trim();
    const credential = parseStoredUpdaterDeviceCredential(decrypted);
    if (!credential) return { ok: true, found: false };
    return { ok: true, found: true, ...credential };
  } catch {
    return { ok: false, error: 'Stored Windows updater authorization could not be opened' };
  }
}

function clearEncryptedUpdaterCredential(record = {}) {
  const next = { ...record };
  delete next.cloudUpdaterDeviceToken;
  delete next.cloudUpdaterDeviceTokenVersion;
  return next;
}

module.exports = {
  normalizeUpdaterDeviceCredential,
  parseStoredUpdaterDeviceCredential,
  buildUpdaterRequestHeaders,
  saveEncryptedUpdaterCredential,
  loadEncryptedUpdaterCredential,
  clearEncryptedUpdaterCredential,
};
