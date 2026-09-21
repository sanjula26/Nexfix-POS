/**
 * Nexfix POS Google Apps Script API.
 * Deploy as a Web app: Execute as Me.
 *
 * Requests carry a Supabase user JWT from the authenticated Edge Function proxy.
 * Configure SUPABASE_URL and SUPABASE_ANON_KEY in Script Properties.
 *
 * Every operation is additionally bound to an explicit shopId and stored in a
 * deterministic, shop-specific sheet partition. This protects the external
 * backup store even if the Web App URL is reached without the Supabase proxy.
 */
var BACKUP_SHEET = 'FullBackup';
var VERSION = '2.1.0';
var SUPABASE_URL_PROPERTY = 'SUPABASE_URL';
var SUPABASE_ANON_KEY_PROPERTY = 'SUPABASE_ANON_KEY';
var SHOP_ID_MAX_LENGTH = 100;
var ROOT_BACKUP_FOLDER_NAME = 'Nexfix POS Backup';
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

function supabaseConfig() {
  var url = String(PropertiesService.getScriptProperties().getProperty(SUPABASE_URL_PROPERTY) || '').trim().replace(/\/$/, '');
  var anonKey = String(PropertiesService.getScriptProperties().getProperty(SUPABASE_ANON_KEY_PROPERTY) || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !anonKey) throw new Error('Supabase configuration is missing from Script Properties');
  return { url: url, anonKey: anonKey };
}

function authenticateUser(accessToken, shopId) {
  if (!accessToken || String(accessToken).length < 20) return null;
  var normalizedShopId;
  try { normalizedShopId = normalizeShopId(shopId); } catch (ignore) { return null; }

  var config = supabaseConfig();
  var userResponse = UrlFetchApp.fetch(config.url + '/auth/v1/user', {
    method: 'get',
    headers: { 'apikey': config.anonKey, 'Authorization': 'Bearer ' + String(accessToken) },
    muteHttpExceptions: true
  });
  if (userResponse.getResponseCode() < 200 || userResponse.getResponseCode() >= 300) return null;

  var user;
  try { user = JSON.parse(userResponse.getContentText()); } catch (ignore2) { return null; }
  if (!user || !user.id) return null;

  var membershipUrl = config.url + '/rest/v1/shop_memberships?select=role,active&user_id=eq.' + encodeURIComponent(user.id) + '&shop_id=eq.' + encodeURIComponent(normalizedShopId) + '&active=eq.true';
  var membershipResponse = UrlFetchApp.fetch(membershipUrl, {
    method: 'get',
    headers: { 'apikey': config.anonKey, 'Authorization': 'Bearer ' + String(accessToken) },
    muteHttpExceptions: true
  });
  if (membershipResponse.getResponseCode() < 200 || membershipResponse.getResponseCode() >= 300) return null;

  var memberships;
  try { memberships = JSON.parse(membershipResponse.getContentText()); } catch (ignore3) { return null; }
  if (!Array.isArray(memberships)) return null;
  var allowed = memberships.some(function(m) { return m && (m.role === 'admin' || m.role === 'manager') && m.active === true; });
  return allowed ? user : null;
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

function getRootBackupFolder() {
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
  var driveResult = backupStateToDrive(contents, shopId);
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
          if (meta.shopPartition && String(meta.shopPartition) !== shopPartitionKey(shopId)) continue;
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
    try { shopId = normalizeShopId(contents.shopId); } catch (shopError) { return json(unauthorized('A valid shopId is required')); }
    var user = authenticateUser(contents.accessToken, shopId);
    if (!user) return json(unauthorized('Valid admin/manager Supabase session required for this shop'));

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var result;
    if (contents.action === 'backupState') {
      result = ok(backupState(ss, contents, shopId));
    } else if (contents.action === 'saveData' && isAllowedDataTable(contents.table)) {
      result = ok(syncTable(ss, contents.table, contents.rows, shopId));
    } else if (contents.action === 'getLatestBackup') {
      result = ok({ action: 'getLatestBackup', backup: latestBackup(ss, shopId) });
    } else if (contents.action === 'getTable' && isAllowedDataTable(contents.table)) {
      result = ok({ action: 'getTable', table: normalizeTableName(contents.table), rows: getTable(ss, contents.table, shopId) });
    } else {
      return json(fail('Unsupported action or table is not allowed'));
    }
    return json(result);
  } catch (err) {
    return json(fail(err));
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
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
  if (p.action === 'ping' || !p.action) return json(ok({ message: 'Nexfix POS Sync API is running' }));
  return json(unauthorized('Authenticated POST endpoint required'));
}
