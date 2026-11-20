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

### Implementation status — 2026-11-20

- Added `electron/profile-crypto.cjs`: AES-256-GCM profile payload encryption, authenticated profile/purpose/revision binding, DPAPI/safeStorage DEK wrapping, independent 256-bit POS Data Recovery Key wrapping, and async/sync safeStorage adapter compatibility.
- Added `tests/profile-crypto.test.cjs`: 11 tests for encryption round-trip, tamper detection, profile/purpose isolation, key validation, recovery-key validation, reinstall recovery, OS wrapper, unsafe fallback rejection, async safeStorage, independent key wrappers and explicit serialization requirements.
- Added the profile crypto and profile/IndexedDB inspection tests to the `test:domain` command so the desktop QA workflow can run them.
- These are tested cryptographic primitives, not yet integrated into the actual IndexedDB read/write path, Electron startup unlock, profile key file lifecycle, Windows ACL application or UI. Production data remains unchanged and is not yet encrypted at rest by this implementation.
