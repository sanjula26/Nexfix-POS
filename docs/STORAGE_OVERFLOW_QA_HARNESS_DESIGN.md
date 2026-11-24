# Storage overflow QA harness — design and safety contract

Status: **Design only. No QA harness or physical Windows acceptance has been implemented by this document.**

This design closes the gap between the current automated synthetic-quota unit tests and the physical Windows acceptance checklist in `STORAGE_OVERFLOW_WINDOWS_ACCEPTANCE.md`.

## Goals

- Exercise the real IndexedDB write-failure → quota-warning event → automatic migration coordinator path.
- Exercise the real Electron encrypted profile, migration journal, folder-primary marker and restart recovery on Windows.
- Inject a deterministic quota failure without consuming disk space or damaging a Windows profile.
- Stop and restart a disposable QA process at named migration phases to test recovery.
- Keep every QA control out of production renderer APIs, production IPC registration and production installer artifacts.

## Non-negotiable isolation

1. Build a separate QA-only Windows package with a different Electron `appId`, product name, executable name and user-data directory from production.
2. Do not enable QA behavior using a runtime environment variable, command-line switch, URL query parameter, localStorage flag, hidden Settings button or user-editable config. A production installation must not be able to turn QA controls on.
3. Use a separate QA entry point and QA-only preload/renderer bridge. Do not add QA methods to the production `electron/preload.cjs` API.
4. The normal production packaging configuration must explicitly exclude QA-only entrypoint, preload, renderer panel, fixtures and marker files. The QA packaging configuration must explicitly include only the required QA files.
5. Give the QA app an offline-only fixture mode. It must not sign in to Supabase, call cloud APIs, register a device, run the updater, or access Google Drive/R2. Network access should be blocked during the acceptance run.
6. Accept only a freshly created disposable test profile and a test folder chosen by the tester. Require a QA-specific sentinel file and verify the resolved path is not the production POS user-data directory, Windows system directory, app install directory, or a live shop data folder.
7. Never point the harness at a production profile. Never read, copy, modify or delete production IndexedDB, userData, backup, updater, or Recovery Key files.
8. No QA build or QA artifact may be uploaded to R2, attached to a public GitHub release, or distributed as the production updater package.

## Controlled quota injection

- Inject at the IndexedDB transaction boundary in the QA renderer/test adapter, scoped to the QA app database and an explicitly selected write operation.
- The injector should throw a genuine `DOMException('QuotaExceededError')` once, with a visible QA run ID and operation label. It must not change browser quota settings, write large blobs, fill a drive, or monkey-patch the production application at runtime.
- The test must observe the same production event contract consumed by `App.tsx` and assert that the automatic migration coordinator starts without an operator click.
- Cover all four write domains: app state, restore checkpoint, offline queue and backup metadata.
- Include a negative test proving the injector is unavailable in a production build and cannot target any database other than the QA fixture database.
- After the injected failure, compare the pre-failure in-memory sale state, persisted IndexedDB state, queue and metadata to the encrypted folder copy. Verify every payload by read-back, byte count and SHA-256 before cutover.

## Named interruption points

The QA-only main process may stop the QA app after a durable checkpoint at each of these points:

- `after_snapshot`
- `after_copy_app_state`
- `after_copy_sync_queue`
- `after_copy_meta`
- `after_copy_restore_checkpoint`
- `after_verification`
- `before_folder_primary`
- `after_folder_primary_before_adapter_activation`

The stop action must terminate only the QA process, must never delete data, and must be driven by a one-shot test-run instruction stored outside the profile payload. On restart, the same QA app must inspect the encrypted journal and primary marker and either resume safely or remain blocked. It must never silently select an empty or stale store.

The before/after cutover cases are especially important: if the primary marker and journal disagree, the UI must remain closed until the pointer is reconciled. Do not simulate a successful cutover merely by changing an in-memory flag.

## Test sequence

1. Build and install the QA-only package on a disposable Windows account or VM. Confirm its app ID, executable name and user-data path differ from production.
2. Block network access. Create a fake shop fixture, fake sale, offline queue entry, backup metadata and restore checkpoint.
3. Select a new empty test folder and create/unlock its encrypted profile. Confirm IndexedDB remains primary.
4. Run one-shot quota injection for each write domain and verify the event-to-automatic-migration path.
5. Verify all four encrypted payloads, journal transitions and the primary-folder marker. Confirm IndexedDB remains intact as the original source copy.
6. Repeat using each named interruption point. Restart the QA app after each stop and verify recovery behavior.
7. Unplug/reconnect only the disposable test drive; verify blocked/retry behavior.
8. Verify sale exactly-once, queue exactly-once, backup/restore and a representative large fixture.
9. Remove the disposable QA profile and folder only after evidence has been reviewed and the tester confirms it contains no needed data.

## Required automated safeguards

- Production build test: no QA-only IPC channels, preload methods, renderer controls, marker files or QA entrypoint in the packaged file list.
- QA build test: QA controls exist only in the QA package and reject production paths/profile IDs.
- IPC tests: reject untrusted renderer frames, invalid run IDs, unknown phases, repeated stop instructions and any non-QA profile.
- Migration tests: all four domains, interrupted writes, partial files, hash mismatch, journal/marker disagreement, uncertain cutover and restart retry.
- CI: build and checksum the QA package as a no-publish job; do not upload the artifact. Run all unit/integration tests on the exact commit.
- Physical acceptance: manually install and run the QA package on a disposable Windows machine. CI packaging success is not physical acceptance.

## Current gap and release gate

The current branch has synthetic `QuotaExceededError` unit tests and migration-core dependency-injection tests, but no operator-accessible packaged QA trigger or named-phase process-stop harness. The physical acceptance scenarios therefore remain **BLOCKED / NOT RUN**.

Implement this design in small steps, first proving production-package exclusion and QA app isolation, then adding quota injection, then interruption/restart controls. Do not merge PR #292 or publish an EXE/R2 release until the separate Windows acceptance checklist is completed and signed off.


## Existing Windows workflows are not the offline QA harness

The current `.github/workflows/windows-no-publish-qa.yml` workflow is a non-publishing production-app build/regression workflow, not the isolated storage-overflow QA package described above. It builds the normal Vite renderer and invokes the normal production Electron Builder configuration. Its renderer build supplies the public Supabase project URL and publishable anon key as build-time configuration. The workflow does not provide a packaged quota injector, named-phase interruption controls, or a disposable offline-only QA app. Therefore its green result proves production packaging/regression checks only; it must not be reported as physical storage-overflow QA acceptance.

Likewise, `scripts/build-windows-test.ps1` explicitly configures the live Supabase project and prompts the operator to confirm a live-cloud test. Do not reuse that script for the offline harness or run it as part of offline acceptance.

Implementation gate: create a distinct QA builder configuration and entry point with a separate app identity/user-data path. The QA build must not reuse the production renderer build command, production main process, updater initialization, or cloud-connected test script. Add explicit automated assertions for the QA app identity, offline-only bridge and production-package exclusion before adding any quota or interruption controls.
