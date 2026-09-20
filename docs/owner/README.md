# Owner Phone Sales Link Registry

This directory is intentionally owner-only.

The GitHub Actions workflow `Sync owner phone-sales link registry` rebuilds `docs/owner/phone-sales-links.md` from the registered POS devices in Supabase.

## Required GitHub Actions secrets

Set these repository secrets before enabling the workflow:

- `SUPABASE_URL` — the Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key. Store it only as a GitHub Actions secret; never put it in source code.
- `PHONE_SALES_BASE_URL` — the deployed POS base URL, without a trailing slash.
- `OWNER_USER_ID` — your Supabase Auth user UUID. This prevents the private registry from including devices owned by another account.

The workflow refuses to generate the registry while the repository is public.

## What the owner sees

The generated registry is grouped by shop and identifies each POS machine separately:

`Shop → Shop ID → POS Machine → Machine ID → Stable phone-sales link`

The phone-sales URL has no date. The phone page selects today or a previous date after opening the permanent machine link.

Shop users do not receive the cross-shop registry.
