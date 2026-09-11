# Google Apps Script — Nexfix POS Sync

Google Sheets / Apps Script backup is an **optional operator-configured integration**. The application does not ship with a default deployment URL. This prevents the released POS from silently sending data to a deployment that the operator did not configure.

## 1. Create the script

1. Go to `script.google.com` while logged into the Google account that should own the backup.
2. **New project** → paste the approved `google-apps-script/Code.gs` implementation from this repository.
3. Create a Google Sheet and copy its ID from the URL.
4. Configure the sheet ID in the Apps Script project.
5. **Deploy → New deployment → Web app**.
   - Execute as: **Me**
   - Access: choose the minimum access required by your deployment policy.
6. Copy only the deployed `/macros/s/.../exec` Web App URL.
7. Configure that URL in the POS Google Sync settings, or provide it through `VITE_GOOGLE_SCRIPT_URL` at build/deployment time.

> Do not use a `/macros/library/d/...` library URL. The POS accepts only HTTPS `script.google.com/macros/s/.../(exec|dev)` URLs.

## 2. Important security note

The browser must be able to contact the Apps Script deployment, so a secret embedded in the frontend is **not a real secret**. Treat this integration as an optional backup transport, not as the security boundary for the POS.

For production use:

- Keep Google Sync **disabled unless explicitly configured and tested**.
- Use a dedicated backup spreadsheet/account with appropriate access controls.
- Do not put service-account keys, OAuth client secrets, or other private credentials in the Vite frontend.
- Verify that the deployed Apps Script accepts only the operations required by this POS and that the Google account/sheet permissions are appropriate.
- Test both backup and restore before relying on the integration for disaster recovery.

## 3. What the POS sends

| Event | Action | Sheet / behaviour |
|-------|--------|-------------------|
| Product create/update/delete | `saveData` → `Products` | Append JSON rows |
| Sale completed | `saveData` → `SalesHistory` + `Products` | Append |
| Customer save | `saveData` → `Customers` | Append |
| Manual / auto backup | `backupState` | `FullBackup` sheet — full JSON snapshot |

## 4. Offline behaviour

- While **offline**, local IndexedDB keeps data locally; Google calls are skipped.
- When online again, Google backup can resume if it has been explicitly enabled and a valid Web App URL is configured.
- Google backup is not the authoritative POS database. Supabase/cloud sync and the local offline queue remain separate reliability mechanisms.
