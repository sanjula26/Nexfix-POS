/**
 * Nexfix POS direct Google Drive backup API.
 * Deploy as a Web app: Execute as Me.
 * POS calls this endpoint directly; Supabase is not required for Google Backup.
 * The supplied master Drive folder remains separate from any Google Sheet.
 */
var BACKUP_SHEET = 'FullBackup';
var VERSION = '3.3.0';
var MAX_MULTIPART_PART_BYTES = 8 * 1024 * 1024;
var SHOP_ID_MAX_LENGTH = 100;
var REQUEST_ID_MAX_LENGTH = 200;
var MAX_BACKUP_BYTES = 9 * 1024 * 1024; // Keep below DriveApp File.setContent() 10 MB limit.
var BACKUP_RATE_LIMIT = 5;
var BACKUP_RATE_WINDOW_SECONDS = 5;
var ROOT_BACKUP_FOLDER_NAME = 'Nexfix POS Backup';
var ROOT_BACKUP_FOLDER_ID_PROPERTY = 'ROOT_BACKUP_FOLDER_ID';
var BACKUP_API_KEY_PROPERTY = 'NEXFIX_BACKUP_API_KEY';
var SHOP_AUTH_FILENAME = 'SHOP_AUTH.json';
// Default Nexfix master Drive folder supplied for this deployment.
// Script Properties can override this value without changing the code.
var DEFAULT_ROOT_BACKUP_FOLDER_ID = '1CQZ746hm3pTKOOx2BDVj3NEmTj82yEeK';
var DRIVE_BACKUP_SUBFOLDER_NAME = 'Backups';
var DRIVE_METADATA_FILENAME = 'shop.json';

var ALLOWED_DATA_TABLES = {
  'saleshistory': true,
  'products': true,
  'customers': true,
  'suppliers': true,
  'purchases': true,
  'expenses': true,
  'exchanges': true,
  'repairs': true,
  'units': true,
  'quotations': true,
  'warrantyclaims': true
};

function json(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function ok(extra) {
  var out = { ok: true, status: 'success', version: VERSION };
  if (extra) Object.keys(extra).forEach(function(k) { out[k] = extra[k]; });
  return out;
}

function fail(err) {
  var msg = 'Backup request failed';
  if (err && typeof err.message === 'string' && err.message.length > 0 && err.message.length < 240) {
    msg = err.message;
  } else if (typeof err === 'string' && err.length > 0 && err.length < 240) {
    msg = err;
  }
  var out = { ok: false, status: 'error', version: VERSION, message: msg };
  if (err && err.retryAfterSeconds) out.retryAfterSeconds = Number(err.retryAfterSeconds);
  return out;
}

function unauthorized(message) {
  return { ok: false, status: 'unauthorized', version: VERSION, message: message || 'Unauthorized' };
}
function getBackupApiKey() {
  var key = String(PropertiesService.getScriptProperties().getProperty(BACKUP_API_KEY_PROPERTY) || '').trim();
  if (!key) throw new Error('NEXFIX_BACKUP_API_KEY is not configured in Script Properties');
  return key;
}

function constantTimeApiKeyEqual(provided, expected) {
  var a = String(provided || '');
  var b = String(expected || '');
  var max = Math.max(a.length, b.length);
  var diff = a.length ^ b.length;
  for (var i = 0; i < max; i++) diff |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0);
  return diff === 0;
}

function requireBackupApiKey(provided) {
  var expected = getBackupApiKey();
  if (!constantTimeApiKeyEqual(provided, expected)) throw new Error('Unauthorized');
}


function validateShopProof(value) {
  var proof = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(proof)) throw new Error('Valid shop proof is required');
  return proof;
}

function shopAuthDigest(shopProof) {
  // The proof is derived from the shop recovery key and never sent in plaintext.
  // Store only its SHA-256 digest; transport-key rotation must not invalidate
  // existing shop authorization records.
  return sha256HexText(String(shopProof));
}

function findShopBackupFolder(shopId) {
  var root = getRootBackupFolder();
  var prefix = 'Shop_' + shopPartitionKey(shopId) + ' - ';
  var folders = root.getFolders();
  while (folders.hasNext()) {
    var folder = folders.next();
    if (folder.getName().indexOf(prefix) === 0) return folder;
  }
  return null;
}

function authorizeShopAccess(shopId, shopProof, allowInitialize) {
  var proof = validateShopProof(shopProof);
  var folder = findShopBackupFolder(shopId);
  if (!folder) {
    if (!allowInitialize) throw new Error('Shop backup authorization not initialized');
    folder = getShopBackupFolder(shopId, 'Shop', false);
  }

  var files = folder.getFilesByName(SHOP_AUTH_FILENAME);
  var expectedDigest = shopAuthDigest(proof);
  if (!files.hasNext()) {
    if (!allowInitialize) throw new Error('Shop backup authorization not initialized');
    var record = {
      app: 'Nexfix POS',
      version: VERSION,
      shopId: shopId,
      shopPartition: shopPartitionKey(shopId),
      proofDigest: expectedDigest,
      createdAt: new Date().toISOString()
    };
    folder.createFile(Utilities.newBlob(JSON.stringify(record, null, 2), 'application/json', SHOP_AUTH_FILENAME));
    return folder;
  }

  var raw = files.next().getBlob().getDataAsString();
  var record;
  try { record = JSON.parse(raw); } catch (ignore) { throw new Error('Shop backup authorization record is invalid'); }
  if (String(record.shopId || '') !== String(shopId)
      || String(record.shopPartition || '') !== shopPartitionKey(shopId)
      || !constantTimeApiKeyEqual(String(record.proofDigest || ''), expectedDigest)) {
    throw new Error('Shop backup authorization failed');
  }
  return folder;
}

function value(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : v;
}

function normalizeTableName(table) {
  return String(table || '').trim();
}

function isAllowedDataTable(table) {
  var normalized = normalizeTableName(table);
  return normalized && ALLOWED_DATA_TABLES[normalized.toLowerCase()] === true;
}

function normalizeShopId(shopId) {
  var value = String(shopId || '').trim();
  if (!value || value.length > SHOP_ID_MAX_LENGTH) throw new Error('Valid shopId is required');
  return value;
}

function validateRecoveryKey(value) {
  var key = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid Recovery Key');
  return key;
}

function validateEncryptedEnvelope(serialized, expectedShopId) {
  if (typeof serialized !== 'string' || !serialized) throw new Error('Encrypted backup payload is required');
  var bytes = Utilities.newBlob(serialized, 'application/json').getBytes().length;
  if (bytes > MAX_BACKUP_BYTES) throw new Error('Encrypted backup payload is too large for a single Drive file');
  var envelope;
  try { envelope = JSON.parse(serialized); } catch (err) { throw new Error('Encrypted backup payload is not valid JSON'); }
  var validV1 = envelope && envelope.v === 1 && envelope.alg === 'AES-256-GCM' && envelope.kdf === 'PBKDF2-SHA-256';
  var validV2 = envelope && envelope.v === 2 && envelope.alg === 'AES-256-GCM' && envelope.keyMode === 'random-recovery-key';
  if (!validV1 && !validV2) throw new Error('Unsupported encrypted backup envelope');
  if (typeof envelope.ciphertext !== 'string' || !envelope.ciphertext || typeof envelope.shopId !== 'string') throw new Error('Encrypted backup envelope is incomplete');
  if (validV1 && (Number(envelope.iterations) < 310000 || typeof envelope.salt !== 'string' || typeof envelope.iv !== 'string')) throw new Error('Encrypted backup KDF metadata is invalid');
  if (validV2 && (typeof envelope.iv !== 'string' || !envelope.iv)) throw new Error('Encrypted backup IV is invalid');
  if (String(envelope.shopId) !== String(expectedShopId || '')) throw new Error('Encrypted backup shop identity does not match the request');
}
function validateBackupContents(contents) {
  if (!contents || typeof contents !== 'object' || Array.isArray(contents)) throw new Error('Invalid backup payload');
  if (contents.action !== 'backupState') throw new Error('Only backupState is supported by the direct Drive backup endpoint');
  var format = String(contents.format || 'legacy').trim();
  if (!['encrypted-single', 'encrypted-part', 'encrypted-manifest'].includes(format)) throw new Error('Encrypted backup uploads are required');
  validateShopProof(contents.shopProof);

  if (format === 'encrypted-single') {
    validateEncryptedEnvelope(contents.state, contents.shopId);
    validateBackupId(contents.backupId);
    validateExportedAt(contents.exportedAt);
    return;
  }

  if (format === 'encrypted-part') {
    var dayKeyPart = validateDayKey(contents.dayKey);
    var expectedPartPrefix = getBackupFilePrefix(contents.shopId, dayKeyPart) + '.';
    var chunk = String(contents.chunk || '');
    var chunkBytes = Utilities.newBlob(chunk, 'text/plain').getBytes().length;
    if (!chunk || chunkBytes > MAX_MULTIPART_PART_BYTES) throw new Error('Backup part is empty or too large');
    var partIndex = Number(contents.partIndex);
    var totalParts = Number(contents.totalParts);
    if (!Number.isInteger(partIndex) || partIndex < 1 || !Number.isInteger(totalParts) || totalParts < 1 || partIndex > totalParts) {
      throw new Error('Invalid backup part index');
    }
    validateBackupId(contents.backupId);
    if (!/^[A-Za-z0-9._:-]+$/.test(String(contents.partName || ''))) throw new Error('Invalid backup part name');
    if (String(contents.partName).indexOf(expectedPartPrefix) !== 0 || String(contents.partName).indexOf('.part') < 0) throw new Error('Backup part does not belong to the requested shop/day');
    return;
  }

  if (format === 'encrypted-manifest') {
    var dayKeyManifest = validateDayKey(contents.dayKey);
    var totalPartsManifest = Number(contents.totalParts);
    var totalBytes = Number(contents.totalBytes);
    var partNames = contents.partNames;
    if (!Number.isInteger(totalPartsManifest) || totalPartsManifest < 1 || totalPartsManifest > 1000) throw new Error('Invalid multipart count');
    if (!Number.isInteger(totalBytes) || totalBytes < 1) throw new Error('Invalid multipart byte count');
    if (!Array.isArray(partNames) || partNames.length !== totalPartsManifest) throw new Error('Invalid multipart part list');
    var expectedPartPrefix = getBackupFilePrefix(contents.shopId, dayKeyManifest) + '.';
    partNames.forEach(function(name) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(name) || name.indexOf(expectedPartPrefix) !== 0 || name.indexOf('.part') < 0) throw new Error('Invalid multipart filename');
    });
    if (typeof contents.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(contents.sha256)) throw new Error('Invalid multipart hash');
    var partSizeManifest = Number(contents.partSize);
    if (!Number.isInteger(partSizeManifest) || partSizeManifest < 1 || partSizeManifest > MAX_MULTIPART_PART_BYTES) throw new Error('Invalid multipart part size');
    var seenPartNames = {};
    partNames.forEach(function(name) {
      if (seenPartNames[name]) throw new Error('Duplicate multipart part name');
      seenPartNames[name] = true;
    });
    validateBackupId(contents.backupId);
    validateExportedAt(contents.exportedAt);
    return;
  }

  if (!contents.state || typeof contents.state !== 'object' || Array.isArray(contents.state)) throw new Error('A valid legacy backup state is required');
  var serialized = JSON.stringify(contents.state);
  var serializedBytes = Utilities.newBlob(serialized, 'application/json').getBytes().length;
  if (serializedBytes > MAX_BACKUP_BYTES) throw new Error('Backup is too large for the Google Drive backup endpoint');
}

function getBackupFilePrefix(shopId, dayKey) {
  return 'NEXFIX_' + shopPartitionKey(shopId) + '_' + dayKey;
}

function validateRequestId(requestId) {
  var value = String(requestId || '').trim();
  if (!value || value.length > REQUEST_ID_MAX_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('Valid requestId is required');
  }
  return value;
}

function validateDayKey(dayKey) {
  var value = String(dayKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Valid backup dayKey is required');
  return value;
}

function validateBackupId(value) {
  var id = String(value || '').trim();
  if (!id || id.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('Valid backup id is required');
  return id;
}

function validateExportedAt(value) {
  var text = String(value || '').trim();
  if (!text || isNaN(Date.parse(text))) throw new Error('Valid backup exportedAt is required');
  return text;
}

function checkBackupRateLimit(shopId, backupId, format) {
  var cache = CacheService.getScriptCache();
  var key = 'nexfix_rate_' + shopPartitionKey(shopId);
  var raw = cache.get(key);
  var now = Date.now();
  var current = null;
  try { current = raw ? JSON.parse(raw) : null; } catch (ignore) { current = null; }

  var safeBackupId = String(backupId || '');
  // Multipart parts belong to one logical backup. A successful first part
  // establishes a short lease; retries of the same backup remain allowed.
  if (format === 'encrypted-part' && safeBackupId) {
    if (current && current.backupId === safeBackupId
        && Number(current.startedAt) > now - BACKUP_RATE_WINDOW_SECONDS * 1000) return;
    var multipartKey = 'nexfix_multipart_' + shopPartitionKey(shopId) + '_' + safeBackupId;
    if (cache.get(multipartKey) === '1') return;
  }

  if (current && Number(current.startedAt) > now - BACKUP_RATE_WINDOW_SECONDS * 1000) {
    var elapsed = Math.max(0, now - Number(current.startedAt));
    var retryAfter = Math.max(1, Math.ceil((BACKUP_RATE_WINDOW_SECONDS * 1000 - elapsed) / 1000));
    var rateError = new Error('Backup is temporarily busy. Please retry in about ' + retryAfter + ' seconds.');
    rateError.retryAfterSeconds = retryAfter;
    throw rateError;
  }
}

function recordBackupRateLimit(shopId, backupId, format) {
  var cache = CacheService.getScriptCache();
  var partition = shopPartitionKey(shopId);
  var key = 'nexfix_rate_' + partition;
  var now = Date.now();
  cache.put(key, JSON.stringify({ startedAt: now, backupId: String(backupId || '') }), BACKUP_RATE_WINDOW_SECONDS);
  if (format === 'encrypted-part' && backupId) {
    cache.put('nexfix_multipart_' + partition + '_' + String(backupId), '1', 600);
  }
}

function requestPayloadFingerprint(contents) {
  return sha256HexText(JSON.stringify(contents));
}

function sha256HexText(value) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.newBlob(String(value), 'text/plain').getBytes()
  );
  return digest.map(function(byte) {
    var n = byte < 0 ? byte + 256 : byte;
    return ('0' + n.toString(16)).slice(-2);
  }).join('');
}

function shopPartitionKey(shopId) {
  var normalized = normalizeShopId(shopId);
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalized, Utilities.Charset.UTF_8);
  return digest.map(function(byte) {
    var n = byte < 0 ? byte + 256 : byte;
    return ('0' + n.toString(16)).slice(-2);
  }).join('').slice(0, 24);
}

function partitionedSheetName(baseName, shopId) {
  return String(baseName).slice(0, 70) + '_' + shopPartitionKey(shopId);
}

function syncTable(ss, table, rows, shopId) {
  if (!isAllowedDataTable(table)) throw new Error('Table is not allowed');
  var safeTable = normalizeTableName(table);
  var sheetName = partitionedSheetName(safeTable, shopId);
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  rows = Array.isArray(rows) ? rows : [];
  if (!rows.length) return { table: safeTable, rows: 0, shopPartition: shopPartitionKey(shopId) };

  var headers = Object.keys(rows[0]);
  var values = rows.map(function(row) {
    return headers.map(function(h) { return value(row[h]); });
  });

  if (safeTable.toLowerCase() === 'products') {
    sheet.clearContents();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(2, 1, values.length, headers.length).setValues(values);
  } else {
    var existing = sheet.getLastRow() > 0 && sheet.getLastColumn() > 0
      ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].filter(String)
      : headers;
    if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, existing.length).setValues([existing]);
    var appendValues = rows.map(function(row) {
      return existing.map(function(h) { return value(row[h]); });
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, appendValues.length, existing.length).setValues(appendValues);
  }
  return { table: safeTable, rows: rows.length, shopPartition: shopPartitionKey(shopId) };
}

function sanitizeDriveName(value) {
  return String(value || 'Shop').trim().replace(/[\\/:*?"<>|#%{}~&]/g, '_').replace(/\s+/g, ' ').slice(0, 80) || 'Shop';
}

function getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function normalizeDriveFolderId(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';
  var match = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return /^[a-zA-Z0-9_-]{10,}$/.test(raw) ? raw : '';
}

function getRootBackupFolder() {
  var propertyValue = PropertiesService.getScriptProperties().getProperty(ROOT_BACKUP_FOLDER_ID_PROPERTY);
  var raw = propertyValue === null ? DEFAULT_ROOT_BACKUP_FOLDER_ID : String(propertyValue).trim();
  if (!raw) throw new Error('ROOT_BACKUP_FOLDER_ID is empty');
  var configured = normalizeDriveFolderId(raw);
  if (!configured) throw new Error('ROOT_BACKUP_FOLDER_ID is invalid');
  try {
    return DriveApp.getFolderById(configured);
  } catch (ignore) {
    throw new Error('Configured ROOT_BACKUP_FOLDER_ID cannot be accessed by the Apps Script account');
  }
}

function getShopBackupFolder(shopId, shopName, renameNow) {
  var root = getRootBackupFolder();
  var partitionPrefix = 'Shop_' + shopPartitionKey(shopId) + ' - ';
  var desiredName = partitionPrefix + sanitizeDriveName(shopName || 'Shop');
  var folders = root.getFolders();
  while (folders.hasNext()) {
    var folder = folders.next();
    if (folder.getName().indexOf(partitionPrefix) === 0) {
      // During backup validation, never rename an existing shop folder from a
      // stale/failed request. Rename only after the new backup is accepted.
      if (renameNow !== false && folder.getName() !== desiredName) {
        try { folder.setName(desiredName); } catch (ignore) {}
      }
      return folder;
    }
  }
  return root.createFolder(desiredName);
}

function writeShopMetadata(folder, shopId, shopName, encrypted, metadata) {
  metadata = metadata || {};
  var partition = shopPartitionKey(shopId);
  var record = {
    app: 'Nexfix POS',
    version: VERSION,
    shopPartition: partition,
    shopName: sanitizeDriveName(shopName || 'Shop'),
    tagline: metadataText(metadata.shopTagline, 200),
    phone: metadataText(metadata.shopPhone, 80),
    email: metadataText(metadata.shopEmail, 160),
    address: metadataText(metadata.shopAddress, 300),
    taxRegistrationNo: metadataText(metadata.taxRegistrationNo, 100),
    invoicePlaceOfSupply: metadataText(metadata.invoicePlaceOfSupply, 160),
    invoiceTitle: metadataText(metadata.invoiceTitle, 160),
    invoiceSubtitle: metadataText(metadata.invoiceSubtitle, 200),
    invoiceCurrency: metadataText(metadata.invoiceCurrency, 30),
    invoiceTaxLabel: metadataText(metadata.invoiceTaxLabel, 80),
    invoiceTerms: metadataText(metadata.invoiceTerms, 500),
    invoiceFooter: metadataText(metadata.invoiceFooter, 500),
    receiptFooter: metadataText(metadata.receiptFooter, 500),
    taxDefault: Number(metadata.taxDefault) || 0,
    lowStockDefault: Number(metadata.lowStockDefault) || 0,
    exchangeDays: Number(metadata.exchangeDays) || 0,
    openingFloat: Number(metadata.openingFloat) || 0,
    whatsappReceipts: metadata.whatsappReceipts === true,
    shopBackupId: shopId,
    backupType: metadata.kind === 'auto' ? 'auto' : 'manual',
    backupId: metadata.backupId ? String(metadata.backupId) : '',
    exportedAt: metadata.exportedAt ? String(metadata.exportedAt) : '',
    updatedAt: new Date().toISOString(),
    encrypted: encrypted === true
  };
  var files = folder.getFilesByName(DRIVE_METADATA_FILENAME);
  var blob = Utilities.newBlob(JSON.stringify(record, null, 2), 'application/json', DRIVE_METADATA_FILENAME);
  if (files.hasNext()) files.next().setContent(blob.getDataAsString());
  else folder.createFile(blob);
}

function metadataText(value, maxLength) {
  var text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function writeShopInfoText(folder, shopId, metadata) {
  metadata = metadata || {};
  var partition = shopPartitionKey(shopId);
  var lines = [
    'NEXFIX POS - SHOP BACKUP INFORMATION',
    '=====================================',
    '',
    'Shop Name: ' + metadataText(metadata.shopName || 'Shop', 120),
    'Phone: ' + metadataText(metadata.shopPhone, 80),
    'Email: ' + metadataText(metadata.shopEmail, 160),
    'Address: ' + metadataText(metadata.shopAddress, 300),
    'Tagline: ' + metadataText(metadata.shopTagline, 200),
    'Tax Registration No: ' + metadataText(metadata.taxRegistrationNo, 100),
    'Invoice Place of Supply: ' + metadataText(metadata.invoicePlaceOfSupply, 160),
    'Invoice Title: ' + metadataText(metadata.invoiceTitle, 160),
    'Invoice Subtitle: ' + metadataText(metadata.invoiceSubtitle, 200),
    'Invoice Currency: ' + metadataText(metadata.invoiceCurrency, 30),
    'Invoice Tax Label: ' + metadataText(metadata.invoiceTaxLabel, 80),
    'Invoice Terms: ' + metadataText(metadata.invoiceTerms, 500),
    'Invoice Footer: ' + metadataText(metadata.invoiceFooter, 500),
    'Receipt Footer: ' + metadataText(metadata.receiptFooter, 500),
    'Tax Default: ' + metadataText(metadata.taxDefault, 40),
    'Low Stock Default: ' + metadataText(metadata.lowStockDefault, 40),
    'Exchange Days: ' + metadataText(metadata.exchangeDays, 40),
    'Opening Float: ' + metadataText(metadata.openingFloat, 40),
    'WhatsApp Receipts: ' + (metadata.whatsappReceipts === true ? 'true' : 'false'),
    '',
    'Shop Backup ID: ' + metadataText(shopId, SHOP_ID_MAX_LENGTH),
    'Shop Partition: ' + partition,
    'Backup Type: ' + metadataText(metadata.kind || 'unknown', 20),
    'Backup ID: ' + metadataText(metadata.backupId, 100),
    'Last Backup Exported At: ' + metadataText(metadata.exportedAt || new Date().toISOString(), 80),
    'Apps Script Version: ' + VERSION,
    'Recovery Key File: RECOVERY_KEY.txt',
    'Shop Backup ID Copy: ' + metadataText(shopId, SHOP_ID_MAX_LENGTH),
    '',
    'Recovery note: Use the Shop Backup ID above to reconnect this shop after reinstalling or moving the POS to another PC.',
    'The Recovery Key is stored separately in RECOVERY_KEY.txt. Keep a private copy outside the PC for disaster recovery.',
    'This file contains shop identification/contact metadata only. POS business records remain inside the encrypted backup payload.',
    'Do not edit this file manually; it is regenerated by Nexfix POS during backup.'
  ];
  var content = lines.join('\n') + '\n';
  var fileName = 'SHOP_INFO.txt';
  var files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    var file = files.next();
    file.setContent(content);
    while (files.hasNext()) { try { files.next().setTrashed(true); } catch (ignoreDuplicate) {} }
  } else {
    folder.createFile(Utilities.newBlob(content, 'text/plain', fileName));
  }
}

function assertRecoveryKeyMatchesExisting(folder, recoveryKey) {
  var key = validateRecoveryKey(recoveryKey);
  var files = folder.getFilesByName('RECOVERY_KEY.txt');
  if (!files.hasNext()) return;
  var file = files.next();
  var existing = String(file.getBlob().getDataAsString() || '');
  var match = existing.match(/^Recovery Key:\s*([A-Za-z0-9_-]{43})\s*$/m);
  if (!match) throw new Error('Existing RECOVERY_KEY.txt is invalid; automatic backup was stopped to protect existing backups.');
  if (match[1] !== key) throw new Error('Recovery Key mismatch for this shop. Use the existing Recovery Key before backing up.');
}

function writeRecoveryKeyFile(folder, recoveryKey, metadata) {
  var key = validateRecoveryKey(recoveryKey);
  metadata = metadata || {};
  var lines = [
    'NEXFIX POS - RECOVERY KEY',
    '=========================',
    '',
    'Shop Name: ' + metadataText(metadata.shopName || 'Shop', 120),
    'Phone: ' + metadataText(metadata.shopPhone, 80),
    'Email: ' + metadataText(metadata.shopEmail, 160),
    'Address: ' + metadataText(metadata.shopAddress, 300),
    'Tagline: ' + metadataText(metadata.shopTagline, 200),
    'Tax Registration No: ' + metadataText(metadata.taxRegistrationNo, 100),
    'Invoice Place of Supply: ' + metadataText(metadata.invoicePlaceOfSupply, 160),
    'Invoice Title: ' + metadataText(metadata.invoiceTitle, 160),
    'Invoice Subtitle: ' + metadataText(metadata.invoiceSubtitle, 200),
    'Invoice Currency: ' + metadataText(metadata.invoiceCurrency, 30),
    'Invoice Tax Label: ' + metadataText(metadata.invoiceTaxLabel, 80),
    'Invoice Terms: ' + metadataText(metadata.invoiceTerms, 500),
    'Invoice Footer: ' + metadataText(metadata.invoiceFooter, 500),
    'Receipt Footer: ' + metadataText(metadata.receiptFooter, 500),
    'Tax Default: ' + metadataText(metadata.taxDefault, 40),
    'Low Stock Default: ' + metadataText(metadata.lowStockDefault, 40),
    'Exchange Days: ' + metadataText(metadata.exchangeDays, 40),
    'Opening Float: ' + metadataText(metadata.openingFloat, 40),
    'WhatsApp Receipts: ' + (metadata.whatsappReceipts === true ? 'true' : 'false'),
    '',
    'Shop Backup ID: ' + metadataText(metadata.shopId, SHOP_ID_MAX_LENGTH),
    'Shop Partition: ' + metadataText(metadata.shopPartition, 40),
    'Backup Type: ' + metadataText(metadata.kind || 'unknown', 20),
    'Backup ID: ' + metadataText(metadata.backupId, 100),
    'Last Backup Exported At: ' + metadataText(metadata.exportedAt || new Date().toISOString(), 80),
    'Apps Script Version: ' + VERSION,
    '',
    'Recovery Key: ' + key,
    '',
    'IMPORTANT:',
    'Keep this key in a secure private place.',
    'This key can decrypt automatic encrypted Nexfix POS backups for this shop.',
    'Anyone who has access to both this key and the encrypted backup can decrypt the backup.',
    'Do not edit this file manually. Nexfix POS regenerates it during backup.'
  ];
  var content = lines.join('\n') + '\n';
  var fileName = 'RECOVERY_KEY.txt';
  var files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    var file = files.next();
    var existing = String(file.getBlob().getDataAsString() || '');
    var match = existing.match(/^Recovery Key:\s*([A-Za-z0-9_-]{43})\s*$/m);
    if (!match) throw new Error('Existing RECOVERY_KEY.txt is invalid; automatic backup was stopped to protect existing backups.');
    if (match[1] !== key) throw new Error('Recovery Key mismatch for this shop. Use the existing Recovery Key before backing up.');
    file.setContent(content);
    while (files.hasNext()) { try { files.next().setTrashed(true); } catch (ignoreDuplicate) {} }
  } else {
    folder.createFile(Utilities.newBlob(content, 'text/plain', fileName));
  }
}

function trashDailyBackupSet(backupFolder, shopId, dayKey, keepNames, keepBackupId) {
  var prefix = getBackupFilePrefix(shopId, dayKey);
  var keepDescription = keepBackupId ? backupPartDescription(keepBackupId) : '';
  var files = backupFolder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (name.indexOf(prefix) !== 0) continue;
    if (keepNames && keepNames[name]) {
      if (keepBackupId && name.indexOf('.part') > 0 && String(file.getDescription() || '') !== keepDescription) {
        try { file.setTrashed(true); } catch (ignoreOldPart) {}
      }
      continue;
    }
    try { file.setTrashed(true); } catch (ignore) {}
  }
}

function upsertDailyFile(folder, fileName, content) {
  var files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    var file = files.next();
    file.setContent(content);
    while (files.hasNext()) {
      try { files.next().setTrashed(true); } catch (ignoreDuplicate) {}
    }
    return file;
  }
  return folder.createFile(Utilities.newBlob(content, 'application/json', fileName));
}

function parseExportedAtMillis(value) {
  var text = String(value || '').trim();
  if (!text) return 0;
  var millis = Date.parse(text);
  return isNaN(millis) ? 0 : millis;
}

function getLatestDailyBackupInfo(backupFolder, shopId, dayKey) {
  var prefix = getBackupFilePrefix(shopId, dayKey);
  var files = backupFolder.getFiles();
  var latest = null;
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (name.indexOf(prefix) !== 0 || name.indexOf('.part') > 0) continue;
    try {
      var parsed = JSON.parse(file.getBlob().getDataAsString());
      var exportedAt = '';
      var backupId = '';
      if (name.indexOf('.manifest.json') > 0) {
        if (!parsed || parsed.app !== 'Nexfix POS' || parsed.encrypted !== true) continue;
        exportedAt = parsed.exportedAt || '';
        backupId = String(parsed.backupId || '');
      } else {
        var meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed._meta || {}) : {};
        if (!meta || String(meta.app || '') !== 'Nexfix POS') continue;
        exportedAt = meta.exportedAt || '';
        backupId = String(meta.backupId || '');
      }
      var millis = parseExportedAtMillis(exportedAt);
      if (!millis) continue;
      if (!latest || millis > latest.exportedAtMillis) {
        latest = { exportedAtMillis: millis, exportedAt: String(exportedAt), backupId: backupId, fileName: name };
      }
    } catch (ignore) {}
  }
  return latest;
}

function assertDailyBackupIsFresh(backupFolder, shopId, dayKey, incomingExportedAt, incomingBackupId) {
  var incomingMillis = parseExportedAtMillis(incomingExportedAt);
  if (!incomingMillis) throw new Error('Valid backup exportedAt is required');
  var latest = getLatestDailyBackupInfo(backupFolder, shopId, dayKey);
  if (!latest) return;
  if (latest.backupId && String(latest.backupId) === String(incomingBackupId || '')) return;
  if (latest.exportedAtMillis > incomingMillis) {
    throw new Error('Stale backup rejected: a newer backup already exists for this shop/day.');
  }
}

function backupPartDescription(backupId) {
  return 'NEXFIX-BACKUP:' + String(backupId || '');
}

function upsertMultipartPart(folder, fileName, content, backupId) {
  var expectedDescription = backupPartDescription(backupId);
  var files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    var file = files.next();
    if (String(file.getDescription() || '') === expectedDescription) {
      file.setContent(content);
      return file;
    }
  }
  return folder.createFile(Utilities.newBlob(content, 'text/plain', fileName))
    .setDescription(expectedDescription);
}

function findMultipartPart(folder, fileName, backupId) {
  var expectedDescription = backupPartDescription(backupId);
  var files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    var file = files.next();
    if (String(file.getDescription() || '') === expectedDescription) return file;
  }
  return null;
}

function commitShopMetadata(shopFolder, shopId, shopName, encrypted, contents, recoveryKey) {
  var warnings = [];
  try { writeShopMetadata(shopFolder, shopId, shopName, encrypted, contents); }
  catch (err) { warnings.push('shop.json update failed: ' + String(err)); }
  if (recoveryKey) {
    try { writeRecoveryKeyFile(shopFolder, recoveryKey, Object.assign({}, contents, { shopId: shopId, shopPartition: shopPartitionKey(shopId), shopName: shopName })); }
    catch (err) { warnings.push('RECOVERY_KEY.txt update failed: ' + String(err)); }
  }
  try { writeShopInfoText(shopFolder, shopId, contents); }
  catch (err) { warnings.push('SHOP_INFO.txt update failed: ' + String(err)); }
  return warnings;
}

function backupResultWithWarnings(result, warnings) {
  if (warnings && warnings.length) result.metadataWarnings = warnings;
  return result;
}

function backupStateToDrive(contents, shopId) {
  var format = String(contents.format || 'legacy').trim();
  var state = format === 'legacy' ? (contents.state || {}) : null;
  var shopName = String(contents.shopName || (state && state.settings && state.settings.shopName) || 'Shop');
  // Do not rename/update shop metadata from an uncommitted or stale backup.
  // The stable partition identifies the shop; display details are committed only
  // after the backup itself passes freshness/integrity checks.
  var shopProof = validateShopProof(contents.shopProof);
  var shopFolder = authorizeShopAccess(shopId, shopProof, true);
  if (!shopFolder) throw new Error('Shop backup authorization failed');
  var backupFolder = getOrCreateFolder(shopFolder, DRIVE_BACKUP_SUBFOLDER_NAME);
  var encrypted = format.indexOf('encrypted-') === 0;

  var now = new Date();
  var timeZone = Session.getScriptTimeZone() || 'Etc/UTC';
  var dayKey = contents.dayKey ? validateDayKey(contents.dayKey) : Utilities.formatDate(now, timeZone, 'yyyy-MM-dd');
  var partition = shopPartitionKey(shopId);
  var recoveryKey = format.indexOf('encrypted-') === 0 ? validateRecoveryKey(contents.recoveryKey) : '';
  // Preflight the recovery-key invariant before touching any backup payload.
  // Otherwise an old implementation could write the new daily backup first,
  // then fail while updating RECOVERY_KEY.txt, leaving the client reporting
  // "Backup request failed" while SHOP_INFO.txt stayed stale.
  if (recoveryKey) assertRecoveryKeyMatchesExisting(shopFolder, recoveryKey);

  if (format === 'encrypted-single') {
    var fileName = 'NEXFIX_' + partition + '_' + dayKey + '.json';
    var envelope = {
      _meta: {
        app: 'Nexfix POS',
        version: 3,
        exportedAt: contents.exportedAt || now.toISOString(),
        kind: contents.kind === 'auto' ? 'auto' : 'manual',
        shopId: shopId,
        shopPartition: partition,
        shopName: shopName,
        dayKey: dayKey,
        backupId: String(contents.backupId || ''),
        encrypted: true
      },
      payload: JSON.parse(contents.state)
    };
    var serialized = JSON.stringify(envelope);
    assertDailyBackupIsFresh(backupFolder, shopId, dayKey, envelope._meta.exportedAt, envelope._meta.backupId);
    var file = upsertDailyFile(backupFolder, fileName, serialized);
    if (shopFolder.getName() !== 'Shop_' + partition + ' - ' + sanitizeDriveName(shopName)) {
      try { shopFolder.setName('Shop_' + partition + ' - ' + sanitizeDriveName(shopName)); } catch (ignore) {}
    }
    var singleWarnings = commitShopMetadata(shopFolder, shopId, shopName, encrypted, contents, recoveryKey);
    trashDailyBackupSet(backupFolder, shopId, dayKey, (function(){ var keep={}; keep[fileName]=true; return keep; })());
    return backupResultWithWarnings({ action: 'backupState', backupType: envelope._meta.kind, timestamp: envelope._meta.exportedAt, driveFileId: file.getId(), driveFileName: file.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: partition, encrypted: true, multipart: false, backupId: envelope._meta.backupId }, singleWarnings);
  }

  if (format === 'encrypted-part') {
    var partName = String(contents.partName);
    var partBytes = Utilities.newBlob(String(contents.chunk), 'text/plain').getBytes().length;
    if (partBytes > MAX_MULTIPART_PART_BYTES) throw new Error('Backup part exceeds Drive safety limit');
    var partFile = upsertMultipartPart(backupFolder, partName, String(contents.chunk), contents.backupId);
    return { action: 'backupState', backupType: contents.kind === 'auto' ? 'auto' : 'manual', timestamp: now.toISOString(), driveFileId: partFile.getId(), driveFileName: partFile.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: partition, encrypted: true, multipart: true };
  }

  if (format === 'encrypted-manifest') {
    var manifestName = 'NEXFIX_' + partition + '_' + dayKey + '.manifest.json';
    var partNames = contents.partNames || [];
    var totalBytes = Number(contents.totalBytes);
    var totalParts = Number(contents.totalParts);
    var totalFoundBytes = 0;
    for (var i = 0; i < partNames.length; i++) {
      var partFile = findMultipartPart(backupFolder, partNames[i], contents.backupId);
      if (!partFile) throw new Error('Multipart part is missing: ' + partNames[i]);
      totalFoundBytes += partFile.getSize();
    }
    if (totalFoundBytes !== totalBytes) throw new Error('Multipart byte count does not match stored parts');
    var combinedParts = '';
    for (var hi = 0; hi < partNames.length; hi++) {
      var hashPart = findMultipartPart(backupFolder, partNames[hi], contents.backupId);
      if (!hashPart) throw new Error('Multipart part is missing during integrity verification');
      combinedParts += hashPart.getBlob().getDataAsString();
    }
    if (sha256HexText(combinedParts) !== String(contents.sha256)) {
      throw new Error('Multipart SHA-256 integrity verification failed');
    }
    var manifest = {
      version: 1,
      app: 'Nexfix POS',
      dayKey: dayKey,
      shopId: shopId,
      shopPartition: partition,
      shopName: shopName,
      backupId: String(contents.backupId),
      totalBytes: totalBytes,
      partSize: Number(contents.partSize) || MAX_MULTIPART_PART_BYTES,
      parts: totalParts,
      partNames: partNames,
      sha256: String(contents.sha256),
      encrypted: true,
      exportedAt: contents.exportedAt || now.toISOString(),
      kind: contents.kind === 'auto' ? 'auto' : 'manual'
    };
    var manifestText = JSON.stringify(manifest);
    assertDailyBackupIsFresh(backupFolder, shopId, dayKey, manifest.exportedAt, manifest.backupId);
    var manifestFile = upsertDailyFile(backupFolder, manifestName, manifestText);
    if (shopFolder.getName() !== 'Shop_' + partition + ' - ' + sanitizeDriveName(shopName)) {
      try { shopFolder.setName('Shop_' + partition + ' - ' + sanitizeDriveName(shopName)); } catch (ignore) {}
    }
    var manifestWarnings = commitShopMetadata(shopFolder, shopId, shopName, encrypted, contents, recoveryKey);
    manifestFile.setDescription(backupPartDescription(contents.backupId));
    var keep = {};
    keep[manifestName] = true;
    partNames.forEach(function(name){ keep[name] = true; });
    trashDailyBackupSet(backupFolder, shopId, dayKey, keep, contents.backupId);
    return backupResultWithWarnings({ action: 'backupState', backupType: manifest.kind, timestamp: manifest.exportedAt, driveFileId: manifestFile.getId(), driveFileName: manifestFile.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: partition, encrypted: true, multipart: true, backupId: manifest.backupId, totalParts: totalParts }, manifestWarnings);
  }

  var legacyName = 'NEXFIX_' + partition + '_' + dayKey + '.json';
  var legacyEnvelope = {
    _meta: { app: 'Nexfix POS', version: 2, exportedAt: contents.exportedAt || now.toISOString(), kind: contents.kind === 'auto' ? 'auto' : 'manual', shopId: shopId, shopPartition: partition, shopName: shopName, dayKey: dayKey, backupId: String(contents.backupId || ''), encrypted: false },
    state: state
  };
  var legacySerialized = JSON.stringify(legacyEnvelope);
  assertDailyBackupIsFresh(backupFolder, shopId, dayKey, legacyEnvelope._meta.exportedAt, legacyEnvelope._meta.backupId);
  var legacyFile = upsertDailyFile(backupFolder, legacyName, legacySerialized);
  if (shopFolder.getName() !== 'Shop_' + partition + ' - ' + sanitizeDriveName(shopName)) {
    try { shopFolder.setName('Shop_' + partition + ' - ' + sanitizeDriveName(shopName)); } catch (ignore) {}
  }
  var legacyWarnings = commitShopMetadata(shopFolder, shopId, shopName, encrypted, contents, '');
  trashDailyBackupSet(backupFolder, shopId, dayKey, (function(){ var keep={}; keep[legacyName]=true; return keep; })());
  return backupResultWithWarnings({ action: 'backupState', backupType: legacyEnvelope._meta.kind, timestamp: legacyEnvelope._meta.exportedAt, driveFileId: legacyFile.getId(), driveFileName: legacyFile.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: partition, encrypted: false, multipart: false, backupId: legacyEnvelope._meta.backupId }, legacyWarnings);
}

function backupState(ss, contents, shopId) {
  var driveResult = backupStateToDrive(contents, shopId);
  if (!ss) return driveResult;
  var sheetName = partitionedSheetName(BACKUP_SHEET, shopId);
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  var state = contents.state || {};
  var now = new Date();
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 5).setValues([['Timestamp', 'BackupType', 'Version', 'ShopPartition', 'StateJSON']]);
  sheet.getRange(2, 1, 1, 5).setValues([[now, contents.kind || 'manual', VERSION, shopPartitionKey(shopId), JSON.stringify(state)]]);
  return driveResult;
}

function latestDriveBackup(shopId) {
  var root = getRootBackupFolder();
  var shopFolders = root.getFolders();
  var latest = null;
  var latestPayload = null;
  var partitionPrefix = 'NEXFIX_' + shopPartitionKey(shopId) + '_';
  var shopFolderPrefix = 'Shop_' + shopPartitionKey(shopId) + ' - ';

  while (shopFolders.hasNext()) {
    var shopFolder = shopFolders.next();
    if (shopFolder.getName().indexOf(shopFolderPrefix) !== 0) continue;
    var backups = shopFolder.getFoldersByName(DRIVE_BACKUP_SUBFOLDER_NAME);
    while (backups.hasNext()) {
      var backupFolder = backups.next();
      var files = backupFolder.getFiles();
      while (files.hasNext()) {
        var file = files.next();
        var name = file.getName();
        if (file.getMimeType() !== 'application/json' || name.indexOf(partitionPrefix) !== 0) continue;
        try {
          if (name.indexOf('.manifest.json') > 0) {
            var manifest = JSON.parse(file.getBlob().getDataAsString());
            if (!manifest || manifest.app !== 'Nexfix POS' || manifest.version !== 1 || manifest.encrypted !== true) continue;
            if (String(manifest.shopPartition) !== shopPartitionKey(shopId) || String(manifest.shopId) !== String(shopId)) continue;
            if (!Array.isArray(manifest.partNames) || manifest.partNames.length !== Number(manifest.parts)) continue;
            var partsOk = true;
            var manifestBytes = 0;
            var manifestPayload = '';
            for (var mi = 0; mi < manifest.partNames.length; mi++) {
              var pf = findMultipartPart(backupFolder, manifest.partNames[mi], manifest.backupId);
              if (!pf) { partsOk = false; break; }
              manifestBytes += pf.getSize();
              manifestPayload += pf.getBlob().getDataAsString();
            }
            if (!partsOk || manifestBytes !== Number(manifest.totalBytes)) continue;
            if (!manifest.sha256 || sha256HexText(manifestPayload) !== String(manifest.sha256)) continue;
            if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) {
              latest = file;
              latestPayload = { multipart: true, manifest: manifest, backupId: String(manifest.backupId || ''), shopName: manifest.shopName, timestamp: manifest.exportedAt, kind: manifest.kind, shopId: manifest.shopId, shopPartition: manifest.shopPartition };
            }
            continue;
          }

          if (name.indexOf('.part') > 0) continue;
          var raw = file.getBlob().getDataAsString();
          if (file.getSize() > MAX_BACKUP_BYTES) continue;
          var parsed = JSON.parse(raw);
          var meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed._meta || {}) : {};
          if (!meta || String(meta.app || 'Nexfix POS') !== 'Nexfix POS') continue;
          if (meta.shopPartition && String(meta.shopPartition) !== shopPartitionKey(shopId)) continue;
          if (meta.shopId && String(meta.shopId) !== String(shopId)) continue;

          if (meta.encrypted === true && parsed.payload) {
            if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) {
              latest = file;
              latestPayload = { state: JSON.stringify(parsed.payload), backupId: String(meta.backupId || ''), timestamp: meta.exportedAt || '', kind: meta.kind || '', shopId: meta.shopId || shopId, shopPartition: meta.shopPartition || shopPartitionKey(shopId), shopName: meta.shopName || 'Shop', encrypted: true, multipart: false };
            }
            continue;
          }

          if (!parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) continue;
          if (meta.version !== undefined && Number(meta.version) !== 2) continue;
          if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) {
            latest = file;
            latestPayload = { state: JSON.stringify(parsed.state), backupId: String(meta.backupId || ''), timestamp: meta.exportedAt || '', kind: meta.kind || '', shopId: meta.shopId || shopId, shopPartition: meta.shopPartition || shopPartitionKey(shopId), shopName: meta.shopName || (parsed.state.settings && parsed.state.settings.shopName ? String(parsed.state.settings.shopName) : 'Shop'), encrypted: false, multipart: false };
          }
        } catch (ignore) {}
      }
    }
  }
  return latestPayload;
}

function latestBackup(ss, shopId) {
  var driveBackup = latestDriveBackup(shopId);
  if (driveBackup) {
    return {
      timestamp: driveBackup.timestamp || '',
      backupType: driveBackup.kind || '',
      version: VERSION,
      shopId: driveBackup.shopId || shopId,
      shopPartition: driveBackup.shopPartition || shopPartitionKey(shopId),
      shopName: driveBackup.shopName || 'Shop',
      backupId: driveBackup.backupId || '',
      encrypted: driveBackup.encrypted === true,
      multipart: driveBackup.multipart === true,
      state: driveBackup.state || '',
      manifest: driveBackup.manifest || null
    };
  }
  if (!ss) return null;
  var sheet = ss.getSheetByName(partitionedSheetName(BACKUP_SHEET, shopId));
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 5) return null;
  var values = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(5, sheet.getLastColumn())).getValues();
  var headers = values[0];
  var timestampIndex = headers.indexOf('Timestamp');
  var typeIndex = headers.indexOf('BackupType');
  var versionIndex = headers.indexOf('Version');
  var stateIndex = headers.indexOf('StateJSON');
  var partitionIndex = headers.indexOf('ShopPartition');
  if (stateIndex < 0 || partitionIndex < 0 || String(values[0][partitionIndex]) !== 'ShopPartition') return null;
  var row = values[values.length - 1];
  if (String(row[partitionIndex]) !== shopPartitionKey(shopId)) return null;
  var raw = row[stateIndex];
  if (!raw) return null;
  return { timestamp: timestampIndex >= 0 ? row[timestampIndex] : '', backupType: typeIndex >= 0 ? row[typeIndex] : '', version: versionIndex >= 0 ? row[versionIndex] : VERSION, state: String(raw), encrypted: false, multipart: false };
}

function getBackupPart(shopId, backupId, partName) {
  var normalizedShopId = normalizeShopId(shopId);
  var safeBackupId = String(backupId || '').trim();
  var safePartName = String(partName || '').trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(safeBackupId) || !/^[A-Za-z0-9._:-]+$/.test(safePartName)) return null;
  var root = getRootBackupFolder();
  var folders = root.getFolders();
  var partition = shopPartitionKey(normalizedShopId);
  var prefix = 'Shop_' + partition + ' - ';
  var expectedPartPrefix = 'NEXFIX_' + partition + '_';
  if (safePartName.indexOf(expectedPartPrefix) !== 0 || safePartName.indexOf('.part') < 0) return null;
  while (folders.hasNext()) {
    var shopFolder = folders.next();
    if (shopFolder.getName().indexOf(prefix) !== 0) continue;
    var backups = shopFolder.getFoldersByName(DRIVE_BACKUP_SUBFOLDER_NAME);
    while (backups.hasNext()) {
      var backupFolder = backups.next();
      var file = findMultipartPart(backupFolder, safePartName, safeBackupId);
      if (file) {
        var chunk = file.getBlob().getDataAsString();
        if (!chunk) return null;
        return { chunk: chunk, shopPartition: shopPartitionKey(normalizedShopId), backupId: safeBackupId, partName: safePartName };
      }
    }
  }
  return null;
}

function parsePostBody(e) {
  var raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
  if (e && e.parameter && e.parameter.payload) return JSON.parse(e.parameter.payload);
  return raw ? JSON.parse(raw) : {};
}

function backupStatusKey(shopId, requestId) {
  return 'nexfix_req_' + shopPartitionKey(shopId) + '_' + requestId;
}

function writeBackupStatus(statusKey, record, cacheTtlSeconds) {
  var serialized = JSON.stringify(record);
  // CacheService is fast but can evict entries. Script Properties provides a
  // durable status record so a slow client can still confirm a completed write.
  try { CacheService.getScriptCache().put(statusKey, serialized, cacheTtlSeconds); } catch (ignoreCache) {}
  try { PropertiesService.getScriptProperties().setProperty(statusKey, serialized); } catch (ignoreProperties) {}
}

function readBackupStatusRecord(statusKey) {
  var cached = CacheService.getScriptCache().get(statusKey);
  if (cached) return cached;
  try { return PropertiesService.getScriptProperties().getProperty(statusKey); } catch (ignoreProperties) { return null; }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var contents = parsePostBody(e);
    try { requireBackupApiKey(contents.apiKey); } catch (authError) { return json(unauthorized('Unauthorized')); }
    var shopId;
    try { shopId = normalizeShopId(contents.shopId); } catch (shopError) { return json(fail('A valid shopId is required')); }
    var requestId;
    try { requestId = validateRequestId(contents.requestId); } catch (requestError) { return json(fail(requestError)); }
    try { validateShopProof(contents.shopProof); } catch (proofError) { return json(unauthorized('Unauthorized')); }
    try { validateBackupContents(contents); } catch (payloadError) { return json(fail(payloadError)); }

    var statusKey = backupStatusKey(shopId, requestId);
    var requestFingerprint = requestPayloadFingerprint(contents);
    var existing = readBackupStatusRecord(statusKey);
    if (existing) {
      try {
        var existingRecord = JSON.parse(existing);
        if (existingRecord && existingRecord.fingerprint) {
          if (existingRecord.fingerprint !== requestFingerprint) {
            return json(fail('requestId has already been used with different backup contents'));
          }
          return json(existingRecord.result || existingRecord);
        }
        return json(fail('Request idempotency record is not bound to backup contents; retry with a new requestId'));
      } catch (ignoreExisting) {}
    }

    var pendingRecord = {
      fingerprint: requestFingerprint,
      shopPartition: shopPartitionKey(shopId),
      proofDigest: shopAuthDigest(contents.shopProof),
      result: { ok: false, status: 'pending', version: VERSION, pending: true, action: 'backupState' }
    };
    // Record pending before any Drive work so status reads have an explicit,
    // authenticated state instead of depending on a cache miss.
    writeBackupStatus(statusKey, pendingRecord, 600);

    try { checkBackupRateLimit(shopId, contents.backupId, String(contents.format || 'legacy').trim()); } catch (rateError) {
      var rateFailure = fail(rateError);
      writeBackupStatus(statusKey, {
        fingerprint: requestFingerprint,
        shopPartition: shopPartitionKey(shopId),
        proofDigest: shopAuthDigest(contents.shopProof),
        result: rateFailure
      }, 600);
      return json(rateFailure);
    }

    try {
      var result = ok(backupStateToDrive(contents, shopId));
      // Persist success immediately after Drive confirms the write, before
      // rate-limit bookkeeping. This closes the false-timeout window.
      writeBackupStatus(statusKey, {
        fingerprint: requestFingerprint,
        shopPartition: shopPartitionKey(shopId),
        proofDigest: shopAuthDigest(contents.shopProof),
        result: result
      }, 21600);
      try { recordBackupRateLimit(shopId, contents.backupId, String(contents.format || 'legacy').trim()); } catch (ignoreRateRecord) {}
      return json(result);
    } catch (backupError) {
      var backupFailure = fail(backupError);
      writeBackupStatus(statusKey, {
        fingerprint: requestFingerprint,
        shopPartition: shopPartitionKey(shopId),
        proofDigest: shopAuthDigest(contents.shopProof),
        result: backupFailure
      }, 600);
      return json(backupFailure);
    }
  } catch (err) {
    return json(fail(err));
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function isBackupStatusProofAuthorized(shopId, requestId, shopProof) {
  var safeShopId = normalizeShopId(shopId);
  var safeRequestId = validateRequestId(requestId);
  var proof = validateShopProof(shopProof);
  var raw = readBackupStatusRecord(backupStatusKey(safeShopId, safeRequestId));
  // The POST may not have written its pending record yet. Treat that tiny
  // startup race as "pending"; the requestId is random and no backup result
  // is exposed until a matching durable record exists.
  if (!raw) return true;
  try {
    var record = JSON.parse(raw);
    return !!record
      && String(record.shopPartition || '') === shopPartitionKey(safeShopId)
      && String(record.proofDigest || '') === shopAuthDigest(proof);
  } catch (ignore) {
    return false;
  }
}

function getCachedBackupStatus(requestId, shopId) {
  var id = String(requestId || '').trim();
  if (!id || id.length > REQUEST_ID_MAX_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(id)) return { ok: false, status: 'error', version: VERSION, message: 'Valid requestId is required' };

  var shopPartition = shopPartitionKey(shopId);
  var statusKey = backupStatusKey(shopId, id);
  var raw = readBackupStatusRecord(statusKey);
  if (!raw) return { ok: false, status: 'pending', version: VERSION, pending: true };

  try {
    var record = JSON.parse(raw);
    var result = record && record.result ? record.result : record;
    if (result && result.status === 'pending') return { ok: false, status: 'pending', version: VERSION, pending: true };
    if (result && result.ok === true && result.action === 'backupState' && result.shopPartition === shopPartition) return result;
    return { ok: false, status: 'error', version: VERSION, message: (result && result.message) || 'Backup request failed' };
  } catch (err) {
    return { ok: false, status: 'error', version: VERSION, message: 'Invalid cached backup result' };
  }
}

function getTable(ss, table, shopId) {
  if (!isAllowedDataTable(table)) throw new Error('Table is not allowed');
  var safeTable = normalizeTableName(table);
  var sheet = ss.getSheetByName(partitionedSheetName(safeTable, shopId));
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  var headers = values[0];
  return values.slice(1).map(function(row) {
    var out = {};
    headers.forEach(function(h, i) { if (h !== '') out[h] = row[i]; });
    return out;
  });
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'ping' || !p.action) return json(ok({ message: 'Nexfix POS Direct Google Backup API is running' }));

  if (p.action === 'backupStatus') {
    try { requireBackupApiKey(p.apiKey); } catch (authError) { return json(unauthorized('Unauthorized')); }
    var statusShopId;
    try {
      statusShopId = normalizeShopId(p.shopId);
      validateRequestId(p.requestId);
      validateShopProof(p.shopProof);
      // Do not scan Drive on every polling request. The durable status record
      // already binds this request to the same shop proof and API key.
      if (!isBackupStatusProofAuthorized(statusShopId, p.requestId, p.shopProof)) throw new Error('Unauthorized');
    } catch (err) {
      return json(unauthorized('Unauthorized'));
    }
    var statusResult = getCachedBackupStatus(p.requestId, statusShopId);
    var statusCallback = String(p.callback || '').trim();
    if (statusCallback && /^__nexfixGoogleBackupStatus_[0-9]+_[A-Za-z0-9]+$/.test(statusCallback)) {
      return ContentService.createTextOutput(statusCallback + '(' + JSON.stringify(statusResult) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json(statusResult);
  }

  if (p.action === 'getLatestBackup') {
    try { requireBackupApiKey(p.apiKey); } catch (authError) { return json(unauthorized('Unauthorized')); }
    var shopId;
    try {
      shopId = normalizeShopId(p.shopId);
      validateRequestId(p.requestId);
      validateShopProof(p.shopProof);
      authorizeShopAccess(shopId, p.shopProof, false);
    } catch (err) { return json(unauthorized('Unauthorized')); }
    var result = ok({ action: 'getLatestBackup', backup: latestBackup(null, shopId) });
    var callback = String(p.callback || '').trim();
    if (callback && /^__nexfixGoogleBackup_[0-9]+_[A-Za-z0-9]+$/.test(callback)) {
      return ContentService.createTextOutput(callback + '(' + JSON.stringify(result) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json(result);
  }

  if (p.action === 'getBackupPart') {
    try { requireBackupApiKey(p.apiKey); } catch (authError) { return json(unauthorized('Unauthorized')); }
    var partShopId;
    try {
      partShopId = normalizeShopId(p.shopId);
      validateRequestId(p.requestId);
      validateShopProof(p.shopProof);
      authorizeShopAccess(partShopId, p.shopProof, false);
    } catch (err) { return json(unauthorized('Unauthorized')); }
    var partResult = getBackupPart(partShopId, p.backupId, p.partName);
    var partResponse = partResult ? ok({ action: 'getBackupPart', chunk: partResult.chunk, shopPartition: partResult.shopPartition, backupId: partResult.backupId, partName: partResult.partName }) : { ok: false, status: 'error', version: VERSION, message: 'Backup part not found' };
    var partCallback = String(p.callback || '').trim();
    if (partCallback && /^__nexfixGoogleBackup_[0-9]+_[A-Za-z0-9]+$/.test(partCallback)) {
      return ContentService.createTextOutput(partCallback + '(' + JSON.stringify(partResponse) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json(partResponse);
  }

  return json(unauthorized('Unsupported action'));
}