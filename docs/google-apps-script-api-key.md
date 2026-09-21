# Google Apps Script API Key — Legacy Note

The Nexfix POS Google backup integration no longer uses a client API key.

The current production path is:

```text
Nexfix POS
   |
   v
Google Apps Script Web App
   |
   v
Dedicated Nexfix POS Backup Google Drive folder
```

## Current configuration

- Do **not** create `NEXFIX_API_KEY` for the current `google-apps-script/Code.gs`.
- Do **not** configure `VITE_GOOGLE_SCRIPT_API_KEY`; the current client does not use it.
- Configure the Apps Script Web App to execute as the owner/operator so it can write to the dedicated Drive folder.
- Configure the master folder through `ROOT_BACKUP_FOLDER_ID` when desired; the repository also contains the supplied master folder ID as its default.
- In Nexfix POS Settings, use the deployed HTTPS `/macros/s/.../exec` URL.

## Security model

The browser cannot safely keep a secret API key, so adding a frontend key would not create a private API boundary. The current direct endpoint instead isolates backup storage by deterministic `shopId` partitions and requires `shopId` plus `requestId` for backup operations.

Because a Web App that is reachable by the browser may be publicly callable, this should not be treated as a replacement for POS authentication or Supabase RLS. Do not place service-account keys, private OAuth secrets, or other private credentials in the frontend.

## Restore safety

Google restore is destructive to the current local dataset. The POS requires explicit admin confirmation and creates a local safety checkpoint before applying the validated cloud snapshot. Cloud restore is not a multi-PC merge operation.

This file is retained only to prevent older API-key setup instructions from being mistaken for the current configuration. The authoritative guide is `google-apps-script/README.md`.
