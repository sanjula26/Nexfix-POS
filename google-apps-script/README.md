# Nexfix POS Google Backup

The Google Apps Script deployment is authorized with the signed-in Supabase user. The POS browser does **not** store a shared Google API key.

## Script Properties

In the Apps Script project, open **Project Settings → Script Properties** and add:

- `SUPABASE_URL` = the Nexfix Supabase project URL
- `SUPABASE_ANON_KEY` = the project's public/anon key

These values are used by the script to validate the Supabase user JWT and check that the user has an active `admin` or `manager` membership for the **requested shop**. Do not put a service-role/secret key in the Apps Script project.

## Deployment

1. Deploy the script as a **Web app**.
2. Execute as the script owner (`Me`) so the script can write to the bound spreadsheet.
3. Keep the deployment URL in the Nexfix POS Google Sync setting.
4. After changing `Code.gs`, create a new deployment/version so the `/exec` URL serves the new code.

The POS app calls the Apps Script through the Supabase `google-backup-proxy` Edge Function. The browser sends its Supabase session and active `shopId` to that function; the Edge Function verifies the user and exact-shop membership before forwarding the user JWT to Apps Script. Apps Script independently validates the JWT and exact-shop `admin`/`manager` membership.

## Shop isolation

Every backup/table operation requires an explicit `shopId`. The Apps Script derives a deterministic SHA-256 partition key from that shop ID and stores data in a shop-specific sheet tab such as `FullBackup_<partition>` rather than a shared unscoped `FullBackup` tab.

**Do not manually rename or merge partitioned tabs.** A real two-shop backup/restore acceptance test must verify that Shop A cannot read or overwrite Shop B's partition.

## Supported actions

- `backupState` — write the complete POS backup to the active shop's partitioned `FullBackup_<partition>` sheet.
- `getLatestBackup` — read the latest backup from the active shop's partition only.
- `saveData` — synchronize an allowed application table in the active shop's partition.
- `getTable` — read an allowed application table from the active shop's partition.

Direct GET access to data endpoints is intentionally disabled. This prevents sensitive backup data from being exposed through JSONP URLs.
