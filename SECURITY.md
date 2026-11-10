# Nexfix POS Security and Release Policy

## Scope

Nexfix POS handles sales, payments, customer credit, inventory, repairs and shop-level data. Changes affecting financial values, stock, authentication, authorization, backup, restore, synchronization or desktop updates are security-sensitive.

## Required checks before release

Run the following checks from a clean checkout:

```bash
npm ci
npm run verify:boundaries
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=high --omit=dev
```

The Windows installer must be rebuilt from the same commit that passed these checks.

## Credential rules

- Never commit `.env`, `.env.local`, service-account files, Supabase `service_role` keys, private keys or cloud-provider private credentials.
- `VITE_*` values are client-visible. They must not be treated as secrets.
- Rotate the Google backup transport key whenever an installed build may have been exposed.
- Never place a Supabase service-role key in the renderer, Electron preload, public assets or browser bundle.

## Data and tenant safety

Before enabling cloud writes, verify that every user and device is bound to the intended `shop_id`. Server-side RLS/RPC authorization is authoritative; UI role checks are not sufficient.

Financial and stock operations must be idempotent and must be tested for retries, duplicate requests, offline replay and concurrent devices.

## Backup and restore

A backup is considered valid only after a test restore succeeds. Before a production release, test at least two shops and verify that a backup from one shop cannot be restored or read as another shop.

Do not delete local queued operations solely because the device becomes online. An operation is complete only after the supported remote acknowledgement has been received.

## Incident response

If a shop reports a possible data, payment or access problem:

1. Stop further writes if duplicate or cross-shop transactions are suspected.
2. Preserve the local POS data and sync queue.
3. Record the application version, device, shop and approximate time.
4. Export the relevant audit information without editing the original records.
5. Confirm the latest verified backup before attempting restore.
6. Rotate exposed transport credentials and revoke affected cloud sessions.
