# Local POS Admin Authorization — Main-Process Authority Design

**Status:** Draft investigation / proposed architecture  
**Date:** 2026-11-26  
**Scope:** Offline local POS authentication and high-risk desktop actions  
**Implementation status:** No implementation change is included in this document.

This design is not an approved change to the current login behavior. It records the verified trust boundary, the migration constraints and a safe implementation direction for review before changing production code.

## 1. Safety invariants

1. Local POS login remains separate from Supabase cloud login, cloud shop membership and private updater/device authorization.
2. Local POS must continue to work offline. No Admin verification request may require Supabase or an internet connection.
3. The main process must not authorize a sensitive Admin operation from renderer-supplied role, user ID, permission flags, a localStorage session marker or a renderer-readable/writable POS state snapshot.
4. Main-process credential records must contain verifiers only, never plaintext passwords, PINs, Recovery Keys or cloud tokens.
5. No renderer-generic profile read/write API may read or overwrite the main-process credential record.
6. The encrypted-profile/IndexedDB cutover must copy and verify the credential authority before committing `folder_primary`. If that copy cannot be verified, IndexedDB remains authoritative and cutover is blocked.
7. Existing Admin, cashier, manager and technician roles, first-login password-change state, account activation, offline use and the user's current login experience must be preserved unless a separately reviewed change explicitly says otherwise.
8. No credential-authority migration may silently trust an arbitrary renderer-provided hash as proof that it belongs to the shop owner.

## 2. Verified current implementation

The following observations were checked against the PR #293 head `0ab5685b09987a1d073f93a1eea2c31c111711fc`.

### 2.1 Current credential source

- `src/lib/types.ts` defines `AppUser` with `id`, `email`, `password`, `role`, `active` and optional `mustChangePassword`.
- `src/lib/store.tsx` stores the user list in the global `POSState`. The Admin unlock verifier is stored at `POSState.settings.adminPinHash`.
- `src/lib/utils.ts` uses PBKDF2-HMAC-SHA256 with 600,000 iterations, 16-byte random salt and 32-byte digest for the current account password format (`saltBase64:digestBase64`). This is a good password-hash format, but the hash itself is still in renderer-managed state.
- The same utility's `hashPin` path is a deterministic SHA-256 hash using the project `AUTH_SALT`, not the current per-password salted PBKDF2 format. The Admin unlock PIN minimum is currently four characters in `changeAdminPin`.
- `src/lib/passwordAsync.ts` uses Web Crypto for the same PBKDF2 format and falls back to the deterministic project verifier.

### 2.2 Renderer-managed login and session

- `src/lib/store.tsx:signIn` finds users in `stateRef.current.users`, verifies the password in the renderer, then writes a session marker containing only `userId` and `remember` to localStorage and sessionStorage.
- `createInitialAdmin` creates the initial Admin and optional cashier in renderer state and sets `settings.adminPinHash` from the initial Admin password.
- `changePassword`, `changeManagedPassword`, `saveUser`, `toggleUserActive`, `deleteUser`, `switchRole` and `changeAdminPin` update credential-bearing fields through renderer-managed POS state.
- `src/App.tsx` derives the authenticated user, role and `mustChangePassword` routing from `POSProvider` state. Idle timeout and session-age handling are also renderer-side.
- `Login.tsx` calls `ensureCloudSession` after local sign-in, but the source explicitly keeps local POS login independent from the one-time cloud account session. The new authority must not reuse cloud refresh tokens or updater credentials.

### 2.3 Storage and Electron trust boundary

- Before folder-primary cutover, `src/lib/db.ts:idbLoadState` and `idbSaveStateDetailed` read/write the full `POSState` in IndexedDB.
- After `folder_primary`, the same functions route the full state through `writeDesktopProfileJson('app_state', state)` / `readRequiredProfileJson('app_state')`.
- `src/lib/desktopProfileStorage.ts` exposes generic renderer bridge methods for `app_state`, `sync_queue`, `meta`, `restore_checkpoint` and `migration_journal`.
- `electron/profile-ipc.cjs` validates that an IPC caller is the trusted top-level renderer and applies a payload-size limit, then accepts a purpose and serialized payload for `pos-profile:write`.
- `electron/profile-storage.cjs` applies a purpose allowlist. The allowlist prevents arbitrary filenames, but explicitly allows `app_state`; that entire payload includes the users and Admin PIN hash. Therefore the renderer can legitimately write a replacement `app_state` snapshot through the public bridge.
- The trusted-renderer check proves frame/origin identity. It does not prove that the current local POS user is Admin or that an `app_state` credential payload has not been replaced by renderer code.
- The Electron profile key and encrypted data stay in the main process, but generic IPC grants the trusted renderer read/write access to the approved POS data purposes. Encryption at rest is not a separate authentication authority.

### 2.4 Existing storage migration

- `src/lib/storageOverflowMigration.ts` and `src/lib/storageOverflowMigrationCore.ts` copy and read-back-verify four IndexedDB domains: `app_state`, `sync_queue`, `meta` and `restore_checkpoint`.
- Only after their byte counts, hashes and read-backs pass does the migration transition to `folder_primary`.
- No separate main-process-owned local credential record is currently part of that cutover.

### 2.5 Existing test coverage

- The current test tree contains Electron security and encrypted profile-session tests, but no dedicated local-login/credential-authority test module was found by the repository tree search.
- Existing profile IPC tests exercise encrypted data read/write and trusted renderer checks; they do not make the `app_state.users` hash a main-process authority.

## 3. Confirmed security conclusion

**Neither the PBKDF2 account hash nor `settings.adminPinHash` inside `app_state` can be treated as an independent main-process Admin authority.**

The account hash is stored in a record that the renderer can write. The Admin PIN verifier is in that same record and currently uses a weaker deterministic hash format. The renderer session marker contains a user ID, not a verifiable Admin assertion. Reading `app_state` from the main process does not repair this: before cutover it is not the authoritative source; after cutover it remains renderer-writable through the generic profile IPC.

A main-process authorization decision must be based on a separately owned verifier record and a fresh proof of the user's Admin credential, not a renderer-provided role or state snapshot.

## 4. Proposed architecture

The recommended direction is a dedicated main-process credential authority with a versioned, protected record. The current login UX can be preserved while sensitive main-process operations are migrated first; do not attempt a full login rewrite as part of the Recovery Key rotation patch.

### 4.1 Ownership and storage modes

Create a main-process module (working name: `LocalPOSCredentialAuthority`) with a versioned record and explicit read/verify/update functions.

- **IndexedDB-primary mode:** keep the authority record under Electron `app.getPath('userData')`, encrypted with Electron `safeStorage` (Windows DPAPI). This remains local to the current Windows account, matching the current IndexedDB database's local-device scope.
- **Folder-primary mode:** keep a portable credential record inside the encrypted POS profile (working purpose name: `local_auth`), encrypted with the same profile data key. This lets the record move with the encrypted profile and be read only after the main process unlocks the profile using the OS wrapper, passphrase or Recovery Key.
- **Cutover:** before `folder_primary` is committed, the main process must copy the current authority record into the protected profile purpose, read it back and compare profile binding, revision and integrity. The renderer migration coordinator must not supply or modify this record. If verification fails, do not mark the folder primary.
- **After cutover:** the profile-bound record is authoritative. A stale per-Windows `userData` copy must never override the portable profile record.

This requires a main-process migration participant. Simply adding `local_auth` to the renderer's generic `DesktopProfilePurpose` union or to the renderer migration `PURPOSES` list would recreate the same trust-boundary problem.

### 4.2 Protected profile purpose

The encrypted profile storage may reserve a `local_auth` file, but it must not expose this purpose through `readPOSProfileData` or `writePOSProfileData`.

- Add dedicated main-process-only methods on the profile session/storage layer for the credential record.
- Keep the generic `pos-profile:read` and `pos-profile:write` IPC purpose allowlist explicitly separate from the private credential purpose.
- Reject direct renderer attempts to read/write `local_auth`, even if the caller passes a syntactically valid purpose string.
- Bind the record to the active profile ID, schema version and monotonically increasing credential revision. Reject malformed, stale, cross-profile or unauthenticated records.

### 4.3 Credential record contents

The main-process record should contain only the minimum credential authority data, for example:

- schema version and credential revision;
- profile/shop-local identity binding;
- accounts keyed by stable local user ID, with normalized email, role, active flag and `mustChangePassword`;
- a versioned password verifier for each account;
- a distinct, versioned Admin unlock verifier if the Admin PIN remains a supported credential;
- persistent failed-attempt/lockout metadata.

Do not store plaintext passwords, plaintext PINs, Supabase IDs, cloud refresh tokens, updater tokens, Recovery Keys or data keys in this record. Do not log the record or send it to Notion.

### 4.4 Password verification

- Implement verification in the Electron main process using Node's asynchronous `crypto.pbkdf2` and constant-time digest comparison. Use the existing PBKDF2 format/parameters for compatible current account hashes where possible.
- Validate encoded salt/digest sizes, algorithm, iteration count and input length before performing expensive work.
- Keep legacy hash support only as an explicit migration path. After a successful legacy verification, upgrade to the current PBKDF2 format.
- The existing Admin PIN uses a separate deterministic SHA-256 format and a four-character minimum. Do not silently treat that as equivalent strength to the current account password. A versioned migration policy is required before accepting it for high-risk actions; new PIN changes should use a salted, slow verifier and a reviewed minimum length.
- Do not change the existing account login behavior in the same patch as this authority foundation. The first implementation target should be main-process authorization for Recovery Key rotation and other specifically scoped high-risk IPC operations.

### 4.5 Main-process authorization for Recovery Key rotation

The rotation flow should require all of the following in the main process:

1. The exact trusted top-level renderer and active selected profile.
2. A fresh Admin credential proof verified against the main-owned credential record (not `user.role`, `confirmSensitiveAdmin` renderer state or `app_state`).
3. Possession of the current desktop profile Recovery Key, verified against the profile's current recovery wrapper.
4. The pending rotation ID, active profile binding and explicit saved-key acknowledgement already required by the existing protocol.

Possible IPC approach: include a fresh Admin credential proof in the prepare/resume request and verify it inside main before returning or creating pending secret material. Bind the pending operation to that verified Admin identity and profile. Finalize must refer to that exact pending operation and cannot accept a renderer-supplied Admin role or user ID as authorization. On renderer reload, retrieving a still-pending replacement key must re-authenticate the Admin and verify the previous Recovery Key again. A completed key must never be redisplayed.

Avoid creating a generic long-lived Admin token. If a short-lived capability is needed for another operation, bind it to the specific operation, active WebContents, profile ID, expiry and one-time consumption.

### 4.6 Credential mutations and renderer mirror

The main credential record must remain authoritative after bootstrap. It must not be re-created from arbitrary `app_state` snapshots after each render or restore.

- Initial Admin enrollment must be a one-time main-process operation. Once initialized, a renderer cannot reset the authority by sending an empty user list.
- Account creation, password change, role change, activation/deactivation, deletion and Admin unlock verifier changes must update the main authority through explicit IPC after proof of an existing Admin credential.
- `POSState.users` may remain a UI/data mirror, but it is not an authentication source for privileged main-process operations.
- Track a credential revision and define a reconciliation/commit protocol so a crash or failed POS-state write cannot leave the main authority and UI mirror silently inconsistent.
- Restore flows must be included. Restoring an older `app_state` must not silently roll the main credential authority back or replace it with an unverified hash. Require an explicit, verified reconciliation policy.

### 4.7 Rate limiting and auditing

- Move Admin verification throttling for high-risk IPC into the main process; renderer localStorage counters are not authoritative.
- Persist bounded failure/lockout metadata with the protected authority record so restarting Electron does not reset the main-process limiter.
- Apply generic failure messages where practical to avoid account enumeration. Keep PBKDF2 work asynchronous so it does not block Electron's main event loop.
- Audit success/denial reason codes without recording submitted credentials, hashes, Recovery Keys or other secrets.

## 5. Required migration and compatibility work

This is the highest-risk part of the proposal and must be designed before coding.

1. **Existing IndexedDB shops:** first-time enrollment into the new authority needs a carefully reviewed one-time migration. The current store has no cryptographic provenance that proves its `users` and `adminPinHash` fields were never modified before the upgrade. A successful check against the legacy renderer-held hash preserves the current local state but cannot retroactively prove it was never tampered with. Do not claim otherwise. For this reason, an owner-present re-authentication/re-enrollment step may be required.
2. **New shops:** initial Admin setup writes the account verifier into the main authority before reporting setup success. A one-time enrollment flag lives in the main authority, not in renderer state.
3. **IndexedDB to encrypted folder:** main process copies the same revisioned credential authority into the private profile purpose before folder-primary cutover. Read-back verification must pass or cutover remains blocked.
4. **Already folder-primary shops:** verify that a valid profile-bound `local_auth` record exists before enabling main-process Admin-protected operations. Missing/corrupt records require a clear recovery/re-enrollment path; never rebuild one silently from the renderer.
5. **Windows reinstall/profile move:** once folder-primary, the credential record must remain decryptable with the existing profile passphrase or Recovery Key on the new Windows installation; it must not depend solely on the old PC's DPAPI sidecar.
6. **Backup/restore:** explicitly define how a restored backup affects local POS credential authority. Keep Google Drive backup Recovery Key and desktop profile Recovery Key separate. Cloud updater authentication remains out of scope.
7. **Browser/dev mode:** preserve the browser development fallback deliberately; it must not accidentally invoke a desktop-only authority API or claim main-process protection it does not have.

## 6. Required tests before enabling the authority

- Main-process PBKDF2 parser/verification tests: valid, invalid, malformed, legacy upgrade, constant-time digest-length handling and maximum input limits.
- Main-process Admin authority tests: non-admin password refused; active Admin succeeds; disabled/deleted Admin refused; role/email changes; password change; Admin unlock verifier migration; failed-attempt lockout survives process restart.
- IPC tests: untrusted frame rejected; trusted renderer with forged `role: 'admin'` still refused; wrong WebContents/profile/pending ID refused; authorization capability expiry/replay refused.
- Purpose-boundary tests: renderer generic `read/writePOSProfileData` cannot read or overwrite `local_auth`; only dedicated main-process methods can.
- State-tampering tests: replace `app_state.users` / `adminPinHash` with a forged Admin hash and prove main-process authorization still follows the protected record.
- Migration tests: IndexedDB-primary sidecar copies to encrypted profile, revision/hash read-back matches, interrupted copy retries safely, failed verification blocks `folder_primary`, and old sidecar cannot override profile authority after cutover.
- Profile portability tests: lock/unlock on another Windows installation with Recovery Key, then verify the same Admin credential; do not use Supabase.
- Restore and user-management tests: authority and renderer mirror reconcile safely after account update, backup restore, deletion and deactivation.
- Regression tests: existing offline sign-in, role switching, first-login password change, idle lock, POS sales and folder migration remain unchanged.

## 7. Implementation sequence

1. **Draft/design only:** complete the current-source audit and decide the credential migration policy. No login or production code change in this step.
2. **Authority module + isolated tests:** implement the main-process record and verifier without wiring it to existing login UI. Test the record format, DPAPI storage, PBKDF2 verification, purpose boundary and lockout.
3. **Migration bridge:** add the main-process-owned IndexedDB-sidecar to profile-sidecar copy and verify it before cutover. Test interruption and rollback.
4. **Credential mutation bridge:** wire first-run setup, password changes, Admin PIN migration, account management, activation/deletion and restore reconciliation to update the authority safely.
5. **Sensitive-operation enforcement:** require main-process Admin proof for Recovery Key rotation; remove any reliance on renderer-only Admin gating for that operation.
6. **Compatibility regression:** run full POS CI, security audit, Windows Desktop Build/QA No Publish, and physical Windows acceptance. Keep PR Draft until all gates pass.

Do not combine this with the Windows durable-file-replacement work; that is a separate security/reliability design and must be tested independently.

## 8. Open decisions

- Whether the existing Admin unlock PIN remains accepted for Recovery Key rotation, or whether only an Admin login password is accepted for that highest-risk operation.
- The minimum new Admin PIN length and the migration prompt for the current deterministic SHA-256 PIN format.
- Whether existing shops must re-enroll an Admin credential once during upgrade, because legacy IndexedDB state has no cryptographic provenance.
- How multiple active Admin accounts and manager/cashier role switches map to the main-process authority.
- How backup restore and account deletion/activation interact with the authority revision and recovery workflow.
- How browser development and automated tests should represent the absence of an Electron main process.

## 9. Current implementation boundary

No production authentication code was changed as part of this investigation. The current local POS login, session persistence, roles and PIN behavior remain renderer-managed. PR #293 Recovery Key rotation remains Draft-only and must not be enabled for production operators until main-process Admin authorization, the separate Windows replacement durability review and physical Windows acceptance are completed.


## 10. Verified startup order and authority bootstrap timing — 2026-11-26

A further source review of `src/App.tsx` confirms that `POSApplication` (and therefore `POSProvider`, local Login and first-run Admin setup) mounts inside `DesktopOverflowFolderSetup`. The encrypted-folder profile is not created as part of ordinary first-run Login. The separate `StorageOverflowController` waits for an IndexedDB quota warning; only after the user prepares migration does it create a profile, show the profile Recovery Key, and copy the current IndexedDB state to the selected folder.

This fixes the required order for a future authority implementation:

1. **Before/at first local Admin enrollment:** initialize a main-process-owned credential authority in the per-Windows-user DPAPI/safeStorage sidecar while IndexedDB is still primary. Main-process setup must be one-time and must never accept an arbitrary renderer-supplied PBKDF2 hash as proof of Admin identity.
2. **Normal IndexedDB-primary operation:** every approved account/password/role/activation mutation synchronizes through main-process authority IPC; the authority sidecar is the high-risk Admin proof source. The renderer's `app_state.users` remains a compatibility/UI mirror, not a main-process credential source.
3. **Only after a quota warning and encrypted profile creation:** when the user acknowledges the new profile Recovery Key and starts migration, the main process copies its current authority record into the private encrypted profile purpose `local_auth`, binds it to the exact profile ID and revision, and reads it back. The existing four IndexedDB data domains are then copied/verified.
4. **Before folder-primary transition:** main process verifies the `local_auth` copy and all four POS data-domain migration records. If any check fails, the app must not mark `folder_primary`.
5. **After cutover:** profile-bound `local_auth` becomes the authority. A sidecar copy may remain only as a non-authoritative recovery aid and must never overwrite a newer profile revision.

The folder profile and its Recovery Key are therefore not available as the only source for initial Admin authority creation: initial Admin setup happens earlier. A design that waits until profile creation to establish the authority would leave the entire IndexedDB-primary period unprotected.

For existing shops upgraded from a renderer-only credential store, the bootstrap limitation in section 5 still applies. There is no cryptographic proof in the old `app_state` that distinguishes the original Admin hash from a hash substituted before the authority is created. Do not silently promote whichever hash happens to be present at upgrade time.


## 11. Backup and restore credential behavior — exact source review — 2026-11-26

A direct read of `src/lib/backup.ts`, `src/lib/driveSync.ts`, `src/lib/restore.ts` and `src/lib/backupValidation.ts` confirms two different current behaviors:

### 11.1 Manual local JSON backup

- `downloadBackupWork` builds the envelope as `{ _meta, state }` from the complete input `POSState`, then downloads `JSON.stringify(payload, null, 2)`.
- This current local JSON file therefore includes `state.users[].password` hashes and `state.settings.adminPinHash`, as well as the rest of the POS state. It does not plaintext-export the password from those hash fields, but these are still sensitive password verifiers and can be attacked offline if the file leaks.
- This code path does not call the Google Drive `sanitizeCloudState` helper.

### 11.2 Google Drive backup/restore

- `driveSync.ts:sanitizeCloudState` clones the state with `users: []` and sets `settings.adminPinHash: ''` before encryption/upload.
- `isCloudSafeBackup` marks the returned Google restore data. `restore.ts:restoreLocalAuthentication` then retains the current complete `users` array and the current `adminPinHash` when applying this cloud-safe business state.
- This is consistent with device-local POS credentials remaining local and is a useful invariant for a future independent authority.

### 11.3 Current local restore behavior and risk

- `restore.ts:applyBackupRestoreWork` only calls `restoreLocalAuthentication` for a cloud-safe backup. A normal manually downloaded local JSON envelope is not cloud-safe, so the current path applies `backup.state` directly.
- As a result, a local JSON restore can currently replace the renderer-managed local account list and Admin PIN hash with values from that backup. The restore UI's Admin gate is checked in renderer code by reading the local session's `userId` from localStorage/sessionStorage and looking up its role in the supplied `current` state. This is not a main-process authorization proof.
- The restore checkpoint also snapshots the full `POSState`. It is used for rollback of the business state and must not become an alternate source for restoring the future main-owned credential authority.

### 11.4 Required future policy

- The new main-process credential authority must never be imported, overwritten, reset or rolled back from a local or Google Drive backup, `restore_checkpoint`, renderer event payload, or restored `POSState`.
- Treat local POS accounts, password verifiers, Admin unlock verifiers, active state, role and first-login password-change status as device/profile-local authentication data. A future reviewed backup format should exclude those fields from both local-download and Google backups, while preserving business data.
- When applying either local or Google business backup after authority migration, restore business data only, then reconcile the renderer's local account mirror from the current main authority. Never use a restored `users` array as an Admin source.
- The restore action itself is currently renderer-gated. Before claiming main-process Admin enforcement for destructive restore, add a dedicated main-process authorization path bound to the active local Admin, current profile, restore operation and short expiry. Do not accept `user.role` or localStorage session claims as proof.
- A compatibility decision is needed for existing local JSON backups: because they contain account hashes, decide whether older restores simply ignore imported local credentials and retain current device credentials, or require an explicit owner credential migration step. Do not silently replace the new authority with old backup hashes.
- Regression tests must show that a local backup containing a forged/replaced `users` list and Admin PIN cannot change the main authority or the current local account mirror; that failed restore rollback does not roll back credential revisions; and that cloud-safe restore still leaves local credentials unchanged.

No backup or restore behavior was changed in this design-only pass.


## 12. Explicit threat-model boundary — what this authority does and does not protect

The proposed credential authority protects the identity/credential decision for operations that are explicitly checked by the main process. It does **not**, by itself, make the entire offline POS database tamper-proof.

- The trusted renderer can currently call the generic `writePOSProfileData('app_state', payload)` bridge. That payload is a complete POS state snapshot. Main-process trusted-frame validation and encrypted-at-rest profile storage do not inspect every business mutation or prove it came from an authorized POS role.
- A separate private `local_auth` record prevents the renderer from replacing the authority's Admin verifier through `app_state`; it does not prevent a compromised renderer from changing business data in `app_state` if the generic write contract remains broad.
- Main-process checks can independently protect dedicated IPC operations such as Recovery Key rotation, profile-security changes and any other operation that is actually routed through a dedicated main-process authorization boundary.
- A main-process-only `authorize restore` handler is not sufficient to make restore tamper-proof while an unrestricted generic `app_state` writer remains available: compromised renderer code could bypass the restore handler and submit a new full state snapshot through the generic writer. Do not claim otherwise.
- If the product later requires main-process enforcement of Admin-only restore, account/role mutation or all business-state transitions against a compromised renderer, that requires a broader command-based/data-mutation boundary redesign: renderer sends typed business operations, main process validates operation-specific policy and owns/validates commits. That is a separate project-sized scope and must not be slipped into this narrow authority patch.
- Keep the immediate scope honest: independent Admin verification for dedicated privileged desktop IPC, a protected main-owned credential record, safe migration/backup isolation, and explicit UI/renderer limitations. It is not a guarantee against local machine administrators, modified app binaries, malicious renderer code changing ordinary business data, or direct filesystem tampering by an attacker with the same Windows account.

This distinction is important for acceptance: passing the Admin credential tests must not be described as proof that the whole POS database or every role-controlled business operation is secure against a compromised renderer.


## 13. Multiple-Admin identity binding — exact renderer behavior — 2026-11-26

A direct read of `src/lib/store.tsx` and `src/pages/Users.tsx` confirms the UI supports multiple active Admin accounts: the Users page can create/edit an account with role `admin`, and can deactivate or delete other accounts.

However, current renderer authentication helpers select the first active Admin record in array order in two places:

- `resolveSensitiveAdmin` uses `stateRef.current.users.find(u => u.role === 'admin' && u.active)` and verifies the entered Admin password only against that one record; the separate shared Admin PIN is also accepted.
- Cashier-to-Admin `switchRole` similarly finds the first active Admin and checks its password (or the shared Admin PIN).

This means a shop with more than one active Admin does not have a clear "which Admin re-authenticated?" identity in these flows; an active second Admin's unique password may not be accepted if another active Admin appears first.

Future authority contract:

- Every password-based Admin proof must identify an account (normalized email or stable local user ID), then main process must look up that exact record and independently verify that the account is active and role `admin`. The supplied identifier is only a lookup hint; never trust a renderer-supplied role.
- Do not use array order or "first active Admin" as an account-selection rule.
- For high-risk Recovery Key rotation, prefer a fresh proof using the selected active Admin account's unique password, so audit events can identify the responsible Admin. Whether a shared Admin PIN remains acceptable for less-sensitive actions is still an open product decision; a shared PIN does not identify which Admin performed the action.
- The authority must reject proofs for cashier, manager or technician accounts even when the renderer labels the current session Admin.
- Account deletion/deactivation/password changes must revoke or invalidate related short-lived capabilities and must not leave a previously issued Admin proof valid past its expiry.

Tests must cover at least two active Admin accounts: either Admin can verify by their own exact account identity; wrong password/identifier combinations fail; a cashier cannot pass by supplying another user's ID; disabling/deleting one Admin immediately invalidates that identity; and no behavior depends on users-array ordering.

## 14. Existing local password verifier is not standard PBKDF2-HMAC-SHA256 — 2026-11-26

A compatibility experiment established that the existing renderer password verifier must not be replaced with Node's built-in PBKDF2 verifier without a migration plan.

- `src/lib/utils.ts` defines a custom SHA-256 compression implementation and uses it inside a 600,000-iteration PBKDF2-style function. Its SHA-256 round-constant array currently contains `0xab1c7c7c` at K7.
- The SHA-256 constant sequence specified by [RFC 6234, section 5.1](https://datatracker.ietf.org/doc/html/rfc6234#section-5.1) has `0xab1c5ed5` at that position. The current renderer implementation therefore does not implement the standard SHA-256 primitive, despite the nearby PBKDF2-HMAC-SHA256 comment.
- A temporary, unconnected Node `crypto.pbkdf2` verifier was tested against a hash produced by the real renderer `hashPassword()` function. The positive compatibility assertion failed (Actions run [45777161380](https://github.com/sanjula26/Nexfix-POS/actions/runs/45777161380), test `verifies password hashes produced by the existing renderer hashPassword helper`). The malformed-input and legacy-format rejection checks passed.
- This finding explains why a standard Node PBKDF2 verifier cannot be substituted for the existing verifier format. It does not by itself prove that the existing stored hashes are recoverable by a standard library, nor does it establish a safe upgrade procedure.

**Safety decision for this change:** remove the experimental, incompatible helper and its failing test from this PR. Do not change the SHA-256 constant in-place: existing password hashes were generated and checked by the current custom implementation, and silently changing the implementation could lock existing local users out. No production authentication source, login UI, role flow, Admin PIN, backup or restore behavior was changed.

**Before implementing main-process credential authority, resolve one of these migration paths explicitly:**

1. Owner-present re-enrollment: require an existing owner/Admin to prove control through a separately reviewed recovery path, then create a new, explicitly versioned standard verifier. Define what happens when the old verifier cannot be trusted.
2. Compatibility-and-rehash: implement a strictly scoped verifier for the exact historical custom algorithm, validate it with fixed known-answer vectors and performance/lockout tests, and immediately rehash a successfully verified password into a versioned standard format. Do not continue using the custom algorithm for new credentials.

The second path carries extra code and review risk; neither path is approved by this note. The legacy SHA-256-only account format and Admin PIN format remain separate unresolved migrations. No renderer or main-process verifier was wired into production in this step.

## 15. Windows key-envelope replacement durability — 2026-11-26

The active Electron runtime and its Windows rename implementation were checked against the repository lockfile:

- `package-lock.json` pins Electron `44.11.4`. Electron's release record identifies bundled Node.js `24.22.3` ([Electron 44.11.4 release](https://releases.electronjs.org/release/v44.11.4)).
- Node.js tag `v24.22.3` includes libuv `1.52.1` in `deps/uv/include/uv/version.h` ([version header](https://github.com/nodejs/node/blob/v24.22.3/deps/uv/include/uv/version.h)).
- libuv `v1.52.1` Windows `fs__rename` calls `MoveFileExW(source, destination, MOVEFILE_REPLACE_EXISTING)` without `MOVEFILE_WRITE_THROUGH`; its `fsync` implementation calls `FlushFileBuffers` on the file handle ([libuv Windows source](https://github.com/libuv/libuv/blob/v1.52.1/src/win/fs.c)).
- Current `replaceProfileKeyEnvelope` writes a same-directory temporary file, calls `fs.fsyncSync`, closes it, re-checks the original envelope hash, calls `fs.renameSync`, and performs read-back validation. This is a good process-error/normal-I/O design, but a flushed temporary file plus successful read-back does not, by itself, demonstrate that the destination-name metadata is durable after sudden power loss.

Windows API findings:

- `MoveFileExW` provides `MOVEFILE_WRITE_THROUGH`; Microsoft says the call does not return until the file is actually moved on disk, and explicitly guarantees flushing for a move performed as copy+delete. Its documentation does not give a separately testable, hardware-independent power-cut guarantee for this exact same-volume replacement use case. Treat it as a stronger candidate to evaluate, not proof on its own ([Microsoft MoveFileExW docs](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)).
- `FILE_FLAG_WRITE_THROUGH` documentation says NTFS flushes metadata changes including rename operations, but hardware support for write-through to persistent media is not universal. A native implementation would need to be reviewed for the exact handle/rename sequence and tested on supported Windows filesystems and storage ([Microsoft CreateFile docs](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)).
- `ReplaceFileW` is not a shortcut for this guarantee: Microsoft's `REPLACEFILE_WRITE_THROUGH` flag is explicitly unsupported ([Microsoft ReplaceFileW docs](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)).

Existing regression coverage verifies a rename failure leaves the old envelope and pending rotation intact, and verifies retry after the rename committed but the IPC response was lost. It does not simulate abrupt power loss or a storage device that lies about flush completion.

A new regression test, `preserves the previous key envelope and permits retry when the temp-file fsync fails`, injects an `EIO` at the temporary-file flush boundary. It asserts that the old envelope bytes remain unchanged, the temporary file is cleaned up, the old key remains valid, the new key is not yet committed, and retry after restoring the flush call succeeds. This is a fault-injection test, **not** a power-loss durability test.

**Decision:** no change to production replacement code in this step. Do not describe Windows key-envelope rotation as proven power-loss durable. Before closing this blocker, evaluate a small native Windows commit helper using documented write-through flags or a versioned/two-generation recovery protocol; preserve a recoverable previous envelope until the new commit is durably selected; then run controlled crash/power-cut tests on actual supported Windows filesystems and operator machines. Do not assume the API flag alone proves behavior across removable media, storage-controller caches or every device.

## 16. Proposed Windows crash-consistent generation journal — 2026-11-26

This is a design proposal for review, not an implementation approval. The goal is that a crash at any point during Recovery Key rotation leaves one unambiguous, recoverable committed generation, while never destroying the previous committed envelope before the new commit is selected.

### Additional confirmed scope

- `electron/overflow-folder.cjs` rejects UNC/network paths and tells the user to choose an internal or attached external drive. It validates the folder, symlinks and write access, but does not inspect or restrict the volume filesystem type. A removable drive may therefore be NTFS, exFAT or another filesystem with different durability behavior.
- `electron/profile-storage.cjs` writes encrypted profile records to a temporary file, calls `fs.fsyncSync`, closes it, renames it over the destination and verifies the read-back. It calls directory `fsync` only when `process.platform !== 'win32'`. Therefore the same Windows destination-name durability question also affects encrypted `app_state`, `sync_queue`, `meta` and `restore_checkpoint` writes after folder-primary cutover. Do not treat this as a Recovery-Key-only issue.
- This proposal should converge on one main-process-owned durable file publication primitive for profile data and key-envelope commits. The existing renderer-facing generic profile IPC must remain unchanged in authority scope; this helper is internal to Electron main process and is not exposed through preload.

### Proposed on-disk generations

Keep the current `nexfix-key-envelope.json` as legacy generation 0. New rotations create immutable, uniquely named files in the same profile directory:

- `nexfix-key-envelope.g00000001.json` — validated wrapped-key envelope for generation 1.
- `nexfix-key-envelope.commit.g00000001.json` — commit marker for generation 1.
- Subsequent rotations create generation 2, 3, etc. Each candidate uses a random same-directory `.tmp` name before publication.

A commit marker contains only non-secret metadata:

- fixed format/version and profile ID;
- monotonically increasing generation number;
- the exact deterministic envelope filename for that generation;
- SHA-256 of the complete envelope bytes;
- SHA-256 of the previous commit marker (generation 1 is anchored to the original legacy envelope hash);
- a random operation ID and canonical timestamp.

Never put the Recovery Key, plaintext data key, passphrase, DPAPI plaintext or other secret in a marker. Do not accept arbitrary paths from a marker; derive the filename from the validated generation number. Do not use a replaceable `CURRENT` pointer file.

### Proposed commit sequence

1. **Prepare only in memory.** Reuse the current old-key proof and new-wrapper preflight. Keep the new Recovery Key and data-key copy in main-process memory; user acknowledgement must happen before any commit marker is published.
2. **Stage the envelope.** Write generation N+1 to an exclusive same-directory temp file, flush its file contents, close it, then parse it back, validate all wrappers and verify that the new Recovery Key opens to the same data key. Compute the envelope SHA-256.
3. **Publish the immutable envelope.** On Windows, a small internal N-API C++ helper is the preferred prototype candidate. It should validate that source and destination are normal non-reparse files in the same profile directory and same volume, reject an existing generation destination, and call `MoveFileExW(temp, final, MOVEFILE_WRITE_THROUGH)` without `MOVEFILE_COPY_ALLOWED` or `MOVEFILE_REPLACE_EXISTING`. A same-directory, unique destination avoids replacing an existing committed file. Read the final bytes back and compare their SHA-256 before continuing.
4. **Stage the commit marker.** Write the marker to a unique temp file, flush/close it, read it back, and verify its profile ID, generation, previous-marker hash, deterministic filename and envelope hash.
5. **Publish the commit marker last.** Publish the marker under its unique immutable generation name through the same native write-through path. This marker is the logical commit point. Re-open and validate the marker and envelope through the normal startup selection code. Return rotation success and clear pending secret material only after this succeeds.
6. **Retain the prior generation.** Keep at least the immediately previous complete envelope and all small commit markers until a fresh process has opened the selected new generation successfully. Cleanup must be a separate, retryable maintenance step; never remove the previous generation as part of the critical commit sequence. Deleting old files is not guaranteed secure erasure on SSDs/removable media.
7. **Idempotent retry.** If the IPC response is lost after marker publication, a retry checks the exact operation ID, generation and envelope hash. It returns success only for the exact already-committed operation; it must not publish a second generation or disclose the new key again after process restart.

### Startup and crash-recovery rules

- If no journal markers exist, load the legacy generation 0 exactly as today.
- A complete envelope generation with no final commit marker is an orphan candidate, not committed; continue using the previous committed generation.
- Ignore incomplete `.tmp` files after validating their names and ensuring they are not symlinks/reparse points. Clean them only in a separate safe cleanup step.
- Select only a fully validated, monotonically linked commit chain for this profile. Validate strict schema, marker hash, previous marker hash, envelope hash, exact filename, profile ID, generation bounds and envelope schema. Bound the number and size of files read during startup.
- If a final marker exists but its chain or envelope is inconsistent, do not silently guess or accept a stale Recovery Key. Enter an explicit recovery-required state and preserve all generations for diagnosis/recovery. A valid newest marker makes that generation current; old generation files are not accepted as the active credential.
- No marker published yet: old generation remains current. Marker published and validated: new generation is current. If the process dies after the marker commit but before the IPC response, a fresh process reads the new generation; this is why acknowledgement must precede marker publication.
- A hash chain detects accidental mismatch/reordering, but it is not a trusted anti-rollback anchor. A person who can replace the entire local folder or restore an old snapshot may still roll back the whole profile; do not claim protection against full-folder rollback or a compromised local machine.

### Windows publication helper candidates and limitations

- Candidate A: same-volume `MoveFileExW` with `MOVEFILE_WRITE_THROUGH`, unique destination names and no copy/delete fallback. Microsoft says the function does not return until the file is actually moved on disk and explicitly documents flushing for a copy/delete move. The exact same-volume generation-publication behavior still needs physical crash testing; the flag alone is not treated as proof ([MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)).
- Candidate B to compare experimentally: open the staged file with `CreateFileW` using `FILE_FLAG_WRITE_THROUGH`, then publish the rename on that same handle with `SetFileInformationByHandle(FileRenameInfo or FileRenameInfoEx)`. The write-through request belongs to the file-open flags; `FILE_RENAME_INFO.Flags` is only the rename-operation flags union used by `FileRenameInfoEx` and does not itself define a write-through flag. Microsoft documents that a write-through handle causes NTFS metadata changes such as rename operations resulting from processing that handle to be flushed, but the exact handle/rename sequence and filesystem behavior still need Windows tests. This is a candidate to test, not an established guarantee ([CreateFileW caching behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea), [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle), [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)).
- `ReplaceFileW` is not the write-through solution: `REPLACEFILE_WRITE_THROUGH` is explicitly unsupported ([ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)).
- Keep file-content flushing and namespace publication as separate steps. `FlushFileBuffers` flushes a file handle's buffered data; it does not, by itself, prove the later destination-name update is durable ([FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)).
- Native helper inputs must be constrained to internally generated paths under the already validated profile directory. Check same-volume identity, reparse points, regular-file attributes, ACL/write failures and existing destination collisions. Never accept arbitrary renderer-supplied paths. If the volume/filesystem does not meet the tested support matrix, fail the key rotation without touching the current generation and report a clear reason.

### Test plan and release gates

**Automated cross-platform/unit tests**

- Inject failure at every phase: envelope write, file flush, envelope publication, envelope read-back, marker write, marker flush, marker publication and marker read-back.
- Verify old generation remains selected before commit marker publication; new generation is selected after a valid marker is published; orphan generations and temp files never become current.
- Kill a child process at every phase, restart the profile session and verify recovery selection. Include lost IPC response after marker commit, retry, duplicate generation, generation overflow, marker hash mismatch, previous-hash mismatch, wrong profile ID, path traversal names, symlink/reparse files, destination collision and concurrent rotation.
- Verify that the old Recovery Key is rejected after a valid new marker is active, the new Recovery Key opens the unchanged data key, and the OS/passphrase wrappers continue to open the same data key.
- Verify the production ASAR contains only the reviewed native binary and no QA-only helper/test assets.

**Windows CI and physical acceptance**

- Windows CI must compile the native addon against the exact Electron headers, load it from the packaged app, and run same-volume success/failure tests on the hosted Windows filesystem. CI process termination tests are useful but are not a substitute for power removal.
- Physical test matrix must include Windows 10/11 on internal NTFS storage and the attached external drives the product intends to support (at minimum NTFS and exFAT). Record filesystem, device model, USB/controller path and cache/power settings.
- At each sequence boundary, terminate the process and separately perform controlled VM power-cut or physical power interruption on disposable profile copies. After restart, verify either the old committed generation or the new committed generation is recoverable as specified; never accept a mixed/partially written envelope or lose the encrypted profile data.
- Repeat each boundary enough times to expose timing variability. Capture Windows build, filesystem and storage hardware for every result. A green hosted CI run cannot certify a user's SSD, USB bridge or device firmware.
- Decide the supported filesystem matrix explicitly. The folder picker currently permits attached external drives without filesystem-type detection; do not promise equal durability on every external format until tested.

**Scope decision:** no native helper or generation journal is wired in by this documentation step. The next safe implementation should first add a pure parser/recovery-selector with fixture tests, then a Windows-only native publication adapter, then a shared write path for `profile-storage.cjs` after its own data-recovery semantics are reviewed. Do not patch only key-envelope rename and claim all folder-primary data is power-loss durable.

## 17. Separate Electron patch-level maintenance finding — 2026-11-26

- The current lockfile resolves Electron `44.11.4` (the package range is `^44.3.0`). Electron `44.11.6` was released on 2026-11-24 and includes additional fixes, including renderer-crash fixes; it still reports bundled Node.js `24.22.3` ([Electron 44.11.6 release](https://releases.electronjs.org/release/v44.11.6), [Electron 44.11.4 release](https://releases.electronjs.org/release/v44.11.4)).
- This is separate patch-level maintenance, not part of the durability design. Do not silently modify the lockfile in this commit. Before compiling a native helper or publishing a production installer, assess and preferably update the Electron lockfile in its own small commit, then rerun all four exact-head workflows and physical Windows smoke tests.

## 18. Pure generation-selector prototype completed; still unconnected — 2026-11-26

The first isolated part of the generation-journal proposal is now staged and tested:

- Added `electron/profile-key-generation-journal.cjs`. It is a pure, synchronous parser/selector: it performs no filesystem I/O, does not write/rename/delete files, and is not imported by `profile-key-store.cjs`, `profile-session.cjs`, startup recovery, preload or renderer.
- Its input is a bounded byte snapshot from an adapter that has already enumerated exact final commit-marker filenames and loaded corresponding envelope bytes. The module selects legacy generation 0 when no final commit marker exists; otherwise it validates a consecutive chain from generation 1, canonical marker filenames/JSON, fixed marker schema, profile identity, unique operation IDs, previous-marker hash, envelope hash, the actual v1 envelope schema via `validateProfileKeyEnvelope`, timestamp and size/count limits. A generation envelope with no final marker is an orphan and is not eligible for selection.
- Added `tests/profile-key-generation-journal.test.cjs`. Tests cover legacy generation selection, two consecutive committed generations, orphan ignored, gaps/duplicate generations, reused operation IDs, previous-marker hash mismatch, envelope hash mismatch, real envelope validator rejection, wrong identity/path-like marker names, malformed/non-canonical JSON, unknown fields, invalid timestamps and input/generation bounds.
- Updated `package.json` `test:domain` to also include `tests/profile-key-generation-journal.test.cjs`, `tests/profile-key-store.test.cjs`, `tests/profile-session.test.cjs`, and `tests/profile-storage.test.cjs`. Windows QA previously did not include these core profile suites; it now runs all four. `package-lock.json` was not changed.
- Exact head before this documentation follow-up: [`10a74ede8cb012cf14bd032c5b8b6c301ce03adc`](https://github.com/sanjula26/Nexfix-POS/commit/10a74ede8cb012cf14bd032c5b8b6c301ce03adc).
  - POS Security Audit [45783930911](https://github.com/sanjula26/Nexfix-POS/actions/runs/45783930911): SUCCESS.
  - POS CI [45783930902](https://github.com/sanjula26/Nexfix-POS/actions/runs/45783930902): SUCCESS — 327 tests, 326 passed, 0 failed, 1 skipped; Domain tests, Typecheck, Lint, production build and demo-password bundle check passed.
  - Windows Desktop Build (No Publish) [45783930938](https://github.com/sanjula26/Nexfix-POS/actions/runs/45783930938): SUCCESS — installer/portable EXE built; production ASAR 11,042 entries, no `electron/qa` files; checksums verified.
    - Installer SHA-256: `97dcd6f9901b5c1a70336f28b68f298521aaf9acf708ceec2274f4d7012eb0e2`
    - Portable SHA-256: `491094704fd6103d07ce41cfc4762723c55928e359e4710b306c3a317d316da4`
  - Windows Desktop QA (No Publish) [45783930907](https://github.com/sanjula26/Nexfix-POS/actions/runs/45783930907): SUCCESS — expanded Domain Regression Tests (229 passed, 0 failed, 0 skipped), Typecheck, Lint, renderer build, Electron paths, installer/portable, ASAR and checksum checks passed.
    - QA installer SHA-256: `863bd6e449be0dda5245d6d6939aeec07721d1c6c91e42d34faf631ee13b38fa`
    - QA portable SHA-256: `437b3dd339467b4850155d122df136dfa19da01224168a866e06acbbaaddeb8e`
- The native Windows publication adapter, marker/envelope file enumerator, process-restart recovery integration and migration from the legacy single-envelope file are not implemented. The pure selector prototype is a tested building block, not a durable journal and not a crash-consistent storage implementation.
- **Next safe implementation order:** define and test the filesystem adapter's filename/reparse-point/size handling and child-process recovery model first; then prototype a small Windows-only native no-replace write-through publication helper with Windows CI coverage; only after those pieces pass should key-envelope startup/finalization use the journal. Review how `profile-storage.cjs` data domains can share the commit protocol before changing its write path. Preserve legacy v1 reading and keep the previous generation until fresh-process reopen verification succeeds.
- Windows key-envelope and folder-primary data writes remain **not proven power-loss durable**. Physical power-cut tests on the supported internal/external filesystems and actual target hardware remain required. No production storage/key-store behavior changed in the prototype.
- Build and QA runs built on separate ephemeral runners. Code signing was skipped because no certificate is configured. Artifact uploads were skipped because the repository is public; the EXEs are not downloadable release assets.
- PR #293 remains OPEN / Draft / Unmerged. No Supabase operations, merge, R2 upload, production publish or EXE release occurred.

## 19. Bounded filesystem-reader review — 2026-11-26

The read-only journal reader added in commit `30e83e01c673d393d423c145dbda364dbf34c78e` was reviewed. The initial adapter bounded marker count and total file bytes, but used `readdirSync`, which allocated the full directory listing before those limits applied.

A focused follow-up now:
- Uses Node's synchronous directory-handle iterator (`fs.opendirSync`, `Dir.readSync`, `Dir.closeSync`) and caps the directory listing at **4,096 entries**. This leaves room for the 1,024-generation marker limit, corresponding generation envelopes, legacy envelope and normal profile files while bounding memory spent on directory names. The API is available in the pinned Node 24 runtime ([Node filesystem API](https://nodejs.org/api/fs.html#fsopendirsyncpath-options)).
- Confirms the directory identity and metadata remain stable across path canonicalization and after all snapshot reads. This detects common concurrent add/remove/replace activity, but is not a lock and cannot defeat a sufficiently timed path/reparse race.
- Treats the commit-marker prefix case-insensitively during discovery, then still requires the exact canonical lowercase marker filename. This prevents a case-variant marker from being silently missed on Windows' case-insensitive filesystems and causing an incorrect legacy-generation fallback.
- Adds regression tests that inject an over-limit directory iterator and verify it reads only one entry beyond the cap and closes the directory handle, and that a directory metadata change during the snapshot fails closed.

**Still not a production-safe Windows filesystem adapter:** path-based `lstatSync` plus `readFileSync` retains TOCTOU windows. On Windows, symlinks, junctions and other reparse-point tags require handle-based inspection. Microsoft documents `FILE_FLAG_OPEN_REPARSE_POINT` for opening the reparse point itself, then checking its attributes/tag via handle APIs ([CreateFileW](https://learn.microsoft.com/en-us/windows/desktop/api/fileapi/nf-fileapi-createfilew), [reparse-point operations](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-operations), [reparse points and file operations](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations)). This reader remains a testable prototype only; it is not wired to production startup, no native handle adapter exists, and power-loss durability remains unproven.
