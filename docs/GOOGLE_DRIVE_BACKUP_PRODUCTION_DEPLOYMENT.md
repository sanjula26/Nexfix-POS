# Nexfix POS Google Drive Backup — Production Deployment

## Production contract

- Client expected Apps Script version: **3.3.1**
- Source of truth: `google-apps-script/Code.gs`
- Documentation copy: `docs/GoogleAppsScript_Code.gs`
- Production web-app URL must remain the centrally managed `script.google.com/macros/s/.../exec` URL already embedded in `src/lib/driveSync.ts`.
- Master Drive root: `1CQZ746hm3pTKOOx2BDVj3NEmTj82yEeK`
- Script Property: `NEXFIX_BACKUP_API_KEY`
- Optional Script Property: `ROOT_BACKUP_FOLDER_ID` (if present it must point to the same master root)
- Web app execution: **Me**
- Keep the existing web-app access setting used by the production POS.

## Required deployment after Code.gs changes

1. Open the Google Apps Script project used by the production web-app URL.
2. Replace `Code.gs` with the current repository `google-apps-script/Code.gs`.
3. Save the project.
4. Open **Deploy → Manage deployments**.
5. Edit the existing Web app deployment.
6. Select **New version** for the deployment version.
7. Keep **Execute as: Me**.
8. Keep the existing production access setting.
9. Deploy/update the deployment.
10. Confirm the deployment keeps the same `/exec` URL.
11. Open **Project Settings → Script properties** and confirm:
    - `NEXFIX_BACKUP_API_KEY` exactly matches the production build secret.
    - `ROOT_BACKUP_FOLDER_ID` is either absent (the source default is the production root) or equals `1CQZ746hm3pTKOOx2BDVj3NEmTj82yEeK`.

## Version check

Open the production `/exec?action=ping` endpoint. The response must report:

`version: "3.3.1"`

If it reports **3.2.0** (or 3.0.1), the old deployment is still active and must be updated to a new Apps Script deployment version.

## Backup success contract

A successful Drive write is authoritative. The client now checks:

1. exact `verifyBackup` using shop ID + backup ID + day key + exportedAt;
2. Drive-only `verifyRecentBackup` using the same shop/day/time window;
3. status records;
4. latest-backup fallback.

Therefore a lost/late status poll must not turn an already committed `NEXFIX_*.json` or encrypted multipart manifest into a false failure.

## Shop-folder rename contract

After an accepted backup, the Apps Script sets the shop folder to:

`Shop_<partition24> - <sanitizedShopName>`

The rename is performed only after the backup artifact has passed freshness/integrity checks. The same successful operation updates `shop.json`, `SHOP_INFO.txt`, and recovery metadata with the current shop name and Apps Script version.

## Already-installed POS verification

After deploying Apps Script 3.3.1, an already-installed POS does not need a new EXE solely because of the Apps Script change **if that installed build already contains the current driveSync.ts code**.

In the POS:

1. Go to **Settings → Data & Backup**.
2. Confirm the shop is online.
3. Click **Backup now to Google Drive**.
4. Confirm the UI says **Google Drive backup completed successfully.**
5. In Drive, open the shop folder and confirm a new `NEXFIX_<partition>_<day>.json` or `.manifest.json` exists.
6. Confirm Settings shows a new **Last cloud** timestamp and no **Last cloud error**.
7. Change the POS shop name.
8. Run another manual backup.
9. Confirm the same partition folder is renamed to `Shop_<partition> - <newName>`.
10. Confirm `shop.json` and `SHOP_INFO.txt` contain the new name and version 3.3.1.

If the installed EXE predates the current `driveSync.ts` verification logic, build/install the current POS release after the Apps Script deployment. The Apps Script redeploy is mandatory for the new server-side `verifyRecentBackup` action.
