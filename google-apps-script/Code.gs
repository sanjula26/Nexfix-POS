/**
 * Nexfix POS direct Google Drive backup API.
 * Deploy as a Web app: Execute as Me.
 * POS calls this endpoint directly; Supabase is not required for Google Backup.
 * The supplied master Drive folder remains separate from any Google Sheet.
 */
var BACKUP_SHEET = 'FullBackup';
var VERSION = '3.0.1';
var SHOP_ID_MAX_LENGTH = 100;
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
  var configured = normalizeDriveFolderId(
    PropertiesService.getScriptProperties().getProperty(ROOT_BACKUP_FOLDER_ID_PROPERTY) || DEFAULT_ROOT_BACKUP_FOLDER_ID
  );
  if (configured) {
    try {
      return DriveApp.getFolderById(configured);
    } catch (ignore) {
      throw new Error('Configured ROOT_BACKUP_FOLDER_ID cannot be accessed by the Apps Script account');
    }
  }
  var folders = DriveApp.getFoldersByName(ROOT_BACKUP_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(ROOT_BACKUP_FOLDER_NAME);
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

function writeShopMetadata(folder, shopId, state) {
  var metadata = {
    app: 'Nexfix POS',
    version: VERSION,
    shopId: shopId,
    shopPartition: shopPartitionKey(shopId),
    shopName: state && state.settings && state.settings.shopName ? String(state.settings.shopName) : 'Shop',
    updatedAt: new Date().toISOString()
  };
  var files = folder.getFilesByName(DRIVE_METADATA_FILENAME);
  var blob = Utilities.newBlob(JSON.stringify(metadata, null, 2), 'application/json', DRIVE_METADATA_FILENAME);
  if (files.hasNext()) files.next().setContent(blob.getDataAsString());
  else folder.createFile(blob);
}

function backupStateToDrive(contents, shopId) {
  var state = contents.state || {};
  var shopName = state && state.settings && state.settings.shopName ? String(state.settings.shopName) : 'Shop';
  var shopFolder = getShopBackupFolder(shopId, shopName);
  var backupFolder = getOrCreateFolder(shopFolder, DRIVE_BACKUP_SUBFOLDER_NAME);
  writeShopMetadata(shopFolder, shopId, state);
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd_HH-mm-ss_SSS');
  var kind = contents.kind === 'auto' ? 'auto' : 'manual';
  var fileName = 'NEXFIX_' + shopPartitionKey(shopId) + '_' + kind + '_' + stamp + '.json';
  var envelope = {
    _meta: { app: 'Nexfix POS', version: 2, exportedAt: contents.exportedAt || now.toISOString(), kind: kind, shopId: shopId, shopPartition: shopPartitionKey(shopId), shopName: shopName },
    state: state
  };
  var file = backupFolder.createFile(Utilities.newBlob(JSON.stringify(envelope), 'application/json', fileName));
  return { action: 'backupState', backupType: kind, timestamp: now.toISOString(), driveFileId: file.getId(), driveFileName: file.getName(), shopFolder: shopFolder.getName(), backupFolder: backupFolder.getName(), shopPartition: shopPartitionKey(shopId) };
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

  // Scan every matching shop folder so backups created before the folder-stability
  // fix are still discoverable. The shop partition, not the folder name, remains
  // the authoritative shop-isolation key.
  while (shopFolders.hasNext()) {
    var shopFolder = shopFolders.next();
    if (shopFolder.getName().indexOf(shopFolderPrefix) !== 0) continue;

    var backups = shopFolder.getFoldersByName(DRIVE_BACKUP_SUBFOLDER_NAME);
    while (backups.hasNext()) {
      var backupFolder = backups.next();
      var files = backupFolder.getFiles();
      while (files.hasNext()) {
        var file = files.next();
        if (file.getMimeType() !== 'application/json' || file.getName().indexOf(partitionPrefix) !== 0) continue;
        try {
          var parsed = JSON.parse(file.getBlob().getDataAsString());
          var meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed._meta || {}) : {};
          var state = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.state : null;
          if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
          // Accept only Nexfix POS v2 snapshots. The shop partition and optional
          // shopId must also match the authenticated shop requesting the restore.
          if (meta.app && String(meta.app) !== 'Nexfix POS') continue;
          if (meta.version !== undefined && Number(meta.version) !== 2) continue;
          if (meta.shopPartition && String(meta.shopPartition) !== shopPartitionKey(shopId)) continue;
          if (meta.shopId && String(meta.shopId) !== String(shopId)) continue;
          if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) {
            latest = file;
            latestPayload = parsed;
          }
        } catch (ignore) {
          // Ignore a malformed/incomplete Drive file and continue with older valid backups.
        }
      }
    }
  }
  return latestPayload;
}

function latestBackup(ss, shopId) {
  var driveBackup = latestDriveBackup(shopId);
  if (driveBackup && driveBackup.state) {
    var meta = driveBackup._meta || {};
    return { timestamp: meta.exportedAt || '', backupType: meta.kind || '', version: VERSION, state: JSON.stringify(driveBackup.state) };
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
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return {
    timestamp: timestampIndex >= 0 ? row[timestampIndex] : '',
    backupType: typeIndex >= 0 ? row[typeIndex] : '',
    version: versionIndex >= 0 ? row[versionIndex] : VERSION,
    state: String(raw)
  };
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
    var requestId = String(contents.requestId || '').trim();
    if (!requestId || requestId.length > 200) return json(fail('Valid requestId is required'));

    var requestCache = CacheService.getScriptCache();
    var cached = requestCache.get('nexfix_req_' + requestId);
    if (cached) {
      try { return json(JSON.parse(cached)); } catch (ignoreCached) {}
    }

    var result;
    if (contents.action === 'backupState') {
      result = ok(backupState(null, contents, shopId));
    } else {
      return json(fail('Only backupState is supported by the direct Drive backup endpoint'));
    }

    try { requestCache.put('nexfix_req_' + requestId, JSON.stringify(result), 21600); } catch (ignoreCacheWrite) {}
    return json(result);
  } catch (err) {
    return json(fail(err));
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function getCachedBackupStatus(requestId, shopId) {
  var id = String(requestId || '').trim();
  if (!id || id.length > 200) return { ok: false, status: 'error', version: VERSION, message: 'Valid requestId is required' };

  var cached = CacheService.getScriptCache().get('nexfix_req_' + id);
  if (!cached) return { ok: false, status: 'pending', version: VERSION, pending: true };

  try {
    var result = JSON.parse(cached);
    if (result && result.ok === true && result.action === 'backupState') return result;
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
    if (statusCallback && /^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(statusCallback)) {
      return ContentService.createTextOutput(statusCallback + '(' + JSON.stringify(statusResult) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json(statusResult);
  }

  if (p.action === 'getLatestBackup') {
    var shopId;
    try { shopId = normalizeShopId(p.shopId); } catch (err) { return json({ ok: false, status: 'error', version: VERSION, message: 'A valid shopId is required' }); }
    var result = ok({ action: 'getLatestBackup', backup: latestBackup(null, shopId) });
    var callback = String(p.callback || '').trim();
    if (callback && /^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(callback)) {
      return ContentService.createTextOutput(callback + '(' + JSON.stringify(result) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json(result);
  }

  return json(unauthorized('Unsupported action'));
}
