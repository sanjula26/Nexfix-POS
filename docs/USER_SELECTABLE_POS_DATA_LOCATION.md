# NexFix POS data location, recovery and performance architecture

Status: design refinement based on source review; implementation not yet started.
Baseline: `main` at `81fa1507425d4446dae1ec34d689c09971e0cf47`.
Branch: `feature/user-selectable-pos-data-location`.

## User goal

A shop owner must be able to choose where each PC stores its local NexFix data. If Windows is reinstalled and NexFix is installed again, the owner can select the old data folder and reconnect the POS to the existing shop data. If more than one old/new data folder exists, NexFix must identify and show them safely so the owner can choose the correct profile or switch between them. The POS must also become faster as the dataset grows.

This is a **data-location + disaster-recovery + profile-management + performance** feature, not just a folder picker.

## Confirmed source facts

- Electron's current `sessionData` path defaults to `userData`; Electron documents that `sessionData` contains browser storage and should be overridden before the app's `ready` event if it is to be moved. Official reference: https://www.electronjs.org/docs/latest/api/app/
- NexFix currently uses `app.getPath('userData')/nexfix-secure/cloud-updater-recovery.json` for OS-encrypted cloud/updater credentials. These files must never be copied into a movable POS data folder.
- The Supabase auth adapter in `src/lib/supabase.ts` uses Electron `safeStorage` for cloud session tokens in installed desktop builds; browser localStorage is a legacy migration fallback.
- `src/lib/backupCrypto.ts` currently stores Google Drive Recovery Key material in browser localStorage (`nexfix_backup_recovery_key_v1` and `nexfix_backup_recovery_keys_v2`). This is sensitive and must not be blindly copied into a recovered profile or written to Notion.
- The local POS session is stored in localStorage/sessionStorage (`nexfix_session_v1`). A profile reconnected after Windows reinstall must require a fresh local POS login; it must not silently restore an authenticated cashier/admin session.
- `src/lib/db.ts` currently stores the full `POSState` as one `app_state/main` IndexedDB record in `nexfix_pos_db`, plus `sync_queue` and `meta`. Each full-state save rewrites that large record. This is a likely scale/performance risk, but no benchmark has yet measured its impact.

## Core design: separate identity, location and profile

1. **Shop identity** is the logical shop and its local/cloud IDs. It must not be inferred from a drive letter or folder name.
2. **Data profile** is one complete local POS dataset: IndexedDB state, offline sync queue, restore checkpoint and only the browser storage required by NexFix.
3. **Storage location** is the physical folder on one computer. It can change from D: to E: without changing the shop or profile identity.
4. **PC configuration** stays under normal OS-managed `userData`; it records the selected profile pointer and migration state. It is not the source of truth for the shop's business records.
5. **Cloud credentials and device authorization** remain in OS-protected `userData/nexfix-secure`; they are not part of a portable data profile. After a Windows reinstall, cloud sign-in/device authorization may need to be completed again.

Suggested managed layout (illustrative; final names must be versioned and validated):

```text
E:\\ShopData\\NexfixPOS\\
  catalog.json
  Profiles\\
    <profile-id>\\
      profile.json
      ChromiumProfile\\
        IndexedDB\\
        ...Chromium session data...
      Recovery\\
        migration-receipt.json
```

The manifest contains only non-secret metadata: format version, profile UUID, created/last-clean-shutdown timestamps, app/data schema versions, a display label, and a non-reversible shop identity fingerprint where available. Never store passwords, auth tokens, Recovery Keys, raw customer/sales data, or service-role credentials in the manifest. Treat the manifest as untrusted input and validate every field.

## Windows reinstall / reconnect workflow

### Before reinstalling Windows

- The owner must first move NexFix data to a drive/folder that will not be formatted, or make a recent verified Google Drive backup and keep the required Recovery Key file separately.
- If the only copy is on C: and Windows formatting erases C:, the app cannot recover that erased data. A folder picker cannot reconstruct deleted files. Make this limitation explicit in the UI.
- Prefer an internal fixed NTFS drive or a separate SSD. A second partition on the same physical disk protects against a C: format only if the D: partition is not also formatted; it is not a backup against disk failure.

### First launch after Windows reinstall

1. The app detects that its local profile pointer is missing or points to an unavailable path and enters a **Connect existing POS data** startup flow. It must not open a new empty shop as if it were the old shop.
2. The owner selects a folder using a native folder picker. NexFix scans only that selected folder and a bounded set of known NexFix subfolders; it must not recursively crawl every drive.
3. NexFix finds supported managed profiles by their validated manifest. It can also offer an explicit **Import legacy NexFix folder** path for older versions that did not create a manifest.
4. For every candidate, show its label/shop fingerprint (masked), profile ID, last clean shutdown/last known update, app/data format version, estimated size and verification status. Timestamps are hints, not proof that a profile is the newest or complete.
5. The app validates the profile and opens it in a guarded recovery mode. It verifies that the IndexedDB database can be opened and that the expected POS state exists before enabling normal POS screens.
6. After reconnecting, require the operator's local POS login again. Cloud auth/device registration is handled separately; do not copy OS-protected cloud credentials from the old Windows installation.
7. If the profile cannot be verified, preserve it untouched and offer another candidate or the normal backup-restore path. Never silently seed an empty shop over an existing profile.

### Legacy profile import is security-sensitive

Older releases used the same default directory for Electron `userData` and `sessionData`. Therefore **never copy the entire old folder**: it may contain `nexfix-secure` and other app-owned files alongside Chromium storage.

- Build and test an explicit allowlist for the Chromium data required to recover POS IndexedDB and any necessary local metadata. Do not assume a raw recursive copy is safe.
- Legacy localStorage contains sensitive Recovery Key entries and may contain old Supabase auth-token keys. The import flow must sanitize these before any auth restoration runs; it must not migrate Recovery Keys or cloud auth tokens into the new profile. The Recovery Key must be imported by the owner from their separately kept `RECOVERY_KEY.txt` when needed for encrypted Drive backup/restore.
- Clear the persisted local POS session on profile adoption so a fresh cashier/admin login is required. Preserve business data and durable offline queue/idempotency information; explicitly test every pending-operation marker before defining the allowlist.
- Do not delete or modify the legacy source folder during import. Create a new managed profile copy, verify it, and keep the source as rollback.

## Multiple old/new folders and profile linking

A folder is a candidate profile, not an instruction to merge data.

- Provide **Find existing profile**, **Use this profile**, **Copy profile to another location**, and **Switch active profile** actions.
- Maintain a local profile catalog for known locations, but make every profile self-describing with its own manifest so it can be rediscovered after Windows reinstall when the local catalog is gone.
- If two folders have the same profile UUID, treat them as duplicate copies/clones. Compare their verified state and timestamps, show both, and let the owner choose. Never auto-merge or auto-delete one.
- If two folders have different profile UUIDs, treat them as separate datasets/shops until the owner explicitly identifies them. Allow switching between them, one active profile at a time.
- Do not run two writable POS instances against the same profile. Network shares and removable media are not supported as live databases in the first release.
- **Link does not mean live two-way synchronization.** Two folders must not both accept writes and then be merged at file level. A future business-data import/merge feature must work at the entity level with explicit duplicate/conflict rules, audit trail and preview.
- If the app finds an empty new profile plus one or more populated older profiles, the populated profiles must be highlighted and the app must not prefer the empty one automatically.

## Profile move / migration transaction

- User selects a destination parent via native picker; NexFix creates its own managed child structure.
- Check destination local fixed-disk status, writability, free space and path length. Warn for removable, network, cloud-synced or unstable paths.
- Require a recent verified backup and enough free space for source + staging + rollback copy.
- Flush POS writes and sync-queue state, close the app cleanly, and run migration before Electron emits `ready`.
- Copy to an app-owned staging folder; preserve source; do not copy `userData/nexfix-secure`, updater tokens, auth credentials or Recovery Keys.
- Verify file inventory, byte counts, manifest, IndexedDB open/read, shop identity, record counts/checksums where practical, pending queue and restore checkpoint.
- Promote staging atomically where supported; write a durable migration receipt and active-profile pointer using temp-file + fsync/rename semantics.
- Start the app against the new profile and perform a post-start verification. Keep old source as rollback until operator confirms the expected shop/data.
- Missing drive, permissions, disk-full, corrupt profile, interrupted copy or crash must fail closed. Do not silently switch to a blank database. Recovery must be restartable and idempotent.
- Never auto-delete old profiles, staging data outside the app-owned directory, backups, sales, stock, units/IMEI, repairs, customers or pending sync operations.

## Electron startup and security boundaries

- The selected `sessionData` path must be resolved and set before `app.whenReady()`; the existing `app.requestSingleInstanceLock()` continues to use stable `userData` and should not be moved with the profile.
- Because the first-run folder picker is only available after Electron is ready, a missing-profile first launch needs a dedicated bootstrap/recovery window. Save the selection to normal `userData`, quit, then relaunch so the chosen profile path is applied before `ready`.
- Use native `dialog.showOpenDialog({ properties: ['openDirectory'] })` in the main process. Renderer sends an intent, never a raw filesystem path.
- Add narrow preload methods and trusted-main-frame checks to every IPC handler. Validate real paths, reject path traversal, reject app install directories and unsafe roots, and ensure the final managed child remains inside the selected parent after resolving symlinks/junctions.
- Keep the existing `userData/nexfix-secure` file and Windows DPAPI-backed credentials in place. Reauthentication after reinstall is expected; the data folder must not become a credential transport mechanism.
- A drive-letter change is handled by selecting the folder again and reading the profile manifest; do not rely only on a saved absolute path.

## Storage health and quota handling

- Report browser storage estimate/persistence state and native volume free space separately; quota estimates are approximate and persistent storage is not guaranteed.
- Warn early at configurable usage/free-space thresholds; distinguish `QuotaExceededError`, permission errors, missing drives and general IndexedDB failures.
- Keep the existing transaction-completion durability checks. On storage failure, stop claiming that a sale/stock/repair change was saved and preserve idempotency markers for reconciliation.
- Never auto-clear IndexedDB, localStorage business markers, offline queue or historical business data to free space.

## POS speed and scale plan (separate workstream)

Moving data to D: does not automatically make NexFix faster. The current full-state `POSState` record is a concrete scaling concern. Improve performance in measured, reversible stages:

### P0 — baseline and profiling

Record dataset sizes and timings on a test copy: cold start, IndexedDB load, state save, product search, inventory list, invoice history, sale commit and sync-queue flush. Test small/medium/large datasets (for example 1k/10k/50k sales and realistic product/unit counts). Capture p50/p95 latency and memory; do not benchmark against live customer data.

### P1 — low-risk improvements without data-schema rewrite

- Find repeated full-array scans, sorting, filtering and JSON serialization in hot screens.
- Add bounded pagination/virtualized rendering to large inventory, customer, repair and invoice lists.
- Avoid recalculating dashboard totals and derived indexes on every unrelated state update.
- Debounce only non-critical search input; keep sale commit and stock updates durable and immediate.
- Cache normalized search keys and frequently used lookups with bounded invalidation.
- Keep React state updates scoped so unrelated screens do not rerender the whole POS.

### P2 — versioned incremental IndexedDB persistence

- Replace the single `app_state/main` rewrite with versioned domain records/stores in small migrations.
- Write only changed entities/slices; use IndexedDB indexes and cursor/range queries for paged history.
- Keep sale header/lines, stock, IMEI/serial units, customer balance, pending cloud marker and sync-queue operations transactionally consistent.
- Preserve schema upgrade rollback/export checks, old-version recovery and backup/restore compatibility. Do not ship a schema migration until fixtures and regression tests cover old databases.

### P3 — domain-specific query and UI architecture

- Load only the rows needed for the active screen; do not load every historical invoice into memory for a paged history screen.
- Use indexed product/IMEI/customer lookup and bounded result sets.
- Move expensive non-critical reporting/aggregation off the sale-commit path; cache aggregates with revision/version invalidation.
- Keep offline-first operation, branch isolation, audit history and deterministic sync behavior.

### Performance acceptance

Set explicit targets only after P0 baseline. Compare p50/p95 cold start, product search, invoice paging, sale commit and state-save times before/after on the same hardware and dataset. A speed change is accepted only if it does not regress durability, backup/restore, offline sync, shop/branch isolation or security.

## UI requirements

Desktop Settings / startup should expose:
- Current active profile and folder path.
- Choose a new folder / move current profile.
- Connect existing profile after reinstall.
- List of discovered profiles with verification status and last known activity.
- Switch active profile; copy profile to another folder.
- Space used/free and storage health.
- Clear warnings for backup requirement, drive reliability, restart and fresh login.
- Explicit status for active / pending migration / recovery needed / duplicate copy / unsupported legacy profile.
- Browser/dev mode remains read-only for these desktop-only operations.

## Test matrix

- Fresh install with no profile; user chooses a folder; restart; app creates exactly one profile.
- Windows format/reinstall with external data drive intact; reconnect and recover same products, sales, customers, stock, IMEI/serial units, repairs, settings, sync queue and restore checkpoint.
- C: to D: move, D: to E: drive-letter change, Unicode/spaces/long paths, destination already contains unrelated files.
- Multiple profiles: same UUID duplicate copies, different UUID profiles, empty new profile beside populated old profile, switch active, no implicit merge.
- Legacy userData/sessionData import proves `nexfix-secure`, updater credentials, Recovery Keys, cloud auth tokens and local login session are not copied; pending operation markers remain correct.
- Missing drive, read-only folder, permission denial, insufficient space, locked files, partial copy, corrupt IndexedDB, crash at every migration phase, restart/retry, rollback.
- IPC trust/path traversal/symlink/junction checks; renderer cannot read arbitrary files.
- Backup/restore, Google Drive Recovery Key import, cloud sign-in/device registration, local roles/login, offline sales, sync queue, branch stock, updater and shop isolation.
- Real Windows installer and portable builds; hosted CI alone is insufficient.
- Performance P0-P3 benchmark and regression matrix on a non-production copy.

## Non-goals / safety rules

- No automatic raw database merge between folders.
- No live POS database on USB/network/cloud-synced storage in the first release.
- No moving cloud/updater credentials or copying Recovery Keys as part of profile migration.
- No automatic deletion of old profile or business data.
- No claim that a different folder/partition alone improves speed.
- No production database, Supabase, Google Drive, R2, release or customer-data changes as part of this design step.

## Acceptance criteria

- Each PC can select its own supported local data folder.
- After Windows reinstall, a user can select a preserved old folder and recover the same shop data without recreating the shop or overwriting it.
- Multiple old/new folders are discovered and presented clearly; one active profile at a time; no raw merge.
- Legacy import is allowlisted and secret-sanitized; fresh local login is required.
- Migration is verified, restartable and rollback-safe; missing storage never opens an empty replacement database.
- Active path/profile and storage health are visible.
- Performance is measured and improved in separate versioned steps with p50/p95 evidence.
- POS, local auth, updater, backup/restore, offline queue, branch isolation and shop isolation regression tests pass before production release.
