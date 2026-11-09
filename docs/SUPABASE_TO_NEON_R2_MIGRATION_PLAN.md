# NexFix POS — Supabase to Neon + Cloudflare R2 Migration Plan

Status: design only; no production data, Supabase project, Cloudflare account, or release configuration changed.

## 1. Goal and non-negotiable safeguards

Remove the runtime dependency on Supabase services while preserving:
- Offline-first Electron POS and IndexedDB as the operational source during outages.
- Local POS login, admin/cashier/manager/technician roles, password hashes, PINs, and first-login password-change rules. Local POS credentials are not Cloud Auth credentials.
- Shop and branch isolation; memberships and server-side authorization.
- Atomic sales, credit settlement, returns/exchanges, GRN, inventory units/IMEI/serial, repairs, warranty, kits, quotations, and stock adjustments.
- Google Drive encrypted backup, Recovery Key, restore, and shop-proof isolation. Do not silently repoint existing Drive backup identities.
- One-time Windows device authorization. The first authorization is required; a DPAPI/safeStorage-encrypted device token is reused on subsequent starts and updates. Reauthorization is required only after explicit revoke, token loss/corruption, or server-side rejection indicating revocation.
- Private Windows update delivery, SHA-512 verification, signed/short-lived download authorization, and safe install/relaunch.
- No service-role, database-owner, R2 secret, or signing secret in Vite/browser/Electron renderer code.

No destructive migration, production cutover, or Supabase deletion is allowed until backups and parity tests pass.

## 2. Proposed replacement architecture

| Responsibility | Proposed service | Notes |
|---|---|---|
| PostgreSQL | Neon Postgres | Preserve PostgreSQL schema, constraints, transactions, SQL functions, and most RLS logic. |
| Authentication | Neon Auth (Managed Better Auth) | Email/password identity and JWT. Review its supported feature matrix before committing. |
| Browser database API | Neon Data API | PostgREST-compatible API; use JWT + RLS. Verify exact endpoints and SDK compatibility in a spike. |
| Private updater / privileged backend | Cloudflare Worker | Verify Neon Auth JWT, enforce shop/device permissions, issue short-lived R2 download URLs, and expose narrowly scoped server actions. |
| Installers, update metadata, encrypted file objects | Cloudflare R2 Standard | Private bucket; Worker-mediated access; no public bucket/object URLs. |
| Local operational state | IndexedDB | Remains available without network; cloud sync is asynchronous and conflict-aware. |
| User backup | Existing encrypted Google Drive workflow | Keep independent of database/Auth migration. Remove its dependency on ensureCloudShop only after a separately tested stable Drive shop identity and authorization flow exists. |

Do not move the operational relational database into R2. R2 is object storage, not a relational database or authentication service.

## 3. Why Neon is the first candidate

Neon offers managed PostgreSQL, a PostgREST-compatible Data API, and Managed Better Auth. This is a better fit than moving the current relational model to SQLite/D1 because NexFix relies on PostgreSQL transactions, RPC functions, constraints, and branch-level RLS.

Important caveats:
- Neon Managed Auth availability and project requirements must be checked at provisioning time (current docs state AWS regions and restrictions involving IP Allow / Private Networking).
- Supabase password hashes cannot be transferred as-is to Neon Auth; users may need a controlled password reset/re-enrollment. Do not claim existing cloud passwords will continue to work.
- Existing Supabase sessions/JWTs will not remain valid after cutover.
- The Neon Supabase-compatible auth adapter may reduce auth call-site changes, but it is not a complete drop-in replacement for supabase-js.
- Neon Data API's PostgREST compatibility must be proven against the app's actual from(), rpc(), filters, upserts, returning/select behavior, and error handling.
- Free plans have hard usage ceilings and can suspend compute when quotas are exhausted. Free is a cost target, not a business-continuity guarantee.

## 4. Repository dependency inventory (initial scan)

Current main still has @supabase/supabase-js in package.json and src/lib/supabase.ts constructs a Supabase client from VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.

Direct Supabase integration points found in the initial scan:
- src/lib/supabase.ts: auth client, durable Electron session storage, session restoration, explicit sign-out marker, refresh-token recovery.
- src/lib/cloudAuth.ts: shop resolution, register_pos_device, authorize_pos_updater_device, secure device-token persistence.
- src/lib/cloudLegacyAuth.ts: legacy updater authorization migration.
- src/lib/cloudSync.ts: shop membership, branches, products, sales, stock, inventory units, customers, purchases, returns, repairs, and RPC calls.
- src/lib/cloudSyncBridge.ts: queued cloud sync.
- src/lib/store.tsx: direct sales/inventory reads and cloud RPC use.
- src/components/ShopSwitcher.tsx: shop membership, shops, device registration.
- src/pages/Settings.tsx: branch creation, device branch binding, tracked inventory transfer.
- apps/owner-web: separate Supabase Auth/Data API client and deployment configuration.
- .github/workflows/desktop-build.yml, .github/workflows/github-pages.yml, .env.example, and apps/owner-web/.env.example: Supabase build-time configuration.
- Supabase migrations and Edge Function desktop-updates: schema, RLS, privileged RPCs, and private update gateway.

This list is not yet a complete symbol-level inventory. Before implementation, enumerate every supabase.from, .rpc, .auth, .functions, Storage, Realtime, and environment-variable use across the entire repository, including tests and workflows.

## 5. Migration phases and gates

### Phase 0 — Preserve and extract
1. Keep the current paused Supabase project and its data intact. Do not delete it.
2. Obtain/download a full database backup and Storage object inventory from the Supabase dashboard/export path available to the owner. If the project cannot be resumed without a paid plan, do not bypass that restriction; use available exports and document any inaccessible data.
3. Export schema, functions, triggers, policies, grants, extensions, migration history, Auth user list/metadata, and Storage object metadata.
4. Verify backup checksums and restore the backup into an isolated local PostgreSQL instance.
5. Record current production counts and key financial/inventory invariants from an available trusted export.

Gate: backup is readable, checksummed, and restored successfully before any schema conversion.

### Phase 1 — Provider compatibility spike (no production changes)
1. Create a separate Neon test project/branch and enable Neon Auth/Data API only after checking region and feature compatibility.
2. Import a copy of the schema and a sanitized dataset.
3. Port the existing SQL migrations in order; classify Supabase-only functions, extensions, auth helpers, storage references, and Edge Function dependencies.
4. Implement/test a compatibility layer for auth.uid(), role claims, and shop membership. JWT claims must be cryptographically verified; never trust client-supplied shop_id or role.
5. Prove Neon Data API compatibility for the exact query patterns used by NexFix.
6. Test all SECURITY DEFINER functions with least-privilege ownership, fixed search_path, explicit grants, and membership/device checks.

Gate: all existing critical SQL and API contract tests pass against Neon before application code is switched.

### Phase 2 — Authentication and device authorization
1. Set up Neon Auth email/password, verification/reset flows, trusted origins, and admin provisioning.
2. Map old Supabase user IDs to new Neon Auth user IDs in a migration mapping table. Preserve shop_memberships relationships through this mapping; do not assume IDs are identical.
3. Because password hashes cannot be migrated, design a controlled first sign-in/password reset process. Keep local POS passwords untouched.
4. Rebuild updater authorization as a server-verified device flow: first-time admin/member authorization issues a high-entropy device token; persist it only through Electron safeStorage/Windows DPAPI; bind it to the stable machine ID and shop; subsequent updater calls reuse it without interactive authorization.
5. Revocation must invalidate the server-side token. Network/DNS/timeouts must not erase a valid locally stored token. Only explicit revoke, confirmed token rejection/revocation, or secure-store corruption may require reauthorization.

Gate: first authorization, app restart, Windows restart, cloud-session expiry, offline start, cashier/admin switching, token rotation, revoke, and reauthorization tests pass.

### Phase 3 — Cloudflare Worker and R2
1. Create private R2 buckets for release installers/manifests and (only if separately required) encrypted backup objects. Use distinct prefixes/buckets and per-shop opaque identifiers.
2. Move desktop-updates Edge Function logic to a Cloudflare Worker. Verify Neon JWT, active shop membership, registered device, device-token hash, release channel, version, and authorization before issuing a short-lived signed download URL.
3. Keep release metadata authenticated; do not expose bucket listing or permanent public installer URLs.
4. Verify SHA-512 from a trusted signed manifest before install. Keep private signing secrets server-side.
5. Keep installer delivery independent of POS sales/database sync. Installer install must wait for a safe idle state or explicit operator consent; never interrupt an active sale or backup.

Gate: unauthorized user/device/shop cannot list or download a release; authorized device can download; expired URL fails; checksum mismatch fails closed; successful installer verifies and relaunches.

### Phase 4 — Application data adapter
1. Introduce provider-neutral interfaces (AuthProvider, CloudDataProvider, UpdaterProvider) with Supabase and Neon implementations temporarily.
2. Replace direct Supabase imports from business components with typed repository methods. Avoid broad mechanical rewrites.
3. Preserve transaction boundaries in SQL RPCs for sales, credit, returns, GRN, stock and tracked units.
4. Retain offline outbox idempotency, revision checks, retry policy, and conflict resolution. Never blindly dual-write financial operations to two databases.
5. Keep shop/branch binding strict: existing local data must not auto-bind to a different shop.
6. Update Owner Web separately; it must use the new provider and remain aggregate/read-only as currently designed.

Gate: app can build with the Neon provider and with Supabase provider during transition; no renderer secrets or database credentials are introduced.

### Phase 5 — Staging rehearsal and cutover
1. Freeze cloud writes during final snapshot; keep local POS sales in durable IndexedDB/outbox.
2. Import final schema/data into Neon; verify row counts, foreign keys, indexes, constraints, sequences, triggers, grants, and RLS.
3. Complete controlled cloud identity reset/enrollment.
4. Switch one test shop/device first. Replay pending outbox writes exactly once.
5. Run a reconciliation report for sales totals, payment allocations, stock by branch, IMEI/serial ownership, customer balances, GRN, returns, and repair status.
6. Only after test shop sign-off, schedule production cutover with rollback snapshot and documented operator instructions.
7. Keep the old Supabase project/data untouched for a defined rollback period; never dual-write a financial transaction to both providers.

Gate: all critical workflows pass, data reconciliation is exact, and rollback has been rehearsed.

## 6. Required regression test matrix

- Local login works with internet disconnected and cloud services unavailable.
- Cloud sign-in persists across app restart and Windows restart.
- One-time Windows authorization persists; no repeated prompt after successful authorization.
- Explicit device revoke blocks private update access without disabling local POS or Google Drive backup.
- Sales: cash, card, split, credit, partial payment, exact payment, idempotent retry, and failed network transaction.
- Credit settlement: FIFO allocation, receipt history, balance-after, duplicate prevention.
- Inventory: direct branch stock edit, atomic expected-quantity guard, GRN receipt, transfer, branch isolation.
- IMEI/serial: unique unit ownership, sale/return/transfer consistency.
- Repairs, warranty, kits, quotations, exchanges, returns, and purchase returns.
- Cloud sync: offline outbox replay, duplicate/reorder/retry, shop mismatch, branch mismatch, stale revision.
- Backup: encrypted Google Drive backup, Recovery Key restore, wrong-key rejection, cross-shop isolation; no dependence on Neon Auth being online for local restore.
- Updater: private release authorization, URL expiry, SHA-512 mismatch, download interruption, safe install, relaunch.
- Electron security: preload/contextBridge allow-list, CSP, no secrets in renderer, JWT verification, rate limits, RLS deny tests.

## 7. Cost and quota guardrails (verify before launch)

- Neon Free currently documents 1 GB storage/project, 100 CU-hours/project/month, 5 GB public network transfer/project/month, and scale-to-zero after inactivity. Hitting compute or transfer quotas can suspend compute until reset or upgrade.
- Cloudflare R2 Standard currently documents 10 GB-month free storage, 1 million Class A operations/month, 10 million Class B operations/month, and free egress. Above those allowances storage and operations are billed.
- Cloudflare Workers Free currently documents 100,000 requests/day and 10 ms CPU per invocation. A busy shop or update burst can exceed this.
- These allowances can change. Add usage alerts/limits and test graceful quota exhaustion. Do not promise permanently zero cost.

## 8. Rollback plan

- Keep current Supabase schema/data and migration history intact throughout staging.
- Keep a verified pre-cutover database export and R2 object manifest.
- During cutover, stop cloud writes, preserve local outbox, and record the last committed revision.
- If Neon parity fails, point the app back to the old provider only after confirming no divergent writes occurred; otherwise reconcile from the authoritative transaction log before rollback.
- Never delete old data or revoke old credentials until the rollback window is closed and owner approves.

## 9. Current status and what is not yet tested

- Initial source inspection confirms the app is still directly coupled to @supabase/supabase-js, Supabase Auth, PostgREST-style queries/RPC, Supabase migrations, and a Supabase Edge Function.
- Architecture selection is provisional: Neon Postgres + Neon Managed Better Auth + Neon Data API + Cloudflare Worker + R2.
- No Neon project has been provisioned, no data has been copied, no migration has been run, no Cloudflare Worker/R2 bucket has been changed, and no production cutover has occurred.
- A real compatibility test requires a sanitized database export plus Neon and Cloudflare test credentials. Never commit secrets to GitHub or Vite environment variables.
