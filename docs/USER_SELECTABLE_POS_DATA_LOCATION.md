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


## Initial POS performance source review — 2026-11-20

This is static source inspection on `main` at `81fa1507425d4446dae1ec34d689c09971e0cf47`; it is not a runtime benchmark.

- `src/pages/POS.tsx` (around lines 198–260): product search/suggestions repeatedly filter the full product array; favorites scan all sales and then repeatedly find products for sale lines; bundle suggestions scan the full product catalog. This can become noticeable as products and sales grow.
- `src/pages/Inventory.tsx` (around lines 134–163, 203, 229–230): inventory filtering/sorting and stock summaries scan the full product list; IMEI/serial duplicate checks build sets from all units; cost history scans all received purchases and GRNs. These are candidates for indexed lookups and memoized/derived indexes.
- `src/pages/SalesHistory.tsx` (around lines 30–48, 150): the page derives cashier choices and sorts/filters the full sales history before rendering only a limited slice. Pagination at render time does not avoid the initial full-history scan/sort.
- `src/pages/Dashboard.tsx` (around lines 27–54): dashboard metrics repeatedly scan sales, expenses, products, repairs and units. Aggregates should be cached by data revision or computed from indexed summaries rather than recomputed across all history.
- `src/pages/Customers.tsx` (around lines 22–30, 97–120): customer lists and selected-customer purchase/ledger views scan sales history. A customer/date index and bounded history queries would scale better.
- `src/pages/Repairs.tsx` (around lines 38–54): available parts and repair status counts scan products/jobs; status counts currently filter the jobs array once per status.
- `src/lib/store.tsx`: product/customer/supplier mutations frequently map/filter whole arrays, and the state persistence layer writes the full POS state. This compounds the cost of a large in-memory state.

### Safe optimization order

1. Add a reproducible non-production benchmark harness before changing algorithms.
2. Build memoized ID maps and normalized search indexes from existing state, with revision-based invalidation and regression tests.
3. Replace repeated full-array scans in POS/Inventory/Repairs/Dashboard with shared selectors and precomputed counts where correctness is preserved.
4. Add real pagination/query boundaries to Sales History and Customer History; a UI slice after sorting the full array is not sufficient.
5. Introduce virtualized rendering only where measured DOM/render cost is material.
6. Migrate persistence to incremental IndexedDB domain records only after the benchmark and backup/restore/offline-sync test fixtures are ready.

Do not apply speculative micro-optimizations or change sale/stock transaction ordering merely to improve a benchmark. Sale commit durability and correctness take priority over raw speed.

## Automatic saving to the selected data location — explicit requirement — 2026-11-20

The selected profile is the live authoritative local POS storage location. The owner must not need to press a Save button for normal POS work. All supported changes are automatically persisted to the currently active profile.

### Current behavior confirmed in main (source review)

- `src/lib/db.ts` exposes `idbSaveState`, which waits for the IndexedDB transaction's `complete` event before returning success.
- `src/lib/store.tsx` schedules a debounced state persistence 120 ms after React state changes and writes the full state to IndexedDB. A successful IndexedDB write is authoritative; localStorage is not intended to hold a second full copy.
- When the IndexedDB write fails, the store emits `nexfix:storage-error` and deliberately skips enqueueing a stale offline snapshot. This is a useful safety behavior to preserve.
- The current debounce is not proof that every last in-memory change survives an immediate process kill or power loss. The app needs an explicit dirty/write-in-flight lifecycle and stronger durability handling around critical operations and shutdown.

### Required automatic-save behavior

1. On startup, resolve the active profile before loading POS state. Do not render a fresh seeded shop if an existing profile is missing, disconnected, corrupt or not yet verified.
2. Every POS mutation (sale, return, stock, product, customer, supplier, GRN, unit/IMEI/serial, repair, warranty, quotation, exchange, expenses, settings, user/role changes and durable audit/sync markers) must be persisted automatically to the active profile. No per-record Save button is required for routine operations.
3. Critical business actions must resolve only after their required IndexedDB transaction(s) have completed. For sales, stock and other multi-record operations, commit related records and idempotency/sync markers atomically where the schema supports it. A React state update or a debounce timer firing is not proof of durable save.
4. For ordinary edits, debounce/coalesce safe batches to reduce write amplification, but show an unsaved/dirty state while a write is pending. Critical commits must flush or use their own durable transaction and must not wait behind a long debounce.
5. Track a monotonic local revision, last durable revision/time, pending write count and last storage error. On a write failure, retain the dirty revision, show a persistent visible warning, block unsafe follow-up actions where necessary, and retry only with bounded backoff when storage becomes writable. Never clear the error just because a later unrelated React render occurs.
6. On app close/restart, flush pending writes and wait for completion where Electron lifecycle permits. Do not rely on browser `beforeunload` alone for asynchronous IndexedDB durability. Add an explicit Electron shutdown handshake: renderer reports flush status; main process waits with a bounded timeout and does not silently claim success if flush failed. Handle OS kill/power loss with transaction durability and startup recovery; no software can guarantee the last uncommitted in-memory keystroke after sudden power loss.
7. When the selected drive is missing, read-only or full, stop claiming local save success. Keep the source profile untouched, show the exact active path and error, and offer safe reconnect/recovery. Do not silently switch to a new empty folder or write into another drive behind the user's back.
8. Auto-save is local durability, not the same as Google Drive backup or cloud sync. Keep separate indicators/timestamps for local saved, cloud sync pending/synced, and external backup last successful. Never imply that local auto-save protects against disk failure or Windows formatting.
9. After a profile move or Windows reinstall reconnect, all future automatic writes must go to the selected active profile. The app must display the active folder and profile identity so the owner can confirm where data is being saved.

### User-visible status

- `Saved on this PC` with last durable save time.
- `Saving…` while a revision is pending.
- `Save failed — check drive/storage` with actionable reason and active path.
- Separate `Cloud sync pending/synced` and `Google Drive backup` status.
- Storage location and profile health shown in Settings.

### Required tests

- Change each important business domain and verify the durable IndexedDB value after reload/restart.
- Immediate close while debounce is pending; verify shutdown handshake flushes or clearly reports failure.
- Disk full, QuotaExceededError, missing drive, read-only folder, permission denial and database blocked/abort.
- Multiple rapid updates coalesce without losing the newest revision.
- Sale commit + cloud commit + local persist failure: verify idempotency marker remains and no duplicate bill can be created on retry.
- Crash/restart with pending offline queue; verify queue and business state reconcile without data loss/duplication.
- Profile switch/migration: verify subsequent auto-saves go only to the selected profile.
- Verify cloud backup status is never confused with local auto-save status.

### Status

This section is an explicit product requirement and architecture plan. Current source already has a 120 ms debounced IndexedDB auto-persist path, but it does not yet prove all shutdown/crash/drive-failure cases. No code change, test run or runtime durability claim is made by this documentation update.

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


## Profile data encryption and folder access security

### Security goal and honest limitation

Protect a copied or stolen profile folder from offline reading, restrict ordinary Windows accounts from opening the live folder, detect ciphertext tampering, and allow the owner to recover the same encrypted profile after Windows reinstall. No software can guarantee a 0% compromise probability. Encryption does not protect plaintext while an authorized POS process is running on a compromised Windows account, nor does it stop a malicious administrator, keylogger, remote-control malware or someone who has both the encrypted folder and its recovery key.

### Required layered controls

1. **Application-level authenticated encryption for business data**
   - Encrypt all business payloads before writing them to IndexedDB: main POS state, sync/offline queue payloads, pending idempotency markers, restore checkpoints and any future domain stores.
   - Use a random 256-bit Data Encryption Key (DEK) generated by the OS cryptographic random generator.
   - Use AES-256-GCM with a fresh random 96-bit nonce for every encryption operation and a 128-bit authentication tag. Never reuse a nonce with the same DEK.
   - Bind each ciphertext to profile UUID, store/purpose, schema version and monotonic data revision using authenticated additional data (AAD). Reject wrong-profile, wrong-purpose, invalid-tag, unsupported-version and malformed ciphertext without falling back to plaintext or seeding an empty shop.
   - Keep the DEK in the Electron main process only. Renderer code may request narrowly scoped encrypt/decrypt operations through trusted, validated IPC; never send the raw DEK to React/renderer code or write it to IndexedDB, localStorage, logs, crash reports or the manifest.
   - The current `electron/profile-crypto.cjs` is a cryptographic primitive/test foundation only. It is not yet wired into IndexedDB or the running POS. No current shop data is encrypted by this change.

2. **Two independent ways to protect/recover the DEK**
   - Wrap the DEK using Electron `safeStorage` (Windows DPAPI on Windows) for normal automatic unlock by the same Windows user account.
   - Separately wrap the same DEK using a distinct, randomly generated 256-bit **POS Data Recovery Key**. This key is different from the existing Google Drive backup Recovery Key and must never be reused.
   - Show the POS Data Recovery Key once when creating an encrypted profile. Require owner confirmation that it has been stored separately/offline (e.g. printed or in a password manager on a different device). Do not save the plaintext key in the profile folder, Google Drive profile folder, source code, logs or Notion.
   - On Windows reinstall, new Windows account or DPAPI failure, ask the owner for the POS Data Recovery Key, unwrap the DEK, verify an authenticated test record, then create a fresh DPAPI-wrapped DEK for the new Windows account.
   - If both the OS-wrapped key and the separate recovery key are lost, the encrypted profile is unrecoverable. Never promise recovery without the key.
   - Check `safeStorage` availability and reject unsafe plaintext fallback providers. Electron documents Windows DPAPI as protecting data from other users on the same machine, but not from other apps running in the same userspace; copied profile data is not independently recoverable from DPAPI after a Windows reinstall. The separate recovery key is therefore essential.

3. **Windows folder permissions (“folder lock”)**
   - Apply restrictive NTFS ACLs to the managed profile folder: current Windows user SID, SYSTEM and the minimum required system principals only; remove inherited broad Users/Everyone access where safe.
   - Verify the resulting ACL after applying it; if permission hardening fails, do not claim the folder is locked and show a clear warning.
   - Reject reparse points, junctions and symbolic links in the profile path; validate canonical paths before file operations.
   - Recommend BitLocker for the full drive, especially a removable/external drive. BitLocker protects the physical drive when powered off; it does not replace application encryption or protect an already unlocked session.
   - Never rely on hidden folders, obscure names, a UI-only lock, ZIP password or NTFS ACL alone as the data confidentiality boundary.

4. **Unlock, runtime and tamper handling**
   - Unlock only after the expected profile has been selected and verified. Show the active profile identity and encryption status.
   - Require the normal local POS login after profile adoption; add idle auto-lock and explicit lock controls. Keep local POS authentication separate from cloud updater sign-in.
   - Keep encryption/decryption operations in the main process and restrict IPC to the exact trusted main frame, bounded payload sizes, known purpose names and validated profile IDs/revisions.
   - AES-GCM authentication failure, wrong key, missing key envelope, unexpected profile ID, stale/invalid revision or storage corruption must fail closed: no plaintext fallback, no auto-seed, no silent creation of a new shop. Preserve the original folder and offer recovery/backup guidance.
   - Clear DEK buffers on lock/exit on a best-effort basis. JavaScript/V8 memory zeroization cannot be guaranteed; a compromised running OS can still inspect process memory.
   - Add anti-rollback protection for older but valid ciphertext: keep the highest committed revision in a separate protected local checkpoint and/or a server-signed checkpoint when online. Offline rollback detection must not block legitimate offline work; reconcile monotonic revisions on next trusted sync.

5. **Migration and backup**
   - Encrypt the destination profile before switching the active pointer. Verify decrypt/read-back, record counts, hashes and shop identity before activation; keep the source unchanged for rollback.
   - Never copy the whole Chromium Local Storage directory into the new profile. Classify every key; migrate durable idempotency data through a controlled typed migration, move secrets to OS secure storage, clear local session and require fresh local login.
   - Keep Google Drive backup encryption and POS local-profile encryption as separate key domains and separate recovery flows. Do not reuse or overwrite existing `RECOVERY_KEY.txt` semantics.
   - Never upload the local POS Data Recovery Key to the same drive/folder as the encrypted profile by default.

### Threat coverage

| Threat | Main mitigation | Remaining limitation |
| --- | --- | --- |
| Someone copies only the profile folder | AES-256-GCM ciphertext; DEK wrapped separately | Recovery key plus folder can unlock it |
| Different Windows account browses live folder | NTFS ACL + DPAPI-wrapped DEK | Administrator can change ACL/take ownership |
| Windows drive stolen while powered off | BitLocker + app-level encryption | BitLocker recovery key compromise weakens drive protection |
| Ciphertext edited/corrupted | AES-GCM authentication + verified revision | Valid old ciphertext replay needs anti-rollback checkpoint |
| Windows reinstalled, data drive preserved | Owner supplies separate POS Data Recovery Key; rewrap for new DPAPI identity | Without recovery key, data cannot be recovered |
| Malware runs as the authorized Windows user while POS is unlocked | Least privilege, Windows Defender/updates, idle lock, reduced secret exposure | No app-level guarantee against same-user malware or admin compromise |
| Recovery key stolen together with profile | Keep recovery key offline/separate; owner confirmation | Both items together can decrypt the profile |

### Acceptance tests before enabling encryption in production

- Ciphertext contains no readable shop names, customer names, phone numbers, invoices, IMEI/serials, balances, stock, notes or sync payloads.
- Correct DEK decrypts; wrong DEK, wrong profile, changed ciphertext/tag/nonce/AAD, stale revision and unsupported version all fail closed.
- Windows DPAPI wrapper works for same user and fails for another user/account context; POS Data Recovery Key restores after simulated Windows reinstall and rewraps a new DPAPI key.
- No raw DEK or recovery key appears in IndexedDB, localStorage, sessionStorage, profile manifest, logs, crash reports, renderer IPC payloads or Git history.
- Folder ACL test confirms the current user and SYSTEM access and rejects an unprivileged second Windows account; verify behavior on NTFS and external drives.
- App lock/idle timeout, POS logout, app crash and Windows restart leave no plaintext business data on disk.
- Corrupt/tampered profile never opens as an empty shop and source data remains untouched.
- Backup/restore and profile encryption use separate keys; recovery from both paths is tested.
- Windows installer and portable build tests cover fresh install, update, Windows reinstall, user account change, drive letter change, offline use and rollback.

### Windows folder ACL implementation slice — 2026-11-20

- Added `electron/profile-acl.cjs` with a Windows-only NTFS ACL hardening operation.
- It validates local absolute profile paths, rejects drive roots/network/device paths, scans for symlinks/junctions before and after ACL changes, grants explicit Full Control to the current Windows user SID and SYSTEM first, removes inherited permissions and broad Everyone/Users/Authenticated Users/Administrators ACEs, sets the current user as owner, runs `icacls /verify`, and performs a PowerShell SID-level ACL inspection for every profile entry.
- Commands use `execFile` with `shell:false`; invalid SID/path, reparse point, command failure or ACL verification failure stops the operation.
- Follow-up hardening: remove every explicit ACL entry whose SID is not the selected Windows user or SYSTEM, remove deny entries, and verify the selected user is the owner. This prevents an unlisted individual Windows account ACE from surviving the initial broad-group removal. This is still unverified on physical NTFS; helper-only CI tests do not prove Windows ACL semantics.
- Added `tests/profile-acl.test.cjs` with 7 tests for command order, path safety, SID injection rejection, non-Windows refusal, junction rejection, no-shell execution/verification and failure handling.
- Added this ACL test to `test:domain`.
- This helper is not yet called by profile creation or folder selection. No actual Windows folder ACL has been changed; Linux hosted tests can test the plan and injected command behavior only. Real NTFS verification on Windows remains required.

### Implementation status — 2026-11-20

- Added `electron/profile-crypto.cjs`: AES-256-GCM profile payload encryption, authenticated profile/purpose/revision binding, DPAPI/safeStorage DEK wrapping, independent 256-bit POS Data Recovery Key wrapping, and async/sync safeStorage adapter compatibility.
- Added an owner-changeable folder-lock passphrase wrapper using Node.js scrypt (N=2^15, r=8, p=3; 16-byte random salt per wrapper; AES-256-GCM authentication). This matches an OWASP-listed scrypt minimum configuration. Changing the passphrase re-wraps the same DEK; it does not require re-encrypting all POS records. The passphrase wrapper is a tested primitive only; it is not yet connected to the POS Settings UI or key-envelope lifecycle.
- Corrected the cross-profile passphrase test to assert the validator's actual fail-closed error wording; no crypto validation was weakened. Local Node v22.16.0 Linux microbenchmark for scrypt N=32768/r=8/p=3: 311.7 ms, 296.8 ms, 231.6 ms (median 296.8 ms). This is a development-container benchmark, not a Windows low-end PC performance claim.
- Added `tests/profile-crypto.test.cjs`: 15 tests for encryption round-trip, tamper detection, profile/purpose isolation, key validation, recovery-key validation, reinstall recovery, OS wrapper, unsafe fallback rejection, async safeStorage, independent key wrappers, explicit serialization requirements and strict base64 encoding checks.
- Added the profile crypto and profile/IndexedDB inspection tests to the `test:domain` command so the desktop QA workflow can run them.
- These are tested cryptographic primitives, not yet integrated into the actual IndexedDB read/write path, Electron startup unlock, profile key file lifecycle, Windows ACL application or UI. Production data remains unchanged and is not yet encrypted at rest by this implementation.


## Owner-controlled folder lock, portable recovery and Drive backup — 2026-11-20

This section refines the security UX requirement from the shop owner. It is a product requirement for the managed profile workflow, not a claim that the current helper modules already provide it.

### POS Settings: Folder Lock controls

- When the owner selects a local NTFS storage folder, NexFix must offer an in-app **Lock this folder** action and display the exact active folder/profile identity.
- The lock should have two distinct controls: (1) a changeable owner-chosen unlock passphrase/PIN, verified before changing or disabling the lock; and (2) the cryptographic POS Data Recovery Key used for disaster recovery. Do not use the POS local ADMIN password, Windows password, cloud password or Google Drive backup Recovery Key as the encryption key.
- The owner may change the passphrase while the profile is unlocked and after re-authentication. Changing a passphrase must re-wrap the existing DEK and verify the new wrapper before retiring the old wrapper; it must not re-encrypt or rewrite all business records unnecessarily.
- Disabling the folder lock requires owner re-authentication and an explicit warning. It may remove the additional passphrase gate and/or restore normal inherited NTFS permissions only after confirmation; it must not silently decrypt the business database. Encryption-at-rest remains enabled unless the owner runs a separately designed, verified decrypt/export operation.
- Apply and verify NTFS ACLs from the Electron main process. If ACL application partially fails, preserve the explicit current-user and SYSTEM access grants, report that the folder is not fully locked, and provide a safe repair/unlock path. Never claim success based only on a button state.
- A lock passphrase is a user knowledge factor; a recovery key is a high-entropy backup factor. Do not store either plaintext in the selected folder, localStorage, logs, crash reports, Notion or GitHub.

### Device-specific keys versus portable profile recovery

- On each Windows installation/device, generate a fresh random device wrapping key and protect it using that device's Windows DPAPI/safeStorage identity. This supports normal auto-unlock on that installation only.
- Keep one profile DEK for the encrypted profile and wrap it independently for each authorized device, plus a separate profile-level POS Data Recovery Key wrapper. A new Windows installation must never depend on the old DPAPI wrapper.
- The POS Data Recovery Key is profile-specific and portable: show it once, allow the owner to copy/print/export it securely, require confirmation that it has been stored outside the selected data folder, and never regenerate/replace it without an authenticated rotation flow.
- After Windows reinstall or a drive-letter/path change, the owner selects the preserved profile folder. Identify it by its validated profile UUID and authenticated encrypted manifest/check record, not by drive letter or folder name. Ask for the POS Data Recovery Key when the old device wrapper is unavailable, verify a known encrypted record, then create a new device wrapper for the new Windows installation.
- If the owner forgets the changeable passphrase, recovery must be possible through the separate POS Data Recovery Key. If both the passphrase and recovery key are lost and no still-valid device wrapper remains, the data cannot be recovered. Do not create an empty replacement shop in this case.
- When a profile is copied to another PC, require explicit owner authorization and recovery-key unlock; do not assume a copied folder is trusted or automatically authorize a new device. Maintain one active writer per profile and detect duplicate profile UUID copies.

### Google Drive backup and restore

- Google Drive backup must include the encrypted POS data snapshot, profile UUID/format metadata, integrity checksums, and the encrypted key-envelope material required for a future restore. Backups must be restorable after Windows reinstall without the original PC's DPAPI identity.
- Never upload the raw POS Data Recovery Key or plaintext DEK next to the encrypted backup. The backup may include the recovery-key-wrapped DEK envelope (ciphertext only); the owner must supply the separate POS Data Recovery Key during restore. If the owner explicitly wants a recovery-key copy stored in Drive, require a separate user-controlled secret vault/export protected by a different strong secret, never put it beside the encrypted backup as plaintext.
- Keep the existing Google Drive backup Recovery Key and POS Data Recovery Key as separate key domains. Existing backup encryption and shop authorization semantics must remain intact; do not silently change or overwrite existing `RECOVERY_KEY.txt` behavior.
- Restore sequence: verify Drive shop authorization and backup integrity; select the correct profile; obtain the POS Data Recovery Key; unwrap the DEK; authenticate/decrypt into a staging profile; verify shop identity, schema, records and pending operations; then atomically activate. Keep the old profile and restore checkpoint untouched until post-restore verification succeeds.
- Support automatic and manual backup to the owner's authorized Drive location, but do not let a scheduled backup upload plaintext recovery secrets. Show separate statuses for local save, encrypted profile lock, cloud sync and last successful Drive backup.

### Required acceptance tests before production enablement

- Lock/unlock/change passphrase/disable lock from POS Settings with owner re-authentication; verify wrong passphrase and tampered wrappers fail closed.
- Copy the entire selected folder to another PC: without recovery key, business data remains unreadable; with the correct recovery key, authorized recovery succeeds.
- Reinstall Windows while preserving the data partition; change the drive letter; select the same profile; recover the same shop data and pending offline operations.
- Generate a new device wrapper after recovery; confirm the old DPAPI wrapper is not required and the profile UUID remains unchanged.
- Verify raw DEK, passphrase and POS Data Recovery Key never appear in profile files, browser storage, logs, IPC responses or Drive backup contents.
- Drive restore on a different Windows installation succeeds with the POS Data Recovery Key and existing Drive authorization flow; wrong shop ID, wrong key, corrupt ciphertext and interrupted restore all fail safely.
- Test ACL behavior on real Windows NTFS with a second unprivileged Windows account, current user, SYSTEM and administrator. Explicitly document that administrators and malware in the authorized user session remain outside the folder-lock guarantee.
- Test key rotation, recovery-key replacement, backup retention and rollback with disposable test profiles before touching live shop data.

### Implementation boundary

The current branch contains AES-256-GCM crypto primitives, a Windows ACL helper, profile manifest/discovery helpers and a non-seeding IndexedDB inspection function. These are not yet wired into the running POS, Settings UI, profile startup, encrypted IndexedDB stores, per-device key registry or Google Drive backup/restore. No existing customer data is encrypted or folder-locked by these foundations. The above is the required next integration scope.

## Deep security architecture review — 2026-11-20

### Encryption boundary and Electron storage paths

- Encrypt POS business records at the application layer **before any renderer-side IndexedDB write**. Electron safeStorage protects small key material on the local OS; it is not a substitute for encrypting the POS database itself.
- Keep the DEK in the Electron main process only. Renderer IPC must expose narrow typed operations for approved profile/store/purpose combinations; never expose the raw DEK, generic arbitrary decrypt, ipcRenderer, filesystem or shell access. Validate event.senderFrame, top-level frame, expected app origin, active profile ID, payload schema and strict size limits on every privileged request.
- Encrypt every persisted IndexedDB store, not just app_state: sync_queue contains sale/return/GRN/repair/stock operation payloads, and meta can contain operational metadata. The existing src/lib/db.ts currently writes those records as plaintext structured values. Migration must atomically stage encrypted rows, verify decrypt/read-back and preserve queue ordering/idempotency before switching the active format.
- Keep Electron sessionData and userData separate from the selected business-data folder. Electron documents that sessionData contains localStorage, cookies, disk cache and network state; moving the entire directory into the shop folder could copy cloud sessions, updater credentials and browser secrets with the business data. Store only the managed encrypted POS profile in the selected folder; keep OS-protected updater/cloud credentials in the app's secure local area and require cloud re-authentication after a Windows reinstall.
- Audit all localStorage/sessionStorage keys before migration. In particular, existing Google Drive Recovery Key material currently has localStorage keys; do not copy these keys into a new profile folder or legacy import. Migrate secrets deliberately to main-process OS secure storage while preserving backward-compatible Drive restore behavior.

### Folder-lock semantics

- NTFS ACLs can restrict **other Windows accounts**, but an ACL cannot stop the same authorized Windows account from browsing its own folder in Explorer. The real guarantee against copying the folder is that the business files are encrypted and the key is not stored in plaintext beside them. Folder names and metadata should avoid exposing shop/customer information.
- The current ACL helper has been tightened to remove explicit ACEs for any SID other than the selected Windows user and SYSTEM, remove deny ACEs, set the selected user as owner and verify the owner plus all entries. It remains unintegrated and requires physical Windows NTFS tests. A local administrator can still take ownership or change permissions.
- Never report “folder cannot be opened” as a security guarantee for the same Windows account. The correct UI promise is: **copied or browsed profile files remain unreadable without the unlock/recovery key**. A separate Windows account should be denied by ACL where NTFS supports it.

### Key hierarchy and recovery

- Use one random 256-bit profile DEK for POS profile data. Keep independent wrappers for: (1) current Windows user/device via DPAPI-backed Electron safeStorage; (2) the owner-changeable passphrase via scrypt-derived KEK; and (3) the portable POS Data Recovery Key. Changing the passphrase re-wraps the same DEK only.
- The Windows wrapper is installation/account-specific and is not the reinstall recovery path. On a replacement Windows installation, the owner selects the preserved profile folder, supplies the POS Data Recovery Key, the app authenticates/decrypts a known check record, then creates a fresh local DPAPI wrapper. Drive letter and folder path are not identity; the authenticated profile UUID is.
- Keep the POS Data Recovery Key exportable as a one-time recovery kit (copy/print/save to an owner-chosen offline location). Do not log it or store it in the profile folder, localStorage, Notion, GitHub or as plaintext in Drive.
- Google Drive backups should contain encrypted profile data and the recovery-wrapped DEK envelope, never the raw DEK or raw POS Data Recovery Key. To satisfy a Drive-held recovery copy without placing plaintext secrets beside backups, add a separately encrypted recovery-kit object wrapped by an independent user-held secret or a deliberately designed, separately reviewed key escrow. The owner must understand that losing both the offline recovery key and any independent recovery secret makes the profile unrecoverable. Do not silently make the existing Drive Backup Recovery Key and POS Data Recovery Key the same key.
- Preserve the current Drive backup encryption format and existing RECOVERY_KEY.txt / shop authorization semantics during migration. Existing backups must remain restorable. A new profile-aware backup format needs an explicit version, profile UUID, schema version, wrapped DEK envelopes, ciphertext, SHA-256 integrity metadata, creation time and shop scope. Restore must verify all of these before decrypting into a staging profile and atomically activating.
- Use resumable Drive upload for large encrypted backup objects and interrupted connections; the Google Drive API recommends resumable upload for files over 5 MB and network interruption. Verify uploaded object identity/size and a locally computed SHA-256 before marking backup successful.

### Cryptographic and runtime checks

- Passphrase KDF now uses scrypt N=2^15, r=8, p=3 with a 16-byte random salt; OWASP lists this as one of its minimum scrypt configurations. Local Node 22.16.0 benchmark median was about 297 ms on this development container; benchmark on low-end Windows PCs before deciding whether to raise it further.
- AES-256-GCM uses 96-bit random IVs and authenticated metadata. Enforce a per-key encryption-operation ceiling and rotate the DEK before the applicable GCM usage limit; do not reuse IVs with the same derived key. Consider purpose-separated HKDF subkeys for state, queue and metadata to isolate nonce domains.
- Handle Electron async safeStorage shouldReEncrypt responses and temporary unavailability. The current helper reads result but does not yet perform re-encryption when shouldReEncrypt is true; add this to the device-key lifecycle before production. Prefer the async API and remove the sync fallback when the project upgrades to Electron 46+, where the synchronous API is removed.
- The current helper uses the OS safeStorage wrapper directly around the DEK. It does not yet implement a separate application-generated device key registry, device revocation, idle lock, or UI lock lifecycle.

### Research references

- Electron safeStorage and async API behavior: https://www.electronjs.org/docs/latest/api/safe-storage
- Electron app sessionData contents: https://www.electronjs.org/docs/latest/api/app
- Electron security checklist and IPC sender validation: https://www.electronjs.org/docs/latest/tutorial/security
- OWASP Cryptographic Storage: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- OWASP Password Storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Secrets Management and backup/restore: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- Microsoft DPAPI: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- Microsoft icacls: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls
- Google Drive resumable uploads: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- NIST SP 800-57 Part 1 Rev. 5 key recovery: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-57pt1r5.pdf

### Confirmed implementation boundary

This review changes design requirements only. The live POS IndexedDB path, key lifecycle, IPC, Settings UI, Windows ACL application and Google Drive profile backup/restore remain unintegrated. Do not claim live data encryption, full folder lock or portable recovery until those are implemented and tested on Windows.


## Existing Google Drive Recovery Key transport audit — 2026-11-20

A source review of the current main-branch Drive implementation found an important legacy-key exposure that must be handled as a separate compatibility migration:

- src/lib/backupCrypto.ts currently stores the existing Google Drive Backup Recovery Key in renderer localStorage (shop-scoped key map) and Settings.tsx displays the key in a read-only input with a copy action. The key is therefore not currently protected by Electron safeStorage.
- src/lib/driveSync.ts sends the existing Recovery Key in the POST body for encrypted backupState uploads. This is how the current Apps Script creates/updates RECOVERY_KEY.txt for disaster recovery.
- google-apps-script/Code.gs writes the raw existing Google Drive Backup Recovery Key into RECOVERY_KEY.txt in the same shop folder as the encrypted backup. Anyone who obtains both the backup and this plaintext file can decrypt the backup. This was existing behavior, not introduced by the profile crypto branch.
- The previous updateShopMetadata GET also sent the raw Recovery Key in a URL query parameter. This is an avoidable transport exposure because URLs can be retained in logs/history/diagnostics.

### Narrow compatibility fix in this feature branch

- Removed url.searchParams.set('recoveryKey', recoveryKey) from src/lib/driveSync.ts metadata GET.
- Changed google-apps-script/Code.gs updateShopMetadata handler to authorize using the existing shopProof, without requiring or transmitting p.recoveryKey, and to skip rewriting RECOVERY_KEY.txt during metadata-only updates.
- The encrypted backupState POST contract still carries the existing Recovery Key for now so the currently deployed Drive backup/restore workflow and existing RECOVERY_KEY.txt file behavior are not silently broken.
- Added tests/google-drive-recovery-key-transport.test.cjs to prevent raw Recovery Key reintroduction into the metadata GET and to assert the legacy backup POST contract remains in place.
- This fix is source-only until the updated Apps Script is deployed. No production Apps Script deployment or Drive file was changed by this branch.

### Remaining high-priority migration

- The raw legacy RECOVERY_KEY.txt in Drive remains a confidentiality weakness. Do not delete or rewrite it automatically: existing backups may become unrecoverable. A future version should add a separately encrypted recovery-kit file protected by an independent owner-held passphrase, verify an offline recovery copy, then offer a clearly confirmed migration/removal of the old plaintext file.
- Move the legacy Drive Recovery Key out of renderer localStorage into main-process OS secure storage. This requires moving encryption/decryption or a narrow key operation behind trusted IPC; do not simply return the key to the renderer for every backup operation.
- The shopProof remains a reusable proof in some GET query parameters, and the build API key is also passed in GET parameters. Move authenticated metadata/status operations to POST or short-lived request-bound proofs in a separately reviewed Apps Script contract change.
- Keep the new POS Data Recovery Key completely separate from this existing Drive Backup Recovery Key. Do not reuse either key or put the new POS Recovery Key in plaintext next to a Drive backup.



### Optional Windows volume protection

- Recommend BitLocker / Windows Device Encryption as a complementary layer for lost/stolen PC or offline disk removal. It protects the whole volume while powered off; it does not replace POS profile encryption once the user has signed into Windows.
- Windows 11 Home may support automatic Device Encryption on eligible devices; the manual BitLocker Drive Encryption UI is documented for Pro, Enterprise and Education editions. Do not assume every shop PC supports the same mode.
- NexFix must not silently enable BitLocker or modify volume protectors. Show an optional security recommendation and let the owner configure it in Windows. Back up the BitLocker recovery key separately; it is not the POS Data Recovery Key or Google Drive Backup Recovery Key.


### Runtime boot-path audit

- The new idbInspectExistingState() helper is currently only a non-seeding inspection primitive. The live store.tsx boot path still calls idbLoadState(), whose missing-row path can create and persist buildSeed(), and it still has a legacy localStorage state reader. The helper is not yet wired into startup. Therefore the branch does not yet guarantee that a missing/corrupt selected profile cannot fall through to an empty seeded shop.
- electron/main.cjs still calls setupAutoUpdater(); createWindow() directly inside app.whenReady(); there is no pre-window storage-profile bootstrap, folder picker, profile unlock gate or key-envelope load.
- electron/preload.cjs has no profile storage/crypto IPC methods. The existing trusted-renderer check requires the top-level frame and allowed navigation, which is a useful base, but every new profile IPC endpoint still needs operation-specific payload validation and must never return the DEK.
- The current renderer IndexedDB remains the authoritative state store, with app_state, sync_queue and meta. persistState waits for the IndexedDB transaction and raises a storage-error event, but no encryption or selected-folder mirror is present yet.
- This is a hard production gate: do not add a folder picker alone. The app must first have a fail-closed bootstrap state machine and a real encrypted persistence backend, otherwise the user can select a folder while the running POS continues saving elsewhere or seeds an empty shop.


### Real Windows ACL test finding

- The first physical Windows NTFS test failed before ACL verification because the runner's Windows PowerShell did not auto-load Microsoft.PowerShell.Security for Get-Acl (CouldNotAutoloadMatchingModule). This is a real runtime integration issue, not a test-only assertion. The ACL scripts now explicitly import Microsoft.PowerShell.Security with ErrorAction Stop before using Get-Acl/Set-Acl. The Windows QA run must be repeated; do not claim ACL hardening works until the real test passes.
