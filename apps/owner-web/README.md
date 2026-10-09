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
- Stock valuation and low-stock status come from `get_owner_branch_stock_valuation`, which joins `branch_stock` to active products and branches on matching `shop_id`. Cost value = branch quantity × product cost; selling value = branch quantity × product price; potential profit = selling value − cost value. CSV export is available for the valuation rows and the existing sales exports remain.
- Credit and cash-in-hand remain shop/POS-day-session level and are not presented as branch-level numbers.
- Shop is resolved from the signed-in user's active `public.shop_memberships` row. Accounts with no membership or multiple active shop memberships are blocked.
- The app never accepts a shop ID from a URL or local storage. Sales queries filter by the resolved shop, and PostgreSQL RLS remains the security boundary.
- Browser code uses only the public anon/publishable key; never put a service-role key in a `VITE_*` variable.
- Dashboard and sales-report totals use public.get_owner_daily_sales, which returns shop-scoped daily aggregates rather than invoice rows. The database trigger maintains public.owner_daily_sales as sales sync inserts/updates/deletes rows; the RPC repairs the requested date window on read as a fallback.
- Invoice listing defaults to the last 30 days and requests only id,bill_no,customer_name,total,created_at,status, 50 rows per page, with server-side pagination. CSV export exports the visible page; the report CSV exports daily aggregates.
- No polling or background refresh loop: dashboard, invoice list, and report load once on entry; refresh/apply buttons are user-driven.
- Daily aggregate date keys use Asia/Colombo, matching the default Owner Web timezone. If business timezone changes, update the database aggregation timezone and app configuration together.
- Expected egress reduction: dashboard aggregate response is at most one small row per requested day (31 for month-to-date, plus a separate 5-invoice recent list), rather than downloading all matching invoice rows. Against the previous 10,000-row query cap, 31 aggregate rows are 99.69% fewer response rows; actual byte savings depend on row sizes and the number of sales. Database-side aggregation still reads the relevant sales range during the fallback refresh.
- Sales totals are gross completed invoice totals before partial returns. Profit, credit, expenses and payment mix remain deferred. Cash in hand says “Available after POS day-end sync”.
- Sales totals are gross completed invoice totals before partial returns. Profit, credit, expenses and payment mix remain deferred. Cash in hand says “Available after POS day-end sync”.
- Default shop timezone is `Asia/Colombo`; set `VITE_OWNER_WEB_TIME_ZONE` only after confirming the business timezone.

Run `npm install`, `npm run typecheck`, `npm run lint`, and `npm run build`. Deploy with the public Supabase environment variables and SPA fallback to `index.html`.
