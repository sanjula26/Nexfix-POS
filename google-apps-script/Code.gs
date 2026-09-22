/**
 * Nexfix POS direct Google Drive backup API.
 * Deploy as a Web app: Execute as Me.
 * POS calls this endpoint directly; Supabase is not required for Google Backup.
 * The supplied master Drive folder remains separate from any Google Sheet.
 */
var BACKUP_SHEET = 'FullBackup';
var VERSION = '3.1.0';
var MAX_MULTIPART_PART_BYTES = 8 * 1024 * 1024;
var SHOP_ID_MAX_LENGTH = 100;
var REQUEST_ID_MAX_LENGTH = 200;
var MAX_BACKUP_BYTES = 9 * 1024 * 1024; // Keep below DriveApp File.setContent() 10 MB limit.
var BACKUP_RATE_LIMIT = 30;
var BACKUP_RATE_WINDOW_SECONDS = 60;
var ROOT_BACKUP_FOLDER_NAME = 'Nexfix POS Backup';
var ROOT_BACKUP_FOLDER_ID_PROPERTY = 'ROOT_BACKUP_FOLDER_ID';
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
  return { ok: false, status: 'error', version: VERSION, message: String(err) };
}

function unauthorized(message) {
  return { ok: false, status: 'unauthorized', version: VERSION, message: message || 'Unauthorized' };
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

function validateEncryptedEnvelope(serialized, expectedShopId) {
  if (typeof serialized !== 'string' || !serialized) throw new Error('Encrypted backup payload is required');
  var bytes = Utilities.newBlob(serialized, 'application/json').getBytes().length;
  if (bytes > MAX_BACKUP_BYTES) throw new Error('Encrypted backup payload is too large for a single Drive file');
  var envelope;
  try { envelope = JSON.parse(serialized); } catch (err) { throw new Error('Encrypted backup payload is not valid JSON'); }
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA-256') {
    throw new Error('Unsupported encrypted backup envelope');
  }
  if (typeof envelope.ciphertext !== 'string' || !envelope.ciphertext || typeof envelope.shopId !== 'string') {
    throw new Error('Encrypted backup envelope is incomplete');
  }
  if (String(envelope.shopId) !== String(expectedShopId || '')) {
    throw new Error('Encrypted backup shop identity does not match the request');
  }
}

function validateBackupContents(contents) {
  if (!contents || typeof contents !== 'object' || Array.isArray(contents)) throw new Error('Invalid backup payload');
  if (contents.action !== 'backupState') throw new Error('Only backupState is supported by the direct Drive backup endpoint');
  var format = String(contents.format || 'legacy').trim();

  if (format === 'encrypted-single') {
    validateEncryptedEnvelope(contents.state, contents.shopId);
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
    if (!/^[A-Za-z0-9._:-]+$/.test(String(contents.backupId || ''))) throw new Error('Invalid backup id');
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
    if (!/^[A-Za-z0-9._:-]+$/.test(String(contents.backupId || ''))) throw new Error('Invalid backup id');
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
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) throw new Error('Valid backup dayKey is required');
  return value;
}

function checkBackupRateLimit(shopId, backupId, format) {
  var cache = CacheService.getScriptCache();
  var key = 'nexfix_rate_' + shopPartitionKey(shopId);
  var raw = cache.get(key);
  var now = Date.now();
  var current = null;
  try { current = raw ? JSON.parse(raw) : null; } catch (ignore) { current = null; }

  // Multipart uploads contain many parts but represent one logical backup.
  // Allow all parts for the same backupId while keeping the per-shop rate limit
  // for new logical backups.
  if (format === 'encrypted-part' && current
      && current.backupId === String(backupId || '')
      && Number(current.startedAt) > now - BACKUP_RATE_WINDOW_SECONDS * 1000) {
    return;
  }

  if (current && Number(current.startedAt) > now - BACKUP_RATE_WINDOW_SECONDS * 1000) {
    throw new Error('Backup rate limit reached. Please retry shortly.');
  }

  cache.put(key, JSON.stringify({
    startedAt: now,
    backupId: String(backupId || '')
  }), BACKUP_RATE_WINDOW_SECONDS);
}

/**
 * Convert a shop id to a stable sheet-safe partition key without exposing the
 * raw shop id in the Google spreadsheet tab name.
 */
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

function getShopBackupFolder(shopId, shopName) {
  var root = getRootBackupFolder();
  var partitionPrefix = 'Shop_' + shopPartitionKey(shopId) + ' - ';
  var desiredName = partitionPrefix + sanitizeDriveName(shopName || 'Shop');
  var folders = root.getFolders();
  while (folders.hasNext()) {
    var folder = folders.next();
    if (folder.getName().indexOf(partitionPrefix) === 0) {
      if (folder.getName() !== desiredName) {
        try { folder.setName(desiredName); } catch (ignore) {}
      }
      return folder;
    }
  }
  return root.createFolder(desiredName);
}

function writeShopMetadata(folder, shopId, shopName, encrypted) {
  var metadata = {
    app: 'Nexfix POS',
    version: VERSION,
    shopPartition: shopPartitionKey(shopId),
    shopName: sanitizeDriveName(shopName || 'Shop'),
    updatedAt: new Date().toISOString(),
    encrypted: encrypted === true
  };
  var files = folder.getFilesByName(DRIVE_METADATA_FILENAME);
  var blob = Utilities.newBlob(JSON.stringify(metadata, null, 2), 'application/json', DRIVE_METADATA_FILENAME);
  if (files.hasNext()) files.next().setContent(blob.getDataAsString());
  else folder.createFile(blob);
}

function trashDailyBackupSet(backupFolder, shopId, dayKey, keepNames) {
  var prefix = getBackupFilePrefix(shopId, dayKey);
  var files = backupFolder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (name.indexOf(prefix) !== 0) continue;
    if (keepNames && keepNames[name]) continue;
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

function backupStateToDrive(contents, shopId) {
  var format = String(contents.format || 'legacy').trim();
  var state = format === 'legacy' ? (contents.state || {}) : null;
  var shopName = String(contents.shopName || (state && state.settings && state.settings.shopName) || 'Shop');
  var shopFolder = getShopBackupFolder(shopId, shopName);
  var backupFolder = getOrCreateFolder(shopFolder, DRIVE_BACKUP_SUBFOLDER_NAME);
  var encrypted = format.indexOf('encrypted-') === 0;
  writeShopMetadata(shopFolder, shopId, shopName, encrypted);

  var now = new Date();
  var timeZone = Session.getScriptTimeZone() || 'Etc/UTC';
  var dayKey = contents.dayKey ? validateDayKey(contents.dayKey) : Utilities.formatDate(now, timeZone, 'yyyy-MM-dd');
  var partition = shopPartitionKey(shopId);

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
        encrypted: true
      },
      payload: JSON.parse(contents.state)
    };
    var serialized = JSON.stringify(envelope);
    var file = upsertDailyFile(backupFolder, fileName, serialized);
    trashDailyBackupSet(backupFolder, shopId, dayKey, (function(){ var keep={}; keep[fileName]=true; return keep; })());
    return { action: 'backupState', backupType: envelope._meta.kind, timestamp: now.toISOString(), driveFileId: file.getId(), driveFileName: file.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: partition, encrypted: true, multipart: false };
  }

  if (format === 'encrypted-part') {
    var partName = String(contents.partName);
    var partBytes = Utilities.newBlob(String(contents.chunk), 'text/plain').getBytes().length;
    if (partBytes > MAX_MULTIPART_PART_BYTES) throw new Error('Backup part exceeds Drive safety limit');
    var partFile = upsertDailyFile(backupFolder, partName, String(contents.chunk));
    return { action: 'backupState', backupType: contents.kind === 'auto' ? 'auto' : 'manual', timestamp: now.toISOString(), driveFileId: partFile.getId(), driveFileName: partFile.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: partition, encrypted: true, multipart: true };
  }

  if (format === 'encrypted-manifest') {
    var manifestName = 'NEXFIX_' + partition + '_' + dayKey + '.manifest.json';
    var partNames = contents.partNames || [];
    var totalBytes = Number(contents.totalBytes);
    var totalParts = Number(contents.totalParts);
    var totalFoundBytes = 0;
    for (var i = 0; i < partNames.length; i++) {
      var partFiles = backupFolder.getFilesByName(partNames[i]);
      if (!partFiles.hasNext()) throw new Error('Multipart part is missing: ' + partNames[i]);
      var partFile = partFiles.next();
      totalFoundBytes += partFile.getSize();
    }
    if (totalFoundBytes !== totalBytes) throw new Error('Multipart byte count does not match stored parts');
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
    var manifestFile = upsertDailyFile(backupFolder, manifestName, manifestText);
    var keep = {};
    keep[manifestName] = true;
    partNames.forEach(function(name){ keep[name] = true; });
    trashDailyBackupSet(backupFolder, shopId, dayKey, keep);
    return { action: 'backupState', backupType: manifest.kind, timestamp: now.toISOString(), driveFileId: manifestFile.getId(), driveFileName: manifestFile.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: partition, encrypted: true, multipart: true, backupId: manifest.backupId, totalParts: totalParts };
  }

  // Backward-compatible plaintext snapshot path for old clients only.
  var legacyName = 'NEXFIX_' + partition + '_' + dayKey + '.json';
  var legacyEnvelope = {
    _meta: { app: 'Nexfix POS', version: 2, exportedAt: contents.exportedAt || now.toISOString(), kind: contents.kind === 'auto' ? 'auto' : 'manual', shopId: shopId, shopPartition: partition, shopName: shopName, dayKey: dayKey, encrypted: false },
    state: state
  };
  var legacySerialized = JSON.stringify(legacyEnvelope);
  var legacyFile = upsertDailyFile(backupFolder, legacyName, legacySerialized);
  trashDailyBackupSet(backupFolder, shopId, dayKey, (function(){ var keep={}; keep[legacyName]=true; return keep; })());
  return { action: 'backupState', backupType: legacyEnvelope._meta.kind, timestamp: now.toISOString(), driveFileId: legacyFile.getId(), driveFileName: legacyFile.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: partition, encrypted: false, multipart: false };
}


function backupState(ss, contents, shopId) {
  // Drive is the primary Google backup destination; spreadsheet binding is optional.
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
            for (var mi = 0; mi < manifest.partNames.length; mi++) {
              var pf = backupFolder.getFilesByName(manifest.partNames[mi]);
              if (!pf.hasNext()) { partsOk = false; break; }
            }
            if (!partsOk) continue;
            if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) {
              latest = file;
              latestPayload = { multipart: true, manifest: manifest, shopName: manifest.shopName, timestamp: manifest.exportedAt, kind: manifest.kind, shopId: manifest.shopId, shopPartition: manifest.shopPartition };
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
              latestPayload = { state: JSON.stringify(parsed.payload), timestamp: meta.exportedAt || '', kind: meta.kind || '', shopId: meta.shopId || shopId, shopPartition: meta.shopPartition || shopPartitionKey(shopId), shopName: meta.shopName || 'Shop', encrypted: true, multipart: false };
            }
            continue;
          }

          if (!parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) continue;
          if (meta.version !== undefined && Number(meta.version) !== 2) continue;
          if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) {
            latest = file;
            latestPayload = { state: JSON.stringify(parsed.state), timestamp: meta.exportedAt || '', kind: meta.kind || '', shopId: meta.shopId || shopId, shopPartition: meta.shopPartition || shopPartitionKey(shopId), shopName: meta.shopName || (parsed.state.settings && parsed.state.settings.shopName ? String(parsed.state.settings.shopName) : 'Shop'), encrypted: false, multipart: false };
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
      var files = backupFolder.getFilesByName(safePartName);
      while (files.hasNext()) {
        var file = files.next();
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

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var contents = parsePostBody(e);
    var shopId;
    try { shopId = normalizeShopId(contents.shopId); } catch (shopError) { return json(fail('A valid shopId is required')); }
    var requestId;
    try { requestId = validateRequestId(contents.requestId); } catch (requestError) { return json(fail(requestError)); }
    try { validateBackupContents(contents); } catch (payloadError) { return json(fail(payloadError)); }

    var requestCache = CacheService.getScriptCache();
    var cacheKey = 'nexfix_req_' + shopPartitionKey(shopId) + '_' + requestId;
    var cached = requestCache.get(cacheKey);
    if (cached) {
      try { return json(JSON.parse(cached)); } catch (ignoreCached) {}
    }

    // Publish a short-lived pending marker before the Drive operation so the
    // client can distinguish "request reached Apps Script" from "request never arrived".
    try {
      requestCache.put(cacheKey, JSON.stringify({ ok: false, status: 'pending', version: VERSION, pending: true }), 120);
    } catch (ignorePendingCacheWrite) {}

    var result;
    try { checkBackupRateLimit(shopId, contents.backupId, String(contents.format || 'legacy').trim()); } catch (rateError) {
      var rateFailure = fail(rateError);
      try { requestCache.put(cacheKey, JSON.stringify(rateFailure), 120); } catch (ignoreRateCacheWrite) {}
      return json(rateFailure);
    }

    try {
      result = ok(backupStateToDrive(contents, shopId));
      try { requestCache.put(cacheKey, JSON.stringify(result), 21600); } catch (ignoreCacheWrite) {}
      return json(result);
    } catch (backupError) {
      // Cache the actual server-side failure so the POS can report it instead
      // of waiting for a generic timeout. This also makes Drive permission,
      // folder-access, and payload errors diagnosable from backupStatus.
      var backupFailure = fail(backupError);
      try { requestCache.put(cacheKey, JSON.stringify(backupFailure), 120); } catch (ignoreFailureCacheWrite) {}
      return json(backupFailure);
    }
  } catch (err) {
    return json(fail(err));
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function getCachedBackupStatus(requestId, shopId) {
  var id = String(requestId || '').trim();
  if (!id || id.length > REQUEST_ID_MAX_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(id)) return { ok: false, status: 'error', version: VERSION, message: 'Valid requestId is required' };

  var shopPartition = shopPartitionKey(shopId);
  var cacheKey = 'nexfix_req_' + shopPartition + '_' + id;
  var cached = CacheService.getScriptCache().get(cacheKey);
  if (!cached) return { ok: false, status: 'pending', version: VERSION, pending: true };

  try {
    var result = JSON.parse(cached);
    if (result && result.ok === true && result.action === 'backupState' && result.shopPartition === shopPartition) return result;
    return { ok: false, status: 'error', version: VERSION, message: 'Backup request failed' };
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
    try { normalizeShopId(p.shopId); } catch (err) {
      return json({ ok: false, status: 'error', version: VERSION, message: 'A valid shopId is required' });
    }
    var statusResult = getCachedBackupStatus(p.requestId, p.shopId);
    var statusCallback = String(p.callback || '').trim();
    if (statusCallback && /^__nexfixGoogleBackupStatus_[0-9]+_[A-Za-z0-9]+$/.test(statusCallback)) {
      return ContentService.createTextOutput(statusCallback + '(' + JSON.stringify(statusResult) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json(statusResult);
  }

  if (p.action === 'getLatestBackup') {
    var shopId;
    try { shopId = normalizeShopId(p.shopId); } catch (err) { return json({ ok: false, status: 'error', version: VERSION, message: 'A valid shopId is required' }); }
    var result = ok({ action: 'getLatestBackup', backup: latestBackup(null, shopId) });
    var callback = String(p.callback || '').trim();
    if (callback && /^__nexfixGoogleBackup_[0-9]+_[A-Za-z0-9]+$/.test(callback)) {
      return ContentService.createTextOutput(callback + '(' + JSON.stringify(result) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json(result);
  }

  if (p.action === 'getBackupPart') {
    var partShopId;
    try { partShopId = normalizeShopId(p.shopId); } catch (err) { return json({ ok: false, status: 'error', version: VERSION, message: 'A valid shopId is required' }); }
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