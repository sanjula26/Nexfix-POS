# NexFix POS Security Hardening — 2026-10-08

## Deep-study files read

- electron/main.cjs
- electron/preload.cjs
- src/lib/store.tsx
- src/lib/types.ts
- src/pages/Login.tsx
- src/pages/Users.tsx
- src/pages/Permissions.tsx
- src/pages/Settings.tsx
- src/components/AppLayout.tsx
- src/lib/driveSync.ts
- src/lib/backup.ts
- src/lib/backupCrypto.ts
- google-apps-script/Code.gs
- index.html
- supabase/functions/desktop-updates/index.ts
- supabase migrations covering device registry/revocation, active-device enforcement, cloud snapshot hardening, and persistent updater device tokens
- package.json and CI workflow definitions

## Existing security strengths

- Local passwords use PBKDF2 verification through the existing password helpers; login has bounded local failure backoff.
- Role switching already authenticates the target admin/cashier account and has a separate rate limiter.
- Electron uses contextIsolation, sandboxing, nodeIntegration=false, a preload contextBridge, navigation restrictions, and renderer trust checks.
- Updater device credentials and cloud recovery credentials use Electron safeStorage.
- Private updater uses the Supabase desktop-updates gateway and retains SHA-512 installer verification.
- Google Drive backup retains the existing Apps Script API-key/shopProof contract, encrypted backup path, Recovery Key, shop partitioning, and RECOVERY_KEY.txt flow.
- Supabase migrations contain active-device/revocation concepts and the private updater checks device authorization.

## Implemented hardening

- Added configurable idle session lock (default 10 minutes, bounded to 1–120 minutes).
- Idle lock preserves the POS state/cart and works offline; unlock uses the current user's password, or admin unlock password for an admin.
- Added fresh administrator re-authentication for sensitive operations: user account changes, user activation/deletion, permission matrix changes, bill reversal approval, full backup import/export, Drive backup/restore, Recovery Key/shop reconnect, managed password changes, admin unlock-password changes, and destructive local reset.
- Sensitive audit entries do not contain passwords, Recovery Keys, tokens, or API keys.
- Gated updater IPC set/clear/status/check/download handlers with the existing trusted-renderer check.
- Preserved safeStorage updater credential storage and private gateway/SHA-512 flow.
- Added owner-scoped server-side updater-device revocation and an admin-gated Settings control.

## Backup/update regression review

- Automatic Google backup still runs through startAutoBackup() -> downloadBackup(..., cloud:true) and preserves durable retry metadata.
- Manual Google backup still uses the existing downloadBackup(..., cloud:true) transport from Settings.
- Recovery Key and shop identity reconnect paths remain the existing backupCrypto/driveSync paths.
- Private update check/download still uses the existing private Supabase gateway, device credentials, electron-updater, and SHA-512 verification.
- Portable-vs-installed update behavior remains unchanged.

## Device revocation finding

The live Supabase project uses public.pos_devices(user_id, revoked_at). The owner-scoped public.revoke_pos_device(text,text) RPC was deployed and verified against that production schema. Settings now exposes an admin re-authenticated “Revoke this PC's update access” action; it revokes the server device and clears only the local updater credentials. POS login and Google Drive backup credentials remain untouched.

## Verification limitations

GitHub MCP access was used for repository inspection and commits. Direct git cloning is unavailable in this execution environment, so a local npm install/typecheck/lint could not be run. The repository CI workflow remains the authoritative build/typecheck/lint gate.

## Manual acceptance tests

1. Set Settings → Session Security → Idle lock to 1 minute. Leave the POS untouched; the lock overlay should appear and the current POS work should remain intact.
2. Unlock with the current user's password. For an admin, the configured admin unlock password should also work.
3. Attempt a user/permission change. The first sensitive action after the 5-minute fresh-auth window must request administrator credentials; wrong credentials must not mutate state.
4. Use Backup now to Google Drive with the existing Recovery Key. Confirm success and that normal backup metadata still updates.
5. Trigger automatic backup by setting a short test interval and leaving the POS online. Confirm the normal encrypted Drive transport and Recovery Key behavior remain intact.
6. Restore a Google backup. Confirm both the existing restore confirmation and the new administrator re-authentication occur before local state replacement.
7. In an authorized installed Windows build, Check for updates / Update now. Unauthorized devices must remain blocked; authorized devices retain the private gateway and SHA-512 verification path.
