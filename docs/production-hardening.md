# Production hardening status

This document reflects the current Nexfix POS implementation on `main`. It is an audit/status document, not a list of unfinished historical findings.

## Implemented and verified in the repository

### Authentication and authorization
- Supabase authentication is used for cloud workflows.
- Production database tables are protected by RLS.
- Cloud POS operations require authenticated shop membership.
- Device registration and snapshot writes are bound to the authenticated shop/device relationship.
- Production database security hardening and private-RPC execute restrictions are covered by repository security checks.

### Transaction integrity
- Cloud sales use server-side atomic processing with stable sale IDs for idempotent retries.
- Cloud sale returns use server-side atomic processing with stable return IDs.
- Purchase returns reconcile IMEI/serial-tracked inventory units and mark returned units unavailable for sale.
- Offline sale/return operations remain durable until a successful remote acknowledgement is received.

### Multi-PC synchronization
- General state changes are durably queued locally.
- Cloud snapshots use optimistic revision checks so a stale device cannot overwrite a newer snapshot.
- Device registration and snapshot RPCs enforce active shop membership and device ownership.
- Snapshot authentication secrets are sanitized server-side: password hashes and the admin PIN hash are not stored in cloud snapshots.
- A real two-device acceptance drill is still required before live multi-PC use.

### Google backup and restore
- Google backup is opt-in and disabled by default.
- The production Google backup path is direct: Nexfix POS → Google Apps Script Web App → the dedicated master Google Drive folder.
- Supabase is **not required** for this backup path, and the separate Google Sheet is **not required** or assumed to be inside the Drive folder.
- The Apps Script uses the configured master Drive folder ID and creates one shop-specific folder per deterministic shop partition.
- Backup writes require both `shopId` and `requestId`; repeated request IDs are idempotently acknowledged per shop partition.
- The POS uses a CORS-safe POST followed by JSONP status polling and reports cloud success only after the server confirms the Drive write.
- Cloud backup payloads exclude local password hashes, local user records, and the admin PIN hash.
- Direct restore reads only the requested shop partition and validates the Nexfix POS snapshot envelope before applying it.
- The Web App endpoint is a transport boundary, not a replacement for POS authentication. A publicly reachable Apps Script endpoint must be treated accordingly.
- End-to-end testing against the actual deployed Apps Script and Google Drive account remains an external acceptance gate.

### Desktop packaging
- Electron uses context isolation, sandboxing, disabled Node integration, and restricted navigation.
- Windows installer and portable artifacts are produced by electron-builder.
- Release build `v3.0.0-build.227` contains the verified Windows installer/portable release artifacts.
- Physical printer, barcode scanner, and cash drawer compatibility still requires hardware testing.

### Web deployment
- `netlify.toml` builds `dist`, provides SPA fallback/security headers, and uses Node.js 22 to match CI.
- GitHub Pages preview deployment is configured and the latest checked deployment succeeded.
- Actual Netlify production environment configuration/deployment remains an external acceptance gate.

### Demo/seed data
- Demo seed data is opt-in through `VITE_SEED_DEMO=true`; the normal production build does not enable it.
- The seed module contains development-only demo users/data and is not a production account provisioning mechanism.
- The release workflow must never set `VITE_SEED_DEMO=true`.

## Remaining production acceptance gates

1. Complete a real two-PC cloud synchronization drill using separate devices/accounts.
2. Deploy/configure the direct Google Apps Script integration and perform a two-shop backup/restore test with a real Google account and separate Drive partitions.
3. Configure Netlify public environment variables and verify the live production site.
4. Test the actual receipt printer, barcode scanner, and cash drawer hardware.
5. Perform a complete disaster-recovery restore drill using a known-good backup before storing live business data.
6. Keep the repository private for production source distribution when the operator is ready; GitHub repository visibility must be changed through GitHub settings because the connected integration does not expose that visibility mutation.

These are intentionally not marked green by source/CI checks because they require real external accounts, devices, deployment configuration, or physical hardware.

## Release verification

The repository CI pipeline checks dependency installation, TypeScript typechecking, ESLint, and the production Vite build. Security CI separately runs the high-severity production dependency audit and source-level security assertions. Windows release artifacts are generated by the desktop release workflow. The release checklist should only mark an external gate complete after the corresponding real-world test has actually been performed.

## Security principles

- Never commit `.env.local`, Supabase service-role keys, database passwords, Google credentials, or other secrets.
- Browser builds may contain only public Supabase URL/anon-key configuration and the centrally configured Google deployment endpoint.
- Do not treat Google Drive backups as the primary transaction database.
- Keep cloud snapshots free of local authentication secrets.
- Preserve idempotency keys and server-side transaction boundaries when changing sale, return, inventory, or synchronization code.
