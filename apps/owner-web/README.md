# NexFix Owner Web — Phase 1

Separate, read-only browser app for single-shop cloud sales. It is isolated from the desktop POS Vite entry and Electron packaging.

## Local setup
1. Copy `.env.example` to `.env.local`.
2. Set `VITE_SUPABASE_URL` and the public anon/publishable key for the existing Supabase project.
3. Run `npm install`, `npm run dev` from this directory.
4. Sign in with the shop's Supabase Auth account. Local desktop POS credentials are separate.

## Security and reporting
- Phase 3 branch selector is populated from active `public.branches` rows filtered by the membership-resolved shop ID. The browser never supplies an arbitrary shop ID and branch IDs are validated again in the reporting RPCs.
- Dashboard, sales pages and daily report share the selected branch filter. `All branches` uses a server-side aggregate RPC grouped by branch/date and combines only aggregate rows; invoice lists remain shop-scoped and paginated.
- Stock valuation and low-stock status come from `get_owner_branch_stock_valuation`, which joins `branch_stock` to products and active branches on matching `shop_id`. Cost value = branch quantity × product cost; selling value = branch quantity × product price; potential profit = selling value − cost value. CSV export is available for the valuation rows and the existing sales exports remain.
- Credit and cash-in-hand remain shop/POS-day-session level and are not presented as branch-level numbers.
- Shop is resolved from the signed-in user's active `public.shop_memberships` row. Accounts with no membership or multiple active shop memberships are blocked.
- The app never accepts a shop ID from a URL or local storage. Sales queries filter by the resolved shop, and PostgreSQL RLS remains the security boundary.
- Browser code uses only the public anon/publishable key; never put a service-role key in a `VITE_*` variable.
- Dashboard and sales-report totals use public.get_owner_daily_sales, which returns shop-scoped daily aggregates rather than invoice rows. The database trigger maintains public.owner_daily_sales as sales sync inserts/updates/deletes rows; the RPC repairs the requested date window on read as a fallback.
- Invoice listing defaults to the last 30 days and requests only id,bill_no,customer_name,total,created_at,status, 50 rows per page, with server-side pagination. CSV export exports the visible page; the report CSV exports daily aggregates.
- No polling or background refresh loop: dashboard, invoice list, and report load once on entry; refresh/apply buttons are user-driven.
- Daily aggregate date keys use Asia/Colombo, matching the default Owner Web timezone. If business timezone changes, update the database aggregation timezone and app configuration together.
- Expected egress reduction: dashboard aggregate response is at most one small row per requested day (31 for month-to-date, plus a separate 5-invoice recent list), rather than downloading all matching invoice rows. Against the previous 10,000-row query cap, 31 aggregate rows are 99.69% fewer response rows; actual byte savings depend on row sizes and the number of sales. Database-side aggregation still reads the relevant sales range during the fallback refresh.
- Sales totals are gross completed invoice totals before partial returns. Cash in hand remains unavailable until synced POS day-end sessions exist.
- Phase 4 adds read-only invoice drill-down from the invoice number. Invoice header is first scoped by membership-resolved shop and selected branch; item and payment rows are fetched only after that parent invoice is confirmed. Return/refund history remains unavailable because direct return-table access is intentionally blocked.
- Customer credit uses `get_owner_credit_customers`, a SECURITY INVOKER RPC that checks active membership and compares each customer's `credit_balance` with the sum of completed invoices' `max(total - amount_paid, 0)`. Only matched rows count toward verified outstanding; differences are surfaced for review. This is an invoice-balance reconciliation, not a claim that a separate settlement ledger exists. Credit remains shop-level, not branch-level.
- Day-end history and expenses read only synced `day_sessions` and `expenses` rows scoped by shop and (where applicable) selected branch. Empty tables show an explicit unavailable/empty state; the app does not infer cash balances or expenses from sales.
- POS users lists active `shop_memberships` and only profile details visible under existing RLS. It is a cloud membership directory, not a directory of desktop-local cashier accounts; local-only users are not fabricated or enumerated.
- These pages remain read-only, refresh only on entry or user action, and use no service-role credentials.
- Default shop timezone is `Asia/Colombo`; set `VITE_OWNER_WEB_TIME_ZONE` only after confirming the business timezone.

Run `npm install`, `npm run typecheck`, `npm run lint`, and `npm run build`. Deploy with the public Supabase environment variables and SPA fallback to `index.html`.

## Phase 5 — Distributor / super-admin

**Skipped for now.** The connected production project currently has one shop and one active membership, and a multi-shop distributor business requirement has not been confirmed in the project record. No super-admin, tenant bootstrap, cross-shop support view or impersonation route is partially implemented. Revisit only if NexFix POS is explicitly being sold to many separate shops; use a separate test tenant to verify hard isolation and onboarding before enabling it. Normal Owner Web remains shop-scoped and unchanged.
