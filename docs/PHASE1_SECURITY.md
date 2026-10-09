# Phase 1 — Owner Web Security and Schema Verification

**Checked:** 2026-10-09 against the connected Supabase production project and repository `main`. This is a live read-only inspection; no database migration was applied.

## Canonical membership and tenant resolution

- **Canonical table:** `public.shop_memberships`. Production has no `public.shop_members` table.
- **Canonical helpers:** `private.is_shop_member(target_shop uuid)` and `private.is_shop_admin(target_shop uuid)`. The deployed member helper checks `m.user_id = auth.uid()`, `m.shop_id = target_shop`, and `m.active = true` against `public.shop_memberships`. The admin helper additionally limits roles to `admin` and `manager`.
- Both helpers are `SECURITY DEFINER`, use an empty `search_path`, and have EXECUTE available to `authenticated` but not `anon` or `PUBLIC`.
- `src/lib/cloudSync.ts` follows the same membership table. Its cached shop ID is revalidated against the current user's active membership; missing membership does not auto-create a shop.
- Production currently has one shop (`Nexfix Shop`, currency `LKR`) and one active `admin` membership. The app deliberately blocks accounts with zero or multiple active shop memberships for this single-shop phase.

## Safe read path

The Owner Web reads normalized tables directly through the Supabase client using the public anon/publishable key plus the signed-in user's Auth session. The PostgreSQL RLS policy is the security boundary; client-side `.eq('shop_id', shopId)` is only an additional filter.

- `public.sales` has RLS enabled. Its `SELECT` policy, `sales member read`, uses `private.is_shop_member(shop_id)`.
- `public.sale_items` and `public.sale_payments` also use the membership helper through their parent sale's `shop_id`.
- `public.shop_memberships` has a SELECT policy allowing a user to read their own membership rows (and admins to read shop membership rows).
- `public.shops` has a SELECT policy using `private.is_shop_member(id)`.
- The app uses only SELECT queries for sales, shop and membership data. It contains no business-table insert/update/delete operations and no service-role key.

## Live schema and sales fields

The production `sales` table contains `id`, `shop_id`, `bill_no`, `subtotal`, `discount`, `tax`, `shipping`, `total`, `amount_paid`, `change_amount`, `profit`, `status`, and `created_at`, among other operational fields. `sale_items` stores invoice line items. `sale_payments` stores payment legs with `method` and `amount`.

Production currently has 23 `completed` sales and 3 `refunded` sales. `sale_payments` contains cash and credit rows, but these row counts alone do not prove complete payment coverage or a reconciled payment-mix report. Profit correctness and partial-return accounting are not proven by column existence.

**Phase 1 sales KPI definition:** sum `sales.total` for `status = 'completed'`, grouped by `created_at` in the configured shop timezone. These are **gross completed invoice totals before partial returns**; they are not net sales after partial returns. The dashboard states this limitation explicitly. Profit, outstanding credit, expenses, payment mix, and cash in hand are deferred; cash in hand says “Available after POS day-end sync”.

The production `shops.settings` value is empty and there is no dedicated timezone column. Owner Web therefore defaults to `Asia/Colombo` through `VITE_OWNER_WEB_TIME_ZONE`; confirm the shop timezone before treating timezone reporting as fully accepted.

## Tenant-isolation checks run against live production

The SQL checks used a transaction with `SET LOCAL ROLE authenticated` and a simulated `request.jwt.claim.sub`; each transaction was rolled back. These are database-policy checks, not a substitute for a browser sign-in test with a real JWT.

| Test | Result |
|---|---|
| Active member reads rows for their own shop | 26 rows visible |
| Same member filters for an unrelated shop UUID | 0 rows visible |
| Simulated authenticated user with no membership reads the real shop's sales | 0 rows visible |
| Same no-membership user reads `shop_memberships` | 0 rows visible |
| RLS enabled on `sales` | Yes |
| Legacy `public.shop_members` exists | No |
| Helper EXECUTE for `authenticated` / `anon` / `PUBLIC` | allowed / denied / denied |

The production project currently has one shop, so there is no second real shop with production sales to use for a two-tenant data fixture. The unrelated-shop UUID denial and no-membership denial were verified; add a non-production two-shop JWT integration test before claiming a complete multi-tenant negative test suite.

## Repository/deployment migration difference

The connected production migration history ends at version `20261008234347` (`fix_partial_credit_received_amount`). The repository contains `supabase/migrations/20261009100000_fix_partial_credit_received_amount.sql`, which is not recorded in the production migration history under that version. Do not infer they are identical solely from the name. This Owner Web change does not apply it or alter production schema; review the SQL diff and migration state separately before any later database migration.

## Phase 1 gate status

- [x] Canonical membership table/helper and live sales fields inspected.
- [x] RLS policy behavior checked for own shop, unrelated shop ID, and user without membership.
- [x] Browser read path uses public key + user session; no service-role key.
- [x] Profit/credit/expenses/payment mix deferred; cash in hand clearly deferred.
- [ ] Browser sign-in and protected-route test with the real owner account.
- [ ] Live browser dashboard values reconciled to sales rows for the shop timezone.
- [ ] Owner Web typecheck/lint/build and root POS CI green after commit.
- [ ] Existing desktop POS smoke tests (sale and settings open) verified on a Windows build.
- [ ] Verify no desktop POS, Drive backup, day-end or updater behavior changed.

Phase 2 (branches) remains blocked until every Phase 1 checklist item is green.


## Phase 1.5 — Egress reduction and aggregate access (2026-10-09)

- Added public.owner_daily_sales keyed by (shop_id, sale_date), with only completed invoice count and gross invoice total. Row-level security is enabled; authenticated reads are restricted through private.is_shop_member(shop_id).
- private.sync_owner_daily_sales is an internal SECURITY DEFINER trigger function with a fixed search path. It adjusts daily aggregates on sales insert, relevant update, and delete events. Aggregate-cache exceptions are caught and logged as warnings so they cannot abort desktop POS sales sync; the read fallback repairs a stale/missing date window.
- public.get_owner_daily_sales(shop_id, from, to) is a restricted authenticated RPC. It rejects anonymous callers, checks active membership for the requested shop, limits date windows to 366 days, and repairs the requested aggregate window before returning only daily rows. The public RPC is SECURITY INVOKER; only private.refresh_owner_daily_sales is SECURITY DEFINER, remains in the non-exposed private schema, checks auth.uid() and active shop membership, uses a fixed search_path, and has restricted execute grants.
- Dashboard reads daily aggregates for today/MTD/14-day chart and only the latest five invoice rows for the recent list. Reports use aggregates. Invoice list defaults to the latest 30 days and requests 50 rows/page with six limited columns. No polling was introduced.
- Expected client egress: at most 31 aggregate rows for month-to-date plus 5 recent invoice rows on the dashboard, versus the previous query cap of 10,000 invoice rows. At the 10,000-row cap, 31 rows is 99.69% fewer rows; actual bytes depend on payload sizes and sales volume. The read fallback performs server-side aggregation over the requested date range, so this primarily reduces API response egress rather than guaranteeing proportional reduction in database CPU.
- Aggregates use the shop-local date convention Asia/Colombo to match the configured default Owner Web timezone. A timezone change requires coordinated database and app changes.
- Desktop POS billing, local state, Google Drive backup, recovery key, cloud updater, installer storage, and R2 configuration are unchanged. No branch-management/Phase 2 feature was started.
