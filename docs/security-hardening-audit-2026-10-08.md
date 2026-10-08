# Nexfix POS Security Hardening Audit

Date: 2026-10-08

## Deep-study scope

Reviewed before editing:
- electron/main.cjs — safeStorage, updater credential restore/save/clear, trusted-renderer IPC, private update gateway, direct installer download, SHA-512 verification, installer handoff, cloud recovery.
- electron/preload.cjs — contextBridge surface for updater/cloud recovery and update events.
- src/App.tsx — protected routing, must-change-password enforcement, cloud updater lifecycle, existing session-security behavior.
- src/components/AppLayout.tsx — configurable idle lock, admin/cashier role switch lock, trusted UI shell.
- src/lib/store.tsx — local login, PBKDF2 verification, login backoff, role switching, admin PIN, sensitive re-auth, restore/export gates, permissions/users, audit logging.
- src/pages/Login.tsx, src/pages/Users.tsx, src/pages/Permissions.tsx — login UX, account/role administration, permission matrix.
- src/pages/Settings.tsx — backup/restore, Recovery Key reconnect, auto/manual Drive backup, private updater setup/check/download/revoke, session-security settings.
- src/lib/driveSync.ts, src/lib/backup.ts, src/lib/backupCrypto.ts — Drive transport, automatic/manual scheduling, encrypted backup, Recovery Key/shopProof behavior.
- google-apps-script/Code.gs — existing API-key/shopProof/Recovery Key/VERSION contract.
- src/lib/cloudAuth.ts, src/lib/cloudSync.ts, src/lib/machine.ts — cloud session, shop membership, device identity and updater provisioning.
- supabase/migrations/*security* and updater/device migrations — RLS/RPC execution boundaries, device authorization/revocation, updater token storage.
- supabase/functions/desktop-updates/index.ts — private update authentication, device token validation, membership/admin check, signed R2 URL, installer metadata.
- index.html — existing restrictive CSP.

## Existing security strengths retained

- Local POS login remains authoritative for offline operation.
- Passwords are upgraded/verified with the existing PBKDF2 path; login has persistent bounded backoff.
- mustChangePassword, loginAtRef, role switching and permission checks remain intact.
- Sensitive restore, Recovery Key reconnect, managed-password, admin-PIN, user, permission, and bill-reversal approval paths already use the existing admin re-auth mechanism.
- Idle locking already existed with a configurable 1–120 minute setting and preserves the current POS state/cart.
- Google Drive backup remains encrypted and scoped by shop Recovery Key/shopProof; the Apps Script transport contract was not refactored.
- Private Windows updates remain device-token authenticated, safeStorage-backed, SHA-512 verified, and served through the private Supabase/R2 gateway.
- Electron renderer IPC remains isTrustedRenderer gated; preload still exposes only the existing narrow contextBridge surface.

## Security changes made

1. Idle-lock recovery hardening
- An idle-locked terminal can now be unlocked by the current active user password or an active administrator credential/admin PIN.
- Unlock attempts are rate-limited to 3 failures followed by a 30-second lockout.
- Unlock does not clear the cart or local POS state.
- mustChangePassword users cannot bypass the required password-change flow through the idle-lock overlay.

2. Updater device identity visibility
- Settings → App updates now shows the registered updater device identity used by the Windows private updater.
- Existing explicit Revoke this PC's update access remains admin re-authenticated and does not affect POS login or Google Drive backup.

3. Server-side device revocation repair
- The live Supabase project was verified to use pos_devices.user_id.
- The previously missing/broken public revoke RPC was repaired.
- Revocation is admin-membership checked and clears both revoked_at and the persistent updater token hash.
- The privileged implementation now lives in the private schema; the exposed public function is an invoker wrapper.
- Anonymous execution is revoked; authenticated execution is explicitly granted.
- Repo migrations are aligned to the live migration versions.

## Explicit regression shields

- scheduleGoogleBackup / startAutoBackup were not changed.
- Manual “Backup now to Google Drive” transport was not changed.
- Recovery Key, SHOP_AUTH, shopProof, API key and Apps Script VERSION behavior were not changed.
- update:check and update:downloadAndInstall were not changed.
- safeStorage updater token persistence and trusted IPC were not changed.
- Private updater SHA-512 verification and portable-vs-installed behavior were not changed.
- Core POS, sales, GRN, units/IMEI, repairs, warranty, kits, quotations, exchanges, IndexedDB and SearchableSelect code were not refactored.

## Verification notes

The live Supabase schema was inspected before changing the revoke boundary. The live pos_devices table has RLS enabled and exposes user_id, revoked_at, and the hashed updater-token fields.

Supabase security advisors after the hardening report:
- Existing INFO: desktop_bootstrap_tokens has RLS enabled without a policy.
- Existing WARN: Supabase Auth leaked-password protection is disabled; this is a hosted Auth project setting rather than a POS client/RPC code path and was not changed because the connected project-management surface does not expose that Auth setting.
- The updater revoke boundary was moved out of the exposed public SECURITY DEFINER function path; the public entry point is now an invoker wrapper.

The remaining hosted Auth leaked-password-protection warning is a deployment-setting follow-up, not a regression in local POS password hashing or the private updater/Drive backup paths.