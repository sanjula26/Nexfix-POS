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

## 14. Isolated main-process password verifier primitive — 2026-11-26

A small, deliberately unconnected primitive has been staged to reduce risk in a future authority migration:

- `electron/local-auth-crypto.cjs` verifies the current local POS verifier format: standard Base64 salt (16 bytes), one separator, and standard Base64 PBKDF2-HMAC-SHA256 digest (32 bytes), using 600,000 iterations.
- The implementation uses Node's asynchronous `crypto.pbkdf2`, checks canonical Base64 and exact byte lengths before deriving, compares equal-length digests with `timingSafeEqual`, and clears temporary salt/digest buffers after verification.
- Legacy 64-character SHA-256-style hashes are deliberately rejected by this primitive. Their migration/re-enrollment policy remains unresolved; this does not silently bless the legacy format as a new authority credential.
- `tests/local-auth-crypto.test.cjs` covers a current-format positive/negative password check, malformed/non-canonical inputs, legacy rejection and invalid argument types. The existing POS CI invokes `npm test`, so the new Node test is discovered without changing the test script.
- This helper is not imported by production login, renderer state, preload, IPC, backup or restore code. It does not create an authority record, copy credentials, change roles, implement lockout or authorize an operation. No user-facing authentication behavior changed in this step.

This is a tested building block only, not a completed main-process Admin authority. The account bootstrap/re-enrollment, multi-Admin identity, PIN policy, profile sidecar migration, backup compatibility, session and restore policies listed above still need explicit decisions and dedicated integration tests before the primitive is connected.
