# User-selectable POS data location

Status: approved design direction; implementation not yet started.
Baseline: `main` at `81fa1507425d4446dae1ec34d689c09971e0cf47`.
Branch: `feature/user-selectable-pos-data-location`.

## Goal

Let each installed NexFix POS desktop user choose a local drive/folder for the Chromium profile that contains the POS IndexedDB database. The setting is local to that computer and must not sync through Supabase, Google Drive, shop settings or cloud backup.

Example parent folders:
- `D:\\ShopData`
- `E:\\Nexfix`
- `F:\\POS-Data`

NexFix creates and manages its own child directory (for example `NexfixPOS\\Profile`) inside the selected parent. Do not put the live database directly into an arbitrary folder containing unrelated user files.

## Architecture decision

- Use Electron's `app.setPath('sessionData', ...)` before `app.whenReady()`. Chromium sessionData includes the IndexedDB/localStorage profile and must be selected before Electron is ready.
- Keep `app.getPath('userData')` at its normal OS-managed location. Store only the selected path/configuration and migration metadata there. Keep OS-protected updater credentials and `nexfix-secure` files there; do not move/copy them with the POS profile.
- The selected location is per-PC configuration, not a shop-wide setting.
- Folder selection must use a native Electron directory picker from the main process. The renderer must never supply an arbitrary path directly to filesystem APIs.
- Expose a narrow, validated preload API through contextBridge. Require the existing trusted-renderer check on every IPC handler.
- The first choice should be a local fixed disk path. Warn against USB/removable, network shares, cloud-synced folders and drives that may be disconnected. Do not silently accept a location that is not writable or lacks adequate free space.
- A same-physical-disk partition can free space on C: but does not add physical capacity or guarantee speed. A separate SSD may improve capacity/I/O; benchmark before promising performance gains.

## Migration and rollback requirements

Changing the location is a profile migration, not merely changing a path.

1. Show current location, proposed location, estimated current profile size, destination free space and a clear warning that NexFix must restart.
2. Confirm the user has a recent verified backup. Do not proceed if a migration safety check fails.
3. Close/flush POS writes and queues, then quit/restart into a migration mode. Never copy an actively used IndexedDB profile.
4. On next launch, before `app.whenReady()`, copy the full old sessionData profile to a staging directory under the selected location. Preserve metadata and handle locked/permission-denied files as hard failures.
5. Verify copied file count/total bytes, profile marker/config and IndexedDB can be opened/read before switching the active `sessionData` path.
6. Promote the staging directory atomically where supported. Record migration completion separately from the Chromium profile.
7. Keep the old profile untouched as rollback until the new profile has been opened successfully and the user confirms the shop data is present. Never automatically delete the old profile.
8. If the target drive is missing, unmounted, read-only or inaccessible at startup, fail closed with a clear recovery screen. Do not silently create a fresh empty database, silently fall back to another profile, or overwrite the old profile.
9. Support an explicit safe “switch back to previous location” action. Handle interrupted copy/restart by resuming or cleaning only the app-owned staging directory after validation; never delete arbitrary user files.

## Settings UI

Add a dedicated **Storage Location** panel in desktop Settings:
- Current active folder (read-only display).
- **Choose folder** native picker.
- Destination free-space estimate and current profile size.
- Status: active / migration pending / needs attention.
- Change Location action that validates then schedules migration on restart.
- Restart now / restart later.
- Clear explanation that this changes only this PC's local data location; it does not change the shop identity, cloud updater, Google Drive backup destination or cloud account.
- Keep browser/dev mode read-only or show the feature as desktop-only.

## Storage health and performance

- Add `navigator.storage.estimate()` and `navigator.storage.persisted()` diagnostics. Request persistent storage once with an explanation; do not claim it is guaranteed.
- Add native free-space checks for the selected volume; browser quota is not a substitute for disk free space.
- Show warning thresholds and distinguish quota exhaustion from other IndexedDB errors.
- Never auto-delete sales, stock, repairs, customers, IMEI/serial units, backups or pending sync queue to free space.
- Record actual save/search/sale latency and realistic dataset sizes before optimizing the full-state `POSState` write pattern.
- Plan a separate versioned migration to domain-level IndexedDB stores only after baseline benchmarks and backup/restore/offline-sync regression coverage. Do not combine that schema migration with the first folder-picker change.

## Security and correctness tests

- IPC rejects untrusted renderer calls and malformed path payloads.
- Folder picker returns only a chosen directory; path traversal and arbitrary file destinations are not accepted.
- Existing userData secure updater credential files remain at their original path and are not copied to the chosen data folder.
- First-run migration, already-migrated launch, missing drive, permission denied, insufficient space, interrupted copy, corrupt/partial staging, app crash, Windows restart and rollback.
- Confirm the same shop data is visible after migration: products, sales, customers, stock, IMEI/serial units, repairs, settings, offline queue and restore checkpoint.
- Confirm backup/restore, cloud updater sign-in/device authorization, local login/roles and shop isolation are unchanged.
- Test Windows local NTFS paths, Unicode folder names, spaces, long paths, drive letters and portable/installer builds.
- Verify on real Windows machines. Hosted CI alone is not enough to declare migration safe.

## Non-goals for the first implementation

- Do not move OS-protected updater credentials, auth tokens or recovery secrets.
- Do not move Google Drive backups into the selected local profile.
- Do not store the selected path in Supabase or share it with other shops/devices.
- Do not delete the old profile automatically.
- Do not claim a different folder/partition alone makes POS faster.
- Do not restructure IndexedDB object stores in the same change.

## Acceptance criteria

- User can choose any supported local fixed-drive folder from Settings without typing a raw path.
- Existing POS data is migrated and verified without loss; previous profile remains available for rollback.
- If target storage is unavailable or migration fails, no empty shop database is presented as if it were the existing shop.
- The app starts using the selected profile after restart and displays the active location.
- Storage health is visible and quota/disk-full failures are actionable.
- Existing POS, backup, updater, local auth, offline sync and shop isolation regression suites pass.
- Windows manual QA and a recorded before/after performance baseline are completed before the feature is called production-ready.
