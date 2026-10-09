# NexFix Owner Web — Phase 1

Separate, read-only browser app for single-shop cloud sales. It is isolated from the desktop POS Vite entry and Electron packaging.

## Local setup
1. Copy `.env.example` to `.env.local`.
2. Set `VITE_SUPABASE_URL` and the public anon/publishable key for the existing Supabase project.
3. Run `npm install`, `npm run dev` from this directory.
4. Sign in with the shop's Supabase Auth account. Local desktop POS credentials are separate.

## Security and reporting
- Shop is resolved from the signed-in user's active `public.shop_memberships` row. Accounts with no membership or multiple active shop memberships are blocked.
- The app never accepts a shop ID from a URL or local storage. Sales queries filter by the resolved shop, and PostgreSQL RLS remains the security boundary.
- Browser code uses only the public anon/publishable key; never put a service-role key in a `VITE_*` variable.
- Only SELECT operations are used for business data. Date ranges are limited to 366 days, results are fetched in bounded pages, and ranges over 10,000 invoices fail visibly.
- Sales totals are gross completed invoice totals before partial returns. Profit, credit, expenses and payment mix remain deferred. Cash in hand says “Available after POS day-end sync”.
- Default shop timezone is `Asia/Colombo`; set `VITE_OWNER_WEB_TIME_ZONE` only after confirming the business timezone.

Run `npm install`, `npm run typecheck`, `npm run lint`, and `npm run build`. Deploy with the public Supabase environment variables and SPA fallback to `index.html`.
