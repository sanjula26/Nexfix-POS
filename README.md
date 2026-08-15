# Nexfix POS — Production Hardening

Nexfix POS is a React + TypeScript + Vite POS for electronics retail, inventory, IMEI/serial tracking, repairs, warranty claims, quotations, expenses and reporting.

## Current architecture

- Web/PWA: React + TypeScript + Vite
- Local/offline store: IndexedDB + service worker
- Cloud target: Supabase PostgreSQL
- Web deployment: Netlify-compatible Vite build
- Desktop target: Windows Electron wrapper (build separately)
- Backup target: Google Apps Script/Drive, explicitly configured by the operator

## Important safety changes

- Offline queue operations are **never discarded just because the browser becomes online**. A remote acknowledgement is required before a future sync worker should remove an operation.
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

`supabase/schema.sql` is a starting PostgreSQL schema for future multi-device/cloud synchronization. It should be applied only after reviewing and completing its RLS policies and server-side transactional functions. The current browser app must not claim that a local queue is cloud-synced until the remote acknowledgement path is implemented.

## Offline safety

The local IndexedDB store remains the source of truth while offline. Pending operations must remain durable until a cloud sync adapter confirms successful processing. Sync should use idempotency keys and server-side transactions before production multi-PC deployment.

## Google backup

Configure the Apps Script URL through the application settings or `VITE_GOOGLE_SCRIPT_URL`. Enable Google sync only after verifying the destination account and backup/restore process. Test a restore before relying on backups for disaster recovery.

## Production checklist

Before real business use:

- [ ] Replace/remove demo credentials and seed accounts
- [ ] Complete Supabase authentication and RLS policies
- [ ] Implement server-side transactional sales/stock operations
- [ ] Implement durable cloud sync with idempotency and retries
- [ ] Add multi-PC conflict handling
- [ ] Verify Google backup and restore end-to-end
- [ ] Build/test Windows installer
- [ ] Configure Netlify production environment variables
- [ ] Run dependency/security audit and resolve high-severity findings
- [ ] Test printer, barcode scanner and cash drawer hardware
- [ ] Perform a full restore drill before storing live business data
