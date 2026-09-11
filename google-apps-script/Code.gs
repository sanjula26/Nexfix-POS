/** Nexfix POS Google Apps Script API. Deploy as Web app: Execute as Me. */
var BACKUP_SHEET = 'FullBackup';
var VERSION = '1.3.1';
var STATUS_PREFIX = 'nexfix_backup_status_';
var API_KEY_PROPERTY = 'NEXFIX_API_KEY';

// Only these application-owned sheets may be accessed through the generic
// table API. FullBackup is deliberately excluded because it contains the
// complete POS state and is handled only by the admin/manager backup flow.
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

function respond(payload, callback) {
  if (callback) {
    var safe = String(callback).replace(/[^a-zA-Z0-9_.$]/g, '');
    return ContentService.createTextOutput(safe + '(' + JSON.stringify(payload) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json(payload);
}

function ok(extra) {
  var out = { ok: true, status: 'success', version: VERSION };
  if (extra) Object.keys(extra).forEach(function(k) { out[k] = extra[k]; });
  return out;
}

function fail(err) {
  return { ok: false, status: 'error', version: VERSION, message: String(err) };
}

function unauthorized() {
  return { ok: false, status: 'unauthorized', version: VERSION, message: 'Unauthorized' };
}

function value(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : v;
}

function remember(requestId, result) {
  if (!requestId) return;
  PropertiesService.getScriptProperties().setProperty(
    STATUS_PREFIX + requestId,
    JSON.stringify({ savedAt: new Date().toISOString(), result: result })
  );
}

function expectedApiKey() {
  return String(PropertiesService.getScriptProperties().getProperty(API_KEY_PROPERTY) || '').trim();
}

function isAuthorized(provided) {
  var expected = expectedApiKey();
  if (!expected || !provided) return false;
  return String(provided) === expected;
}

function normalizeTableName(table) {
  return String(table || '').trim();
}

function isAllowedDataTable(table) {
  var normalized = normalizeTableName(table);
  return normalized && ALLOWED_DATA_TABLES[normalized.toLowerCase()] === true;
}

function syncTable(ss, table, rows) {
  if (!isAllowedDataTable(table)) throw new Error('Table is not allowed');
  var safeTable = normalizeTableName(table);
  var sheet = ss.getSheetByName(safeTable) || ss.insertSheet(safeTable);
  rows = Array.isArray(rows) ? rows : [];
  if (!rows.length) return { table: safeTable, rows: 0 };

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
  return { table: safeTable, rows: rows.length };
}

function backupState(ss, contents) {
  var sheet = ss.getSheetByName(BACKUP_SHEET) || ss.insertSheet(BACKUP_SHEET);
  var state = contents.state || {};
  var now = new Date();
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 4).setValues([['Timestamp', 'BackupType', 'Version', 'StateJSON']]);
  sheet.getRange(2, 1, 1, 4).setValues([[now, contents.kind || 'manual', VERSION, JSON.stringify(state)]]);
  return { action: 'backupState', backupType: contents.kind || 'manual', timestamp: now.toISOString(), sheet: BACKUP_SHEET };
}

function latestBackup(ss) {
  var sheet = ss.getSheetByName(BACKUP_SHEET);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 4) return null;
  var values = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(4, sheet.getLastColumn())).getValues();
  var headers = values[0];
  var timestampIndex = headers.indexOf('Timestamp');
  var typeIndex = headers.indexOf('BackupType');
  var versionIndex = headers.indexOf('Version');
  var stateIndex = headers.indexOf('StateJSON');
  if (stateIndex < 0) return null;
  var row = values[values.length - 1];
  var raw = row[stateIndex];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return {
    timestamp: timestampIndex >= 0 ? row[timestampIndex] : '',
    backupType: typeIndex >= 0 ? row[typeIndex] : '',
    version: versionIndex >= 0 ? row[versionIndex] : VERSION,
    state: String(raw)
  };
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var requestId = '';
  try {
    lock.waitLock(30000);
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
    var contents;
    if (e && e.parameter && e.parameter.payload) {
      contents = JSON.parse(e.parameter.payload);
    } else {
      contents = JSON.parse(raw);
    }
    requestId = contents.requestId || '';
    if (!isAuthorized(contents.apiKey)) {
      var denied = unauthorized();
      remember(requestId, denied);
      return json(denied);
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var result;
    if (contents.action === 'backupState') {
      result = ok(backupState(ss, contents));
    } else if (contents.action === 'saveData' && isAllowedDataTable(contents.table)) {
      result = ok(syncTable(ss, contents.table, contents.rows));
    } else {
      throw new Error('Unsupported action or table is not allowed');
    }
    remember(requestId, result);
    return json(result);
  } catch (err) {
    var result = fail(err);
    remember(requestId, result);
    return json(result);
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function getTable(ss, table) {
  if (!isAllowedDataTable(table)) throw new Error('Table is not allowed');
  var safeTable = normalizeTableName(table);
  var sheet = ss.getSheetByName(safeTable);
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
  try {
    var p = (e && e.parameter) || {};
    var callback = p.callback || '';
    if (p.action === 'ping' || !p.action) return respond(ok({ message: 'Nexfix POS Sync API is running' }), callback);
    if (p.action === 'backupStatus') {
      if (!isAuthorized(p.apiKey)) return respond(unauthorized(), callback);
      var raw = PropertiesService.getScriptProperties().getProperty(STATUS_PREFIX + (p.requestId || ''));
      if (!raw) return respond({ ok: false, status: 'pending', version: VERSION }, callback);
      var stored = JSON.parse(raw);
      return respond(stored.result, callback);
    }
    if (p.action === 'getLatestBackup') {
      if (!isAuthorized(p.apiKey)) return respond(unauthorized(), callback);
      var backup = latestBackup(SpreadsheetApp.getActiveSpreadsheet());
      if (!backup) return respond(ok({ action: 'getLatestBackup', backup: null }), callback);
      return respond(ok({ action: 'getLatestBackup', backup: backup }), callback);
    }
    if (p.action === 'getTable' && isAllowedDataTable(p.table)) {
      if (!isAuthorized(p.apiKey)) return respond(unauthorized(), callback);
      return respond(ok({ action: 'getTable', table: normalizeTableName(p.table), rows: getTable(SpreadsheetApp.getActiveSpreadsheet(), p.table) }), callback);
    }
    return respond(fail('Unknown GET action or table is not allowed'), callback);
  } catch (err) {
    return respond(fail(err), (e && e.parameter && e.parameter.callback) || '');
  }
}