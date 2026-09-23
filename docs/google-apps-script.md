# Google Apps Script — Nexfix POS Direct Drive Backup

Google Drive backup is centrally configured in the released POS build:

```text
Nexfix POS -> Google Apps Script Web App -> dedicated Google Drive folder
```

This direct backup path does **not** require Supabase, and the backup Google Sheet is **separate** from the Drive folder. A Google Sheet is not required for the direct Drive backup.

## 1. Configure the Apps Script

1. Open Google Apps Script using the Google account that should own the backups.
2. Create or open the Apps Script project.
3. Paste the approved `google-apps-script/Code.gs` from this repository.
4. Save it.
5. The repository already contains the master Drive folder ID:
   `1CQZ746hm3pTKOOx2BDVj3NEmTj82yEeK`
6. Set Script Property `NEXFIX_BACKUP_API_KEY` to a long random value and keep it private in Apps Script. The released POS build must use the same value as `VITE_GOOGLE_BACKUP_API_KEY`.
7. Optionally set Script Property `ROOT_BACKUP_FOLDER_ID` to that folder ID. If the property is absent, the code uses the configured default ID.
8. Deploy as **Web app**:
   - **Execute as:** Me
   - **Who has access:** choose an access setting that allows the POS browser to reach the deployment. For a direct browser deployment this is commonly **Anyone**, subject to the Google account's deployment policy.
9. Copy the deployed **`/macros/s/.../exec`** URL.

After changing `Code.gs`, update/create the deployment version. Editing the GitHub file alone does not update an already deployed Apps Script Web App.

## 2. Nexfix POS endpoint configuration

The released POS build contains the central `/exec` endpoint and the matching transport API key. Shop users do **not** enter, save, or toggle the Apps Script URL or API key in Settings.

The `/exec` URL is only updated in the application source when the central Apps Script deployment changes. After changing the deployment, the released POS build must be rebuilt/redeployed with the new endpoint.

The POS sends the complete sanitized POS backup directly to Apps Script. The server writes it under the matching shop folder.

## 3. Drive folder structure

The supplied master folder remains the top-level destination:

```text
Nexfix POS Backup
  +-- Shop_<partition> - <shop name>
        +-- shop.json
        +-- Backups
              +-- NEXFIX_<partition>_manual_<timestamp>.json
              +-- NEXFIX_<partition>_auto_<timestamp>.json
```

The Google Sheet is separate and is not placed inside this folder by the direct backup implementation.

## 4. Shop isolation

The POS sends an explicit `shopId`. Apps Script derives a SHA-256 partition key and uses it for the shop folder and backup filename.

On restore, Apps Script scans only the matching shop folder/partition and validates the stored `shopPartition` and `shopId` metadata when present.

Do not manually rename or merge shop folders.

## 5. Backup confirmation

A successful POS cloud backup means:

1. POS submitted the backup request.
2. Apps Script accepted and processed the request.
3. Apps Script cached a success result for that request.
4. POS confirmed the result through `backupStatus`.

If confirmation times out or the server reports an error, POS does not mark the cloud backup as successful.

## 6. Automatic backup

Automatic/reconnect backups are cloud-only; they do not download JSON files to the computer.

The scheduler requires:

- The released POS build has the centrally configured Apps Script endpoint.
- The device is online when a cloud backup is attempted.
- Browser online connectivity.
- A configured auto-backup interval.

If a cloud backup fails, POS keeps a durable pending marker and retries.

## 7. Restore

The admin can use **Restore latest Google backup** in Settings.

The POS:

1. Reads the newest shop-specific snapshot.
2. Validates the backup structure.
3. Creates a local safety checkpoint.
4. Replaces the local POS dataset only after confirmation.

Current local authentication/security data is preserved by the restore flow rather than being replaced by the cloud snapshot.

## 8. Important security note

The browser must be able to reach the Web App. Do not put a private service-account key or OAuth client secret in the Vite frontend.

The direct endpoint is intentionally a backup transport, not a replacement for the POS application's own authentication system. Test the complete backup/restore flow with separate shop IDs before using it for live business data.
