# Nexfix POS — Production Hardening

Nexfix POS is a React + TypeScript + Vite POS for electronics retail, inventory, IMEI/serial tracking, repairs, warranty claims, quotations, expenses and reporting.

## Current architecture

- Web/PWA: React + TypeScript + Vite
- Local/offline store: IndexedDB + service worker
- Cloud target: Supabase PostgreSQL with authenticated transactional sale/return operations
- Cloud sales: server-side atomic sale completion with idempotent sale IDs
- Cloud returns: server-side atomic sale-return processing with idempotent return IDs
- Cloud state sync: authenticated multi-PC snapshot revisioning with durable conflict-safe queueing
- Web deployment: Netlify-compatible Vite build; GitHub Pages preview workflow is also configured
- Desktop target: Windows Electron wrapper (build separately)
- Backup target: Google Apps Script/Drive, explicitly configured by the operator

## Important safety changes

- Offline queue operations are **never discarded just because the browser becomes online**. A remote acknowledgement is required before a sync operation is acknowledged.
- Cloud sale and return operations use stable IDs and server-side transactions to prevent duplicate processing during retries.
- Purchase returns now reconcile IMEI/serial-tracked inventory units: returned units are marked `returned`, removed from sale eligibility, and linked to the supplier debit note.
- Multi-PC state snapshots use a device-bound authenticated RPC and optimistic revision checks; a stale device cannot overwrite a newer cloud snapshot, and conflicts leave pending local writes intact.
- Google backup is **OFF by default** and no real Google Apps Script deployment URL is hard-coded in the source.
- Only HTTPS `script.google.com` URLs are accepted by the Google backup configuration.
- Keep `.env.local`, passwords, service-role keys, database credentials and other secrets out of Git.

## Local development

```bash
npm install
npm run dev
```

Build and preview:

```bash
npm run build
npm run preview
```

## Environment

Copy `.env.example` to `.env.local` and configure only public client settings:

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_GOOGLE_SCRIPT_URL=
```

Never put a Supabase `service_role`/secret key in browser environment variables.

## Supabase status

The application uses Supabase for authenticated cloud shop/catalog synchronization, multi-PC snapshot synchronization, and server-side transactional sales/returns. Database migrations and RLS policies should remain under review whenever the schema or transaction functions change.

## Offline safety

The local IndexedDB store remains the source of truth while offline. Pending sale/return operations remain durable until the cloud transaction path confirms successful processing. Stable idempotency keys and server-side transactions are used for sale/return retries. General state writes are also durably queued and use cloud snapshot revision checks when connectivity returns.

## Google backup

Configure the Apps Script URL through the application settings or `VITE_GOOGLE_SCRIPT_URL`. Enable Google sync only after verifying the destination account and backup/restore process. Test a restore before relying on backups for disaster recovery.

## Production checklist

Before real business use:

- [ ] Replace/remove demo credentials and seed accounts
- [x] Supabase authentication and core RLS hardening implemented for the current cloud workflows
- [x] Server-side transactional sales/stock operations implemented for cloud sales
- [x] Server-side transactional return/stock operations implemented for cloud returns
- [x] Durable offline sale/return queue with idempotent retry handling implemented
- [x] Purchase-return tracked-unit reconciliation implemented and verified in CI
- [x] Multi-PC conflict-safe state snapshot synchronization implemented; perform a real two-device acceptance drill before live use
- [ ] Verify Google backup and restore end-to-end
- [x] Windows installer and portable builds verified in GitHub Actions release build `v3.0.0-build.207`
- [x] Dependency/security audit completed; high-severity npm audit findings remediated
- [ ] Configure Netlify production environment variables
- [ ] Test printer, barcode scanner and cash drawer hardware
- [ ] Perform a full restore drill before storing live business data

## Dependency security

The production dependency audit was run with `npm audit --audit-level=high`. High-severity findings in Electron and transitive packages were remediated; Electron was upgraded to `44.3.0`, and the final audit completed with no high-severity findings. The standard CI pipeline also passed typecheck, lint and production build after the upgrade.
