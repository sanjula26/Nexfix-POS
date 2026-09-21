# Nexfix POS Google Backup

This Apps Script is the direct Google Drive backup transport for Nexfix POS.

**Architecture**

```text
Nexfix POS
   |
   | HTTPS backupState
   v
Google Apps Script Web App
   |
   v
Nexfix POS Backup (master Drive folder)
   |
   +-- Shop_<partition> - <shop name>
         |
         +-- shop.json
         +-- Backups
               +-- NEXFIX_<partition>_<manual|auto>_<timestamp>.json
```

Supabase is **not required for this Google backup path**. The backup spreadsheet is also **not required** and remains separate from the master Drive folder. The optional spreadsheet helper code is retained only for compatibility/future operator use.

## Master Drive folder

The current repository configuration points to the supplied master folder:

`1CQZ746hm3pTKOOx2BDVj3NEmTj82yEeK`

The script first uses the `ROOT_BACKUP_FOLDER_ID` Script Property when present; otherwise it uses the configured default ID above. If that folder cannot be accessed by the Apps Script account, the script fails instead of silently writing to another folder.

## Deployment

1. Open Google Apps Script with the Google account that should own the backups.
2. Create/open the Apps Script project.
3. Replace `Code.gs` with the approved file in this directory.
4. Save the project.
5. Deploy it as a **Web app**.
6. Set **Execute as: Me** so Drive writes use the owner's authorization.
7. Use the deployed `/macros/s/.../exec` URL in Nexfix POS.
8. After changing `Code.gs`, create/update the deployment version so the deployed `/exec` endpoint serves the new code.

The POS accepts HTTPS `script.google.com/macros/s/.../(exec|dev)` URLs, but production configuration should use the deployed `/exec` URL.

## Shop isolation

Every backup request requires a `shopId`. The script derives a deterministic SHA-256 partition from that ID.

Each shop gets its own Drive folder:

```text
Nexfix POS Backup
  +-- Shop_<partition A> - Shop A
  |     +-- shop.json
  |     +-- Backups
  +-- Shop_<partition B> - Shop B
        +-- shop.json
        +-- Backups
```

Backup files are filtered by the same shop partition, and restore reads only the matching shop partition. Do not manually rename or merge shop folders.

## Supported web actions

- `backupState` — writes a complete POS state snapshot to Drive.
- `backupStatus` — returns the server-side status for a submitted backup request.
- `getLatestBackup` — reads the newest valid Drive snapshot for the requested shop.

Direct table synchronization is not part of this direct Drive endpoint.

## Client confirmation

The browser POST uses a CORS-safe request. Because the browser cannot read a `no-cors` response body, Nexfix POS follows the POST with a JSONP `backupStatus` check. The POS reports cloud success only after Apps Script confirms that the backup request completed successfully.

## Security note

The Web App endpoint must be reachable by the POS browser. A credential embedded in the Vite frontend would not be a real secret. Therefore this endpoint should be treated as a backup transport, while POS authentication/authorization remains handled by the application. Do not place service-account keys, private OAuth secrets, or other private credentials in the frontend.

Before relying on live business data, perform a real backup and restore test for at least two separate shops and verify that each shop can only retrieve its own snapshot.
