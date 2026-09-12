/**
 * Nexfix POS Google Apps Script API.
 * Deploy as a Web app: Execute as Me.
 *
 * The old shared NEXFIX_API_KEY mechanism has been removed. Requests now
 * carry a Supabase user JWT from the authenticated Edge Function proxy.
 * Configure SUPABASE_URL and SUPABASE_ANON_KEY in Script Properties.
 */
var BACKUP_SHEET = 'FullBackup';
var VERSION = '2.0.0';
var SUPABASE_URL_PROPERTY = 'SUPABASE_URL';
var SUPABASE_ANON_KEY_PROPERTY = 'SUPABASE_ANON_KEY';

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

function supabaseConfig() {
  var url = String(PropertiesService.getScriptProperties().getProperty(SUPABASE_URL_PROPERTY) || '').trim().replace(/\/$/, '');
  var anonKey = String(PropertiesService.getScriptProperties().getProperty(SUPABASE_ANON_KEY_PROPERTY) || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !anonKey) throw new Error('Supabase configuration is missing from Script Properties');
  return { url: url, anonKey: anonKey };
}

function authenticateUser(accessToken) {
  if (!accessToken || String(accessToken).length < 20) return null;
  var config = supabaseConfig();
  var userResponse = UrlFetchApp.fetch(config.url + '/auth/v1/user', {
    method: 'get',
    headers: { 'apikey': config.anonKey, 'Authorization': 'Bearer ' + String(accessToken) },
    muteHttpExceptions: true
  });
  if (userResponse.getResponseCode() < 200 || userResponse.getResponseCode() >= 300) return null;

  var user;
  try { user = JSON.parse(userResponse.getContentText()); } catch (ignore) { return null; }
  if (!user || !user.id) return null;

  var membershipUrl = config.url + '/rest/v1/shop_memberships?select=role,active&user_id=eq.' + encodeURIComponent(user.id) + '&active=eq.true';
  var membershipResponse = UrlFetchApp.fetch(membershipUrl, {
    method: 'get',
    headers: { 'apikey': config.anonKey, 'Authorization': 'Bearer ' + String(accessToken) },
    muteHttpExceptions: true
  });
  if (membershipResponse.getResponseCode() < 200 || membershipResponse.getResponseCode() >= 300) return null;

  var memberships;
  try { memberships = JSON.parse(membershipResponse.getContentText()); } catch (ignore2) { return null; }
  if (!Array.isArray(memberships)) return null;
  var allowed = memberships.some(function(m) { return m && (m.role === 'admin' || m.role === 'manager') && m.active === true; });
  return allowed ? user : null;
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
    var user = authenticateUser(contents.accessToken);
    if (!user) return json(unauthorized('Valid admin/manager Supabase session required'));

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var result;
    if (contents.action === 'backupState') {
      result = ok(backupState(ss, contents));
    } else if (contents.action === 'saveData' && isAllowedDataTable(contents.table)) {
      result = ok(syncTable(ss, contents.table, contents.rows));
    } else if (contents.action === 'getLatestBackup') {
      result = ok({ action: 'getLatestBackup', backup: latestBackup(ss) });
    } else if (contents.action === 'getTable' && isAllowedDataTable(contents.table)) {
      result = ok({ action: 'getTable', table: normalizeTableName(contents.table), rows: getTable(ss, contents.table) });
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
  var p = (e && e.parameter) || {};
  if (p.action === 'ping' || !p.action) return json(ok({ message: 'Nexfix POS Sync API is running' }));
  return json(unauthorized('Authenticated POST endpoint required'));
}
