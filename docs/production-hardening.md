# Nexfix POS — Production Hardening & Operator Release Checklist

This document describes the security boundary of the current main branch and the steps that must still be performed outside source code before a shop is put into production.

## 1. Security model

### Local POS authentication
- Local POS login remains the authoritative login for offline operation.
- Passwords use the existing salted PBKDF2-HMAC-SHA256 implementation with the high iteration count.
- Failed logins use persistent per-device backoff/temporary lockout and generic credential errors.
- Failed and sensitive authentication actions are written to the local audit log.
- A fresh production install has no known users. First-run administrator setup is mandatory and requires a 12+ character password.
- VITE_SEED_DEMO=true is development-only. Production/Electron release workflows must not enable it.
- Legacy seeded identities using the retired admin123/cashier123 credentials are removed during state migration. A real account that changed its password is not removed merely because it reused the historical email.
- The historical nexfix_role_switch sessionStorage bypass is removed. mustChangePassword is enforced even after an admin/cashier session switch.

### Cloud/Supabase
- A local role is not proof of cloud privilege.
- Cloud operations use authenticated PostgreSQL RPC boundaries and RLS.
- Private SECURITY DEFINER implementations are not executable by anon or authenticated.
- Cloud snapshot publishing requires an authenticated user, active membership in the requested shop with the required admin role, and a registered device belonging to that user and shop.
- Snapshot payloads are sanitized so local user/password data and adminPinHash are not stored in cloud snapshots.
- Shop IDs are checked against the authenticated membership; changing a local shop ID does not grant access to another shop.
- Local/offline POS operation does not depend on Supabase being reachable.

### Google Drive backup
The path is:

Nexfix POS -> HTTPS Google Apps Script Web App -> shop-partitioned Google Drive

The Google transport API key is not POS authentication and is not a secret once compiled into a client bundle.

The backup endpoint has two independent boundaries:
1. NEXFIX_BACKUP_API_KEY — transport/API abuse gate.
2. Per-shop proof derived from the shop recovery key + shopId — possession of only the global client transport key does not authorize another shop.

Every backup write and sensitive read requires shopId, requestId, valid transport API key, and valid per-shop proof.

Sensitive reads are backupStatus, getLatestBackup, and getBackupPart. The public ping endpoint remains intentionally unauthenticated and returns no business data.

Each shop is partitioned by a deterministic SHA-256-derived Drive folder name. A SHOP_AUTH.json authorization record is created inside the shop folder on the first legitimate backup and stores only a proof digest, not the recovery key itself.

New backup uploads must be encrypted. Plaintext/legacy backup uploads are rejected. Backup payloads exclude local user records/password hashes, adminPinHash, and local authentication/session secrets.

## 2. Required operator setup before production

### A. Make the source private
1. Make the GitHub repository Private before distributing production source.
2. Do not commit .env.local, Supabase service-role keys, database passwords, Google credentials, or backup API keys.
3. Repository privacy does not affect an already-built Electron EXE because production loads packaged local web assets.

### B. Configure Google Apps Script
1. Open Apps Script -> Project Settings -> Script Properties.
2. Create/update NEXFIX_BACKUP_API_KEY with a long random value generated outside the repository.
3. Save the property.
4. Deploy a new Web App version containing the current google-apps-script/Code.gs.
5. Keep the Web App on HTTPS and use the /exec deployment URL.
6. Keep the master Drive backup folder private.
7. For every existing shop, perform one legitimate backup from a device that has that shop's recovery key. This initializes/validates the shop-specific SHOP_AUTH.json boundary.
8. Never paste the API key into committed source.

Google Apps Script Script Properties are the operator-managed location for script-wide configuration. https://developers.google.com/apps-script/guides/properties

### C. Configure the Nexfix production build
Set:
VITE_GOOGLE_BACKUP_API_KEY=<same value as NEXFIX_BACKUP_API_KEY>

Do not set:
VITE_SEED_DEMO=true

Then rebuild the Windows EXE.

The compiled Google API key must be treated as a transport credential, not as a password. If it leaks, rotate it; the per-shop proof still prevents the leaked transport key alone from authorizing another shop.

### D. Deploy Supabase migrations
1. Link the correct Supabase project.
2. Run: supabase migration list
3. Run: supabase db push --dry-run
4. Review the exact pending migrations.
5. Apply with: supabase db push
6. Never use --include-seed on the production database.

If migration history and actual schema disagree, do not blindly rerun migrations. Verify the actual database state first, then use Supabase migration repair only for migrations whose schema changes are already present.

Supabase documents db push as the normal deployment path and migration repair for history/schema mismatches. https://supabase.com/docs/guides/deployment/database-migrations

### E. Production build
1. Build without VITE_SEED_DEMO.
2. Verify the fresh build starts the administrator setup screen.
3. Create a unique administrator password of at least 12 characters.
4. Create cashier/manager/technician accounts explicitly from the administrator account.
5. Never publish screenshots or documents containing real passwords, recovery keys, or API keys.

## 3. Mandatory real-world acceptance drills

### Two-shop backup isolation drill
Use Shop A and Shop B, with different shop IDs and different recovery keys.

Verify:
- Shop A backup succeeds.
- Shop B backup succeeds.
- Shop A restore sees only Shop A.
- Shop B restore sees only Shop B.
- Shop A shopId + Shop B proof is rejected.
- Correct shop proof + missing/wrong API key is rejected.
- Correct API key + another shop's proof is rejected.
- backupStatus, getLatestBackup, and getBackupPart reject missing/wrong proof.

### Two-device cloud drill
Use two physical PCs with two registered devices.

Verify:
- both devices belong to the intended shop;
- a device registered to Shop A cannot publish to Shop B;
- a non-admin cannot publish a full cloud snapshot;
- sales/returns use the authenticated server RPC path;
- stale revisions produce a conflict instead of silently overwriting newer cloud state;
- offline operation still works when Supabase is unavailable.

### Offline single-shop drill
Disconnect the PC from the internet and verify:
- login still works;
- POS sale works;
- stock/IMEI/serial tracking works;
- GRN/purchase return works;
- local audit works;
- no cloud failure prevents normal local POS use.

## 4. Backup key rotation

When the Google transport key may have leaked:
1. Generate a new random key.
2. Change Apps Script Script Property NEXFIX_BACKUP_API_KEY.
3. Deploy the updated Apps Script version.
4. Update VITE_GOOGLE_BACKUP_API_KEY in the production build environment.
5. Rebuild/reissue the Windows EXE.
6. Test one backup and one restore.
7. Confirm the old key is rejected.
8. Keep the shop recovery key unchanged unless there is a separate recovery-key compromise.

The per-shop proof digest is independent of the transport API key, so normal API-key rotation does not require reinitializing SHOP_AUTH.json.

## 5. Release/security gates

The repository security workflow checks:
- no service-role/private Supabase credentials in source;
- no tracked .env.local;
- demo credentials are confined to the explicitly guarded demo seed path;
- production/release configuration does not enable VITE_SEED_DEMO;
- the mandatory password-change bypass is absent;
- Google backup requires API-key authentication, shopId, requestId, and per-shop proof;
- plaintext/legacy backup uploads are rejected;
- backup shop partitioning and SHOP_AUTH.json authorization are present;
- cloud snapshot admin membership + device ownership boundaries are present;
- private transaction/snapshot implementations are not executable by API roles;
- high-severity npm audit findings fail the security workflow.

## 6. Delivery channel

- Production: Windows Electron installer/portable EXE.
- Preview/development: GitHub Pages.
- Not production: Netlify.

Electron security remains enabled:
- context isolation
- sandbox
- Node integration disabled
- web security enabled
- restricted navigation/window opening
- minimal preload

## 7. Current source-level checklist

- [x] Production seed is opt-in only.
- [x] Fresh production install requires first-run administrator setup.
- [x] Legacy default credentials are retired during state migration.
- [x] mustChangePassword cannot be bypassed by the old role-switch marker.
- [x] PBKDF2 password hashing retained.
- [x] Login backoff/lockout and audit retained.
- [x] Google backup API key fails closed.
- [x] Google sensitive reads require authentication.
- [x] Google writes/read requests require shop ID and request ID.
- [x] Per-shop backup proof prevents API-key-only cross-shop access.
- [x] Backup payload auth secrets are removed.
- [x] Supabase private RPC execute privileges are revoked.
- [x] Cloud snapshot requires active shop membership + registered device ownership.
- [x] Local login never auto-creates a cloud shop/admin identity.
- [x] Electron production path remains hardened.
- [x] Security CI assertions are extended.

The remaining green-light items are real operator/deployment drills, not missing source-code controls. Do not release a shop until those drills have passed.
