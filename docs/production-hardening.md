# Production hardening audit

## Findings from the current codebase

1. **Offline queue data-loss risk — fixed in this commit.** The previous `flushSyncQueue()` cleared queued operations without a remote acknowledgement. It now leaves pending operations intact until a real sync adapter can confirm them.
2. **Hard-coded Google Apps Script endpoint — fixed in this commit.** The production source no longer contains the previous deployment URL. Google backup is disabled by default and accepts only HTTPS `script.google.com` URLs.
3. **Cloud sync is not yet a real sync implementation.** The existing application is IndexedDB-first and the SQL schema is only a cloud-ready foundation. Do not market the current queue as multi-PC synchronization until a Supabase adapter, idempotency, retries, conflict handling and server-side transactions are implemented.
4. **Supabase RLS needs a complete policy model.** The existing schema contains broad/basic policies and should not be treated as production authorization. Policies must be scoped by authenticated user, role, shop/branch and operation.
5. **Sales/stock concurrency needs server-side transactions.** Multi-PC inventory correctness requires atomic stock movement and sale operations on PostgreSQL rather than trusting browser state.
6. **Demo credentials must not be used in production.** Seed/demo accounts and passwords must be removed or converted to a first-run setup flow before live deployment.
7. **Windows desktop packaging is not currently part of the existing package scripts.** Electron packaging should be added only after the cloud/local boundary is finalized, with secure context isolation and no Node integration in the renderer.

## Required production sequence

### Phase A — Cloud foundation
- Add Supabase client using public publishable/anon credentials only.
- Apply migrations rather than manually mutating a live database.
- Complete RLS policies.
- Add server-side RPC/transaction functions for sales, returns and stock movements.
- Add immutable audit events.

### Phase B — Durable synchronization
- Add an operation/outbox table locally.
- Give every operation a UUID/idempotency key.
- Upload pending operations in order where required.
- Acknowledge/delete locally only after a successful server response.
- Retry transient failures with backoff.
- Record rejected/conflicting operations for operator review.

### Phase C — Desktop
- Add Electron main/preload process.
- Keep renderer isolated from Node APIs.
- Use a local database appropriate for desktop durability.
- Add controlled backup/export and recovery.
- Produce signed Windows builds when certificates are available.

### Phase D — Mobile/admin
- Use the same authenticated Supabase backend.
- Restrict mobile access to reporting/administration permissions.
- Never expose service-role credentials in mobile/web code.

### Phase E — Disaster recovery
- Keep Google Drive backup as a secondary backup target, not the primary transaction database.
- Version backups and verify their integrity.
- Test restore regularly on a separate environment.

## Release gate

The POS should not be considered production-ready until build, authentication, RLS, sale transaction atomicity, offline recovery, multi-PC synchronization, backup/restore and Windows packaging have all been tested end-to-end.
