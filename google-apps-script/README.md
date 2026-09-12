# Nexfix POS Google Backup

The Google Apps Script deployment is now authorized with the signed-in Supabase user. The POS browser does **not** store a shared Google API key.

## Script Properties

In the Apps Script project, open **Project Settings → Script Properties** and add:

- `SUPABASE_URL` = the Nexfix Supabase project URL
- `SUPABASE_ANON_KEY` = the project's public/anon key

These values are used by the script to validate the Supabase user JWT and check that the user has an active `admin` or `manager` membership. Do not put a service-role/secret key in the Apps Script project.

## Deployment

1. Deploy the script as a **Web app**.
2. Execute as the script owner (`Me`) so the script can write to the bound spreadsheet.
3. Keep the deployment URL in the Nexfix POS Google Sync setting.
4. After changing `Code.gs`, create a new deployment/version so the `/exec` URL serves the new code.

The POS app calls the Apps Script through the Supabase `google-backup-proxy` Edge Function. The browser sends its Supabase session to that function; the Edge Function verifies the user and forwards the user JWT to Apps Script. Apps Script then validates the JWT and the user's admin/manager membership before reading or writing backup data.

## Supported actions

- `backupState` — write the complete POS backup to `FullBackup`.
- `getLatestBackup` — read the latest `FullBackup` record.
- `saveData` — synchronize an allowed application table.
- `getTable` — read an allowed application table.

Direct GET access to data endpoints is intentionally disabled. This prevents sensitive backup data from being exposed through JSONP URLs.
