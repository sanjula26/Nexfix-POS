# Windows acceptance checklist — IndexedDB overflow storage

Status: **Not yet run on a physical Windows PC.** This checklist is for a disposable test installation/profile only. Do not run quota, crash, or drive-disconnect tests against the live shop database.

## Safety rules

- Use a separate Windows test account or disposable Windows PC, a separate test POS profile, and a test folder on a removable drive.
- Export/backup the test data before each destructive scenario. Never use live customer, sales, or inventory data.
- Do not fill the Windows system drive to force a quota error. Do not use DevTools or scripts to modify the live POS database.
- Do not clear IndexedDB manually. The migration is expected to preserve it as the original source copy.
- Do not repeat a sale after a storage error until Sales History and pending sync status prove whether it committed.
- Never paste a passphrase, recovery key, access token, or private customer data into GitHub issues, Notion, screenshots, or logs.

## Test setup

- [ ] Install the candidate Windows Setup build on a disposable test machine/account.
- [ ] Prepare an empty test-only folder on a local or removable drive with enough free space.
- [ ] Create a test shop/profile with clearly fake products, customers, and sales.
- [ ] Record the app version, Windows version, disk type, and test folder type (local/removable/network). Do not record secrets.
- [ ] Confirm the selected folder is shown as configured and IndexedDB is still the primary store before any quota event.

## First-run profile and recovery

- [ ] Select the folder during first-run setup; cancel and retry once to confirm setup does not leave a partial profile.
- [ ] Create the encrypted profile using a unique test passphrase. Save the one-time recovery key offline in the test procedure.
- [ ] Confirm the app requires the explicit recovery-key acknowledgement before proceeding.
- [ ] Close and reopen the app. Confirm the existing profile is discovered and Windows OS unlock works.
- [ ] In a disposable Windows account/profile, verify OS unlock failure leads to the passphrase/recovery-key prompt and does not silently open a different profile.
- [ ] Confirm missing folder, duplicate profile, invalid profile, and wrong active profile fail closed without changing POS data.

## Quota-triggered migration

A controlled test-only quota injector or dedicated test harness is required. **Do not create artificial disk pressure on the Windows system drive.** If no safe test-only trigger is available in the candidate build, mark this section BLOCKED and request a dedicated QA build/harness.

- [ ] With the test profile only, trigger a genuine IndexedDB `QuotaExceededError` through the controlled test harness.
- [ ] Confirm the POS shows a storage error and warns not to repeat the sale.
- [ ] Confirm migration starts automatically without requiring the operator to click the manual “prepare migration” action.
- [ ] Confirm the app attempts Windows OS unlock. If OS unlock is deliberately unavailable in the test account, confirm it pauses for passphrase/recovery-key unlock.
- [ ] Confirm all four domains are copied: app state, offline sync queue, backup metadata, and restore checkpoint.
- [ ] Confirm every encrypted payload is read back and its byte count/SHA-256 is verified before cutover.
- [ ] Confirm the journal reaches `folder_primary` only after verification and the POS resumes only after the folder adapter is active.
- [ ] Confirm the original IndexedDB database and its data remain intact after cutover.

## Interruption and recovery

Use a disposable test profile and a controlled test harness that can stop the process at named migration phases. Do not terminate the live shop app.

- [ ] Stop during snapshotting; restart and verify the app either safely resumes/retries or remains blocked without losing IndexedDB data.
- [ ] Stop during encrypted payload copying; restart and verify incomplete files are not treated as complete.
- [ ] Stop during read-back verification; restart and verify cutover does not occur.
- [ ] Stop immediately before and after the `folder_primary` journal transition; verify uncertain cutover keeps POS closed until state is reconciled.
- [ ] Disconnect the removable drive before migration; verify the app blocks safely and reconnect/retry works.
- [ ] Disconnect the drive during copying; verify no partial migration is reported as successful and the original IndexedDB remains available.
- [ ] Reconnect the same drive and retry; verify a fresh snapshot is used and the journal reaches a consistent final state.
- [ ] Reboot Windows during a blocked-recovery state; verify the app does not silently fall back to stale or empty data.

## POS data integrity and workflows

- [ ] Create a test cash sale and a test credit sale before migration; after migration confirm each appears exactly once with the same bill number, totals, payment legs, and customer balance.
- [ ] Trigger a storage failure around a test sale. Check Sales History and pending sync before any retry; confirm no duplicate sale or duplicate offline queue entry is created.
- [ ] Create offline test transactions and confirm pending queue count and payloads survive migration; reconnect and verify each transaction syncs once.
- [ ] Create a test backup before migration and restore it into a separate disposable profile; verify totals and record counts.
- [ ] Verify backup metadata and restore checkpoint survive migration and the restore process can resume safely.
- [ ] Check inventory quantities, IMEI/serial unit statuses, repairs, quotations, kits, and settings against the pre-migration test snapshot.
- [ ] Repeat with a representative large test dataset and record migration duration, peak memory, and free disk space.

## Sign-off record

| Field | Result |
|---|---|
| Candidate commit / build | |
| Windows version and architecture | |
| Test folder type | |
| Test dataset size / record counts | |
| Quota trigger method (test-only) | |
| First-run / recovery | NOT RUN |
| Quota-triggered migration | NOT RUN |
| Interruption / reconnect | NOT RUN |
| Sales / offline queue / backup / restore | NOT RUN |
| Large dataset performance | NOT RUN |
| Tester and date | |
| Evidence location (no secrets or customer data) | |

## Release gate

- [ ] Every applicable section above passes on a physical Windows machine.
- [ ] Any blocked or failed scenario is fixed and rerun; attach exact logs/results without secrets.
- [ ] Windows installer and portable EXE are tested separately.
- [ ] A valid code-signing certificate is configured and the signed installer/EXE signatures are verified, or the release owner explicitly accepts the unsigned-build warning.
- [ ] PR #292 is reviewed and all required checks pass on its final head.
- [ ] Only after sign-off: merge and run the separately reviewed production/R2 publish process.

Until these checks are signed off, keep PR #292 Draft/unmerged and do not publish a production EXE.
