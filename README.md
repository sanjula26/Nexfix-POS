# Nexfix POS — Production Hardening

Nexfix POS is a React + TypeScript + Vite POS for electronics retail, inventory, IMEI/serial tracking, repairs, warranty claims, quotations, expenses and reporting.

## Current architecture

- Web/PWA: React + TypeScript + Vite
- Local/offline store: IndexedDB + service worker
- Cloud target: Supabase PostgreSQL with authenticated transactional sale/return operations
- Cloud sales: server-side atomic sale completion with idempotent sale IDs
- Cloud returns: server-side atomic sale-return processing with idempotent return IDs
- Cloud state sync: authenticated multi-PC snapshot revisioning with durable conflict-safe queueing
- Multi-shop isolation: every cloud device and snapshot is scoped to an explicit `shop_id`
- Production delivery: Windows Electron installer/portable EXE (`desktop:build` / `desktop:dir`)
- GitHub Pages: development/preview only; the installed EXE has no runtime dependency on GitHub
- Netlify is not used for shop production
- Google backup: direct Nexfix POS → Google Apps Script → dedicated Google Drive folder; Supabase is not required for this backup transport
- Google backup storage: the supplied master Drive folder is separate from the operator's Google Sheet; each shop receives a deterministic partitioned Drive folder

## Important safety changes

- Offline queue operations are **never discarded just because the browser becomes online**. A remote acknowledgement is required before a sync operation is acknowledged.
- Private Supabase implementation RPCs are not executable by the authenticated client role; public wrapper RPCs remain the supported boundary.
- Direct Google backup requests require an explicit `shopId` and `requestId`; Drive files are partitioned by a deterministic SHA-256-derived shop key.
- Cloud backup payloads intentionally omit local POS authentication secrets; restore preserves the current device's local authentication state.
- Google backup confirmation is server-side: the POS reports cloud success only after Apps Script reports a successful Drive write.
- Google backup is an optional backup transport. Supabase/cloud state and the local offline store remain separate reliability mechanisms.
- The direct Apps Script endpoint requires a Script Property API key for backup writes and sensitive reads. The compiled client key is still a transport credential, not POS authentication.

See `google-apps-script/README.md` and `docs/google-apps-script.md` for the direct Drive deployment flow.

## Production distribution

Shops receive the Windows Electron installer/EXE only. The installed POS does not depend on the GitHub repository being public; making the repository private does not affect a built EXE.

For multi-PC shops or any privileged cloud operation, configure Supabase Auth + RLS/RPC enforcement. A pure offline single-device deployment remains exposed to physical access and local storage tampering.

## Google Drive backup transport

Set the same high-entropy value in both places before release:
- Apps Script **Script Property**: `NEXFIX_BACKUP_API_KEY`
- Released POS build environment: `VITE_GOOGLE_BACKUP_API_KEY`

The value is embedded in the Electron renderer bundle and therefore is **not a true secret**. It prevents requests to an unkeyed Apps Script endpoint but must not be treated as a substitute for POS authentication. Rotate it by changing the Script Property and rebuilding/releasing the POS.
