# Existing POS Profile Recovery Key Rotation — Safe Design

Status: design only; no rotation UI or IPC is enabled by this document.

## Safety invariant

The currently persisted Recovery Key wrapper must remain valid until the user has been shown the replacement Recovery Key and has explicitly confirmed that it has been saved somewhere safe. Never replace the persisted wrapper before that acknowledgement.

## Two-stage protocol

### 1. Prepare (no disk writes)

1. Require an unlocked profile and capture its canonical profile directory, profile ID, and current key-envelope bytes/hash.
2. Authenticate the supplied current Recovery Key by unwrapping the existing recovery wrapper. Reject without mutation if authentication fails.
3. Generate a cryptographically random 32-byte Recovery Key and a replacement AES-256-GCM wrapper around the same data key.
4. Preflight-decrypt the newly generated wrapper and compare the recovered data key with the active data key.
5. Store a pending rotation only in Electron main-process memory. Bind it to the active profile ID, canonical directory, original envelope hash, and an unpredictable one-time pending ID. Do not write the new wrapper to disk.
6. Return the new Recovery Key to the trusted renderer exactly for display/save. Never log it, include it in error text, persist it in preferences, or send it to Notion.

If the renderer reloads while Electron remains alive, a narrowly scoped pending-status IPC may re-display the same pending key. If Electron exits before acknowledgement, pending memory is lost and the old on-disk Recovery Key remains valid; the user can restart the process and try again.

### 2. Finalize (only after explicit acknowledgement)

1. Require the exact pending ID, an explicit `acknowledged === true`, and the same active profile still unlocked.
2. Re-resolve the profile directory and confirm it is the original canonical directory and still selected/authorized.
3. Re-read the key envelope and compare its hash with the captured original hash. If it changed, fail closed and preserve the pending state for safe reconciliation; do not overwrite another update.
4. Atomically replace only `recoveryWrappedKey`, preserving the OS and passphrase wrappers and the data key. Use the existing exclusive temporary-file + fsync + rename + read-back pattern.
5. Read back the persisted envelope, validate its schema/profile ID, decrypt the new recovery wrapper using the pending key, and compare the recovered data key to the still-active data key.
6. Only after successful read-back verification clear pending key material from main-process state and return a completion response that contains no Recovery Key.

The renderer must not clear the displayed key or report success before finalization returns success. The acknowledgement UI must make clear that the old Recovery Key stops working after finalization.

## Failure and crash behavior

- Wrong old key, malformed key, wrong profile, missing acknowledgement, changed selected folder, changed envelope, failed preflight, or failed temporary write: do not intentionally replace the old wrapper.
- Crash before atomic rename: old wrapper remains valid; pending in-memory key is lost; restart rotation.
- Crash after atomic rename: user has already acknowledged saving the new key. The new key must unlock the persisted wrapper.
- If the same process retries after rename but before receiving completion, detect the exact pending replacement wrapper on disk, verify it with the pending key, and finish idempotently rather than overwriting it again.
- Never attempt to roll back to the old wrapper after acknowledgement and successful replacement; doing so could invalidate the key the user has just saved.
- Clear pending key state on successful completion, explicit cancel, profile lock/switch, and any trust-boundary failure. Do not put recovery secrets in persistent logs or audit notes.

## Required regression tests before enabling the feature

1. Wrong old key leaves envelope byte-for-byte unchanged.
2. Prepare creates no disk changes; old key still decrypts and new key decrypts only the in-memory pending wrapper.
3. Renderer reload can retrieve the same pending key while the main process remains alive.
4. Missing acknowledgement, wrong pending ID, profile switch, folder change, and envelope-hash change all refuse finalization without replacing the old wrapper.
5. Successful acknowledgement replaces only the recovery wrapper; OS and passphrase wrappers and the underlying data key remain valid.
6. Persisted new wrapper is read back and successfully decrypted before completion is returned; old key no longer decrypts after completion.
7. Forced process exit before acknowledgement leaves the old wrapper valid on disk.
8. Forced process exit after acknowledgement/finalization leaves the new wrapper valid; retry in the same process is idempotent if completion delivery was interrupted.
9. No test output, IPC error, log, or persistent file contains the raw Recovery Key.
10. Mirror any production IPC/session changes byte-for-byte into the isolated QA runtime where that architecture requires parity.

## Scope boundary

This design does not change existing profile unlock, passphrase reset, Windows device-key rebind, IndexedDB-first storage, migration journal, POS login, updater, backup/restore, or Supabase behavior. Do not enable rotation until the full main-process session, trusted IPC, preload bridge, renderer acknowledgement UI, QA mirror, and CI tests are implemented and verified together.

## Implementation checkpoint — 2026-11-25

- Low-level prepare/finalize helpers now exist in `electron/profile-key-store.cjs`; finalize retry is idempotent only when the on-disk recovery wrapper exactly matches the pending replacement and decrypts to the retained data key.
- Main-process `POSProfileSession` now owns pending rotation state in memory, binds it to the active profile and canonical directory, supports renderer-reload retrieval, explicit acknowledgement/finalization and cancellation, and clears pending key material on lock or passphrase-wrapper changes.
- Trusted IPC and preload bridge operations exist for prepare, retrieve, finalize and cancel. IPC requires the active profile to be discovered under a currently selected/authorized storage root.
- Typed renderer bridge helpers are added, but no user-facing Settings UI is wired yet. Do not expose rotation to operators until the UI displays the replacement key, persists/re-displays pending state after renderer reload, and only reports success after finalize returns.
- Production and QA runtime copies of `profile-session.cjs` and `profile-ipc.cjs` were fetched back and confirmed byte-identical.
- Regression coverage now includes key-store prepare/no-write, wrong old key, successful wrapper replacement, envelope CAS failure, idempotent finalize retry, IPC acknowledgement gating, renderer-reload retrieval, old-key invalidation, lock cleanup, and explicit cancellation. These tests have not yet been executed; no CI success is claimed.
- Draft PR [#293](https://github.com/sanjula26/Nexfix-POS/pull/293) targets the existing profile-storage feature branch solely to obtain review/CI evidence. It remains OPEN / Draft / Unmerged. The latest head is `ff132b857596b59d6c51a1c353fc9696a7c93c8a` at the time of this checkpoint; later commits may advance it.
- No merge, Supabase operation, R2 upload, production publish, or physical Windows test occurred.
