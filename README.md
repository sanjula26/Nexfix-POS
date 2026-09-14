# Nexfix POS — Production Hardening

Nexfix POS is a React + TypeScript + Vite POS for electronics retail, inventory, IMEI/serial tracking, repairs, warranty claims, quotations, expenses and reporting.

## Current architecture

- Web/PWA: React + TypeScript + Vite
- Local/offline store: IndexedDB + service worker
- Cloud target: Supabase PostgreSQL with authenticated transactional sale/return operations
- Cloud sales: server-side atomic sale completion with idempotent sale IDs
- Cloud returns: server-side atomic sale-return processing with idempotent return IDs
- Cloud state sync: authenticated multi-PC snapshot revisioning with durable conflict-safe queueing
- Multi-shop isolation: every cloud device, snapshot and Google backup request is scoped to an explicit `shop_id`; one shop cannot use another shop's cloud data
- Web deployment: Netlify-compatible Vite build; GitHub Pages preview workflow is also configured
- Desktop target: Windows Electron wrapper (build separately)
- Backup target: one dedicated Google account / one Apps Script deployment / one bound spreadsheet can serve all shops; each shop is isolated into its own `shop_id`-derived backup partitions

## Important safety changes

- Offline queue operations are **never discarded just because the browser becomes online**. A remote acknowledgement is required before a sync operation is acknowledged.
- Private Supabase implementation RPCs are not executable by the authenticated client role; public wrapper RPCs remain the supported boundary.
- Google backup is not separated by email address. A single dedicated Google backup account can serve many shops, while `shop_id`, authenticated membership and deterministic shop-specific partitions enforce isolation.
- Google backup and restore requests are checked at both the Supabase proxy and Apps Script layers for an active `admin`/`manager` membership in the exact requested shop.
- Cloud backup payloads intentionally omit local POS authentication secrets; restore preserves the current device's local authentication state.
- Google backup remains an optional secondary backup transport. Supabase/cloud state and the local offline store remain separate reliability mechanisms.
