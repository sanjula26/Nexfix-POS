# Google Apps Script — Nexfix POS Sync

Google Sheets / Apps Script backup is an **optional operator-configured integration**. The application does not ship with a default deployment URL. This prevents the released POS from silently sending data to a deployment that the operator did not configure.

## 1. Create the script

1. Go to `script.google.com` while logged into the Google account that should own the backup.
2. **New project** → paste the approved `google-apps-script/Code.gs` implementation from this repository.
3. Create a Google Sheet and bind the Apps Script project to that spreadsheet.
4. In **Project Settings → Script Properties**, configure `SUPABASE_URL` and the public `SUPABASE_ANON_KEY`.
5. **Deploy → New deployment → Web app**.
   - Execute as: **Me**
   - Access: choose the minimum access required by your deployment policy.
6. Copy only the deployed `/macros/s/.../exec` Web App URL.
7. Configure that URL in the POS Google Sync settings, or provide it through `VITE_GOOGLE_SCRIPT_URL` at build/deployment time.

> Do not use a `/macros/library/d/...` library URL. The POS accepts only HTTPS `script.google.com/macros/s/.../(exec|dev)` URLs.

## 2. Security and shop isolation

The browser must be able to contact the Apps Script deployment, so a secret embedded in the frontend is **not a real secret**. Treat this integration as an optional backup transport, not as the security boundary for the POS.

For production use:

- Keep Google Sync **disabled unless explicitly configured and tested**.
- Use a dedicated backup spreadsheet/account with appropriate access controls.
- Do not put service-account keys, OAuth client secrets, or other private credentials in the Vite frontend or Apps Script properties.
- The Apps Script requires an explicit `shopId` and validates the signed-in Supabase JWT against an active `admin`/`manager` membership for that exact shop.
- Backup and table data are stored in deterministic shop-specific sheet partitions (`<table>_<partition>`); there is no shared unscoped `FullBackup` data sheet.
- Do not manually rename or merge shop partitions.
- Test two separate shops and verify that each shop can only read/write its own partition before relying on the integration for disaster recovery.

## 3. What the POS sends

| Event | Action | Sheet / behaviour |
|-------|--------|-------------------|
| Product create/update/delete | `saveData` → `Products` | Active-shop partition |
| Sale completed | `saveData` → `SalesHistory` + `Products` | Active-shop partition |
| Customer save | `saveData` → `Customers` | Active-shop partition |
| Manual / auto backup | `backupState` | `FullBackup_<shop-partition>` full JSON snapshot |

## 4. Offline behaviour

- While **offline**, local IndexedDB keeps data locally; Google calls are skipped.
- When online again, Google backup can resume if it has been explicitly enabled and a valid Web App URL is configured.
- Google backup is not the authoritative POS database. Supabase/cloud sync and the local offline queue remain separate reliability mechanisms.
- A real backup/restore drill with a deployed Apps Script and Google account remains required before storing live business data.
