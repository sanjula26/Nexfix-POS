# Google Apps Script — Nexfix POS Sync

Your POS already points at a deployed Apps Script URL (Gmail-linked).  
If you need to **re-deploy** or create a new script, use this template.

## 1. Create the script

1. Go to [https://script.google.com](https://script.google.com) while logged into your Gmail
2. **New project** → paste the code below
3. Create a Google Sheet and copy its ID from the URL  
   `https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit`
4. Replace `YOUR_SHEET_ID` in the code
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the `/exec` URL into **Settings → Google Sheets Sync** in the POS

## 2. Script code

```javascript
const SHEET_ID = 'YOUR_SHEET_ID';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);

    if (body.action === 'backupState') {
      let sh = ss.getSheetByName('FullBackup');
      if (!sh) sh = ss.insertSheet('FullBackup');
      sh.appendRow([
        new Date().toISOString(),
        body.kind || 'manual',
        JSON.stringify(body.state),
      ]);
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'saveData') {
      const table = body.table || 'Data';
      let sh = ss.getSheetByName(table);
      if (!sh) sh = ss.insertSheet(table);
      const rows = body.rows || [];
      rows.forEach(function (row) {
        sh.appendRow([new Date().toISOString(), JSON.stringify(row)]);
      });
      return ContentService.createTextOutput(JSON.stringify({ ok: true, count: rows.length }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unknown action' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'Nexfix POS Sync' }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## 3. What the POS sends

| Event | Action | Sheet / behaviour |
|-------|--------|-------------------|
| Product create/update/delete | `saveData` → `Products` | Append JSON rows |
| Sale completed | `saveData` → `SalesHistory` + `Products` | Append |
| Customer save | `saveData` → `Customers` | Append |
| Manual / auto backup | `backupState` | `FullBackup` sheet — full JSON snapshot |

## 4. Offline behaviour

- While **offline**, local IndexedDB keeps all data; Google calls are skipped.
- When back **online**, auto-backup can push a full snapshot; live table sync resumes on next sale/product change.
