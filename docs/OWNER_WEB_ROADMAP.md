# NexFix Owner Web + Multi-Branch Roadmap

**Status:** Phase 0 design is committed; Phase 1 read-only app is committed and verification is in progress. Phase 2 is not started.
**Reviewed against:** `main` at the time of this document's creation.
**Non-goal:** This document does not change POS runtime behavior, database schema, authentication, cloud sync, backup, or updater code.

## 1. Current architecture inventory

### Authentication and tenant identity

- The desktop POS has its own local user/session model in IndexedDB (with legacy localStorage migration paths). Local POS users, their password hashes, roles, permissions, and day sessions are not the same identities as Supabase Auth users.
- Supabase Auth is initialized in `src/lib/supabase.ts` using the public project URL and anon key, with persistent sessions and refresh. No service-role key is needed or allowed in browser code.
- `src/lib/cloudSync.ts` resolves the cloud tenant through an active `shop_memberships` row for the authenticated Supabase user. A cached shop ID is checked against that membership before reuse; a missing membership is not auto-provisioned.
- Desktop updater device registration uses guarded RPCs and is a separate authorization concern. Owner Web should not reuse local POS credentials or updater credentials as its login mechanism.
- **Production verification (2026-10-09):** live production has `public.shop_memberships` and no `public.shop_members`; deployed `private.is_shop_member` and `private.is_shop_admin` read `shop_memberships` and use `auth.uid()` plus active membership. The current sales RLS policy calls `private.is_shop_member(shop_id)`. Older/legacy SQL files still require migration-drift review; see `docs/PHASE1_SECURITY.md`. The deployed migration history and repository filenames differ for the partial-credit fix; no migration was applied as part of Owner Web.

### Cloud-normalized data (when the relevant production migrations are applied)

The production baseline schema includes shop-scoped normalized tables for:
- `shops`, `profiles`, `products`, `customers`, `suppliers`
- `sales`, `sale_items`, `sale_payments`
- `purchases`, `purchase_items`, `inventory_units`
- `expenses`, `day_sessions`, `repairs`, `repair_parts`, `quotations`, `warranty_claims`, `audit_log`, `counters`

The schema records sales totals and profit, and payment legs in `sale_payments`; expenses have a date and amount; day sessions have opening/closing values and a closed flag. These are plausible sources for web reads **only where production migrations, RLS, data coverage, and sync paths have been verified**.

The desktop's cloud transaction layer uses guarded RPCs for sensitive operations, including `complete_sale_atomic`, returns/reversals, GRN receipt and repair delivery. The offline queue in `src/lib/offline.ts` flushes normalized transaction jobs first, then legacy snapshot writes. Catalog synchronization deliberately avoids overwriting cloud stock on reconnect. These are important boundaries: the Owner Web dashboard should read cloud data and must not write local POS state or emulate sale/stock mutations.

### Snapshot sync is not the same as a complete analytics API

- The codebase has `pos_state_snapshots` and revision-checked snapshot RPCs for compatibility/multi-device sync. Snapshot migration definitions differ (including shop ID type, ownership, and membership assumptions); they must not be treated as a stable web reporting contract until the deployed version and RLS have been confirmed.
- `sanitizeCloudSnapshotState` strips local users, sessions and admin PIN hash before snapshot storage. A snapshot may be useful for compatibility, but it is not the preferred source for financial KPIs or branch-level reporting.
- Prefer normalized, shop-scoped tables or purpose-built read-only RPCs for web reports. Do not calculate from an arbitrarily selected device's local IndexedDB state or trust an unvalidated snapshot.

### Local-first data and gaps

- The authoritative desktop operational experience is local-first (IndexedDB-backed POS state, offline queue, and browser/localStorage compatibility keys). A local sale or expense can exist before its cloud transaction is acknowledged; the web dashboard can therefore lag while a device is offline or the queue is pending.
- Desktop day-end calculations are computed by `src/lib/dayEnd.ts` from local `sales`, payment legs, refunds/exchanges, credit settlements, expenses, and `sessions`. They derive expected drawer cash from opening float + cash tenders + cash credit settlements − cash refunds − cash expenses.
- The normalized cloud `day_sessions` table has opening/closing/closed metadata, but the reviewed baseline does not establish that every local day-session field (for example expected cash, variance, closed-at/by, all tender/refund details) is reliably synced and queryable. Therefore **Cash In Hand / expected drawer cash is not Phase 1-computable until an authoritative, complete day-end/session sync contract is verified**.
- Local expenses exist in POS state; cloud `expenses` exists in schema. This review does not establish a guaranteed end-to-end expense upload path for every deployment, so expense KPIs/listing are conditional on verified cloud coverage.
- Local credit balances and settlements are richer than a single customer balance: desktop has customer-credit-payment allocation and open invoice balance logic. Cloud `customers.credit_balance` exists, but a complete normalized cloud settlement/statement path must be verified before promising invoice-level outstanding or statements in Owner Web.
- Desktop sales/report pages use local state. A locally computed KPI is not evidence that the same value is currently available in cloud.
- Google Drive backup (automatic/manual, encryption/recovery key), Supabase cloud sync, offline queue, and private Windows updater remain separate existing systems. Phase 0 makes no changes to them.

## 2. Phase 1 scope freeze — single shop, single implicit branch, read-only

### In scope

1. Owner Web signs in using the existing Supabase Auth account and verifies an active membership in exactly one selected shop.
2. Session-protected browser routes and sign out.
3. Read-only dashboard sourced only from normalized cloud data/RLS-safe read RPCs for that shop.
4. Sales today (sum of valid cloud sales totals) and invoice count; month-to-date sales; a 14-day daily sales series; sales date-range summary.
5. Invoice/sales list with safe summary fields, if normalized sale rows and RLS are confirmed.
6. Outstanding credit only if cloud balances/settlements are proven reconciled; otherwise show an honest “Not available until cloud credit sync is verified” state.
7. Expenses only if production cloud rows are demonstrably populated and tenant-scoped; otherwise show a clear unavailable state.
8. Payment mix only if the normalized `sale_payments` rows are populated and can be reconciled to the included sales.
9. Cash in hand: show **“Available after POS day-end sync”** until session/day-close sync is verified end-to-end.
10. A clear “last data updated” timestamp and stale/offline/pending-sync caveat where available.

### KPIs explicitly computable from cloud after access and data coverage checks

- **Sales today and invoice count:** `sales.created_at` (or a single agreed business-date field) with statuses excluded/handled consistently; use the shop's configured timezone, not the web browser's arbitrary timezone.
- **Month-to-date sales:** same canonical sales inclusion rule, from the first local business-day instant of the month through now.
- **Last 14 days sales:** daily aggregate from the same sales source and status rules.
- **Sales date-range summary:** total sales and bill count from normalized cloud sales.
- **Gross profit:** schema has `sales.profit`, but it is shown only after verifying that the production RPC populates it consistently, discounts/returns are treated correctly, and role permissions allow it. It is not a guaranteed Phase 1 KPI until verified.
- **Payment mix:** conditional on complete `sale_payments` coverage and reconciliation to selected sales.

### Deferred / not promised in Phase 1

- Cash in hand, expected drawer, cashier variance and day-end history until complete session/tender/refund/expense sync is verified.
- Profit KPI until the cloud profit definition and return/discount treatment are reconciled against desktop.
- Outstanding credit and customer statements until cloud settlements and invoice allocations are verified.
- Expenses KPI/list until a reliable upload path and production data coverage are confirmed.
- Stock valuation, low stock, product/stock views beyond any explicitly approved read-only Phase 1 slice.
- Employee/admin user management, invites, web writes, stock edits, sales/refunds, credit settlement and any other operational mutation.
- Branch creation, branch selector, branch-scoped stock, transfers and all-branches aggregation (Phase 2+).
- Distributor/super-admin tooling (optional Phase 5).

## 3. Owner Web data and security design

- Tenant key is the existing `shop_id`; many businesses remain isolated by distinct shop IDs. Branches, if added later, are children within one shop and do not replace the tenant boundary.
- Browser uses only the Supabase anon/public key plus the signed-in user's session. Never put `service_role`, database passwords, private updater credentials, or secrets in Vite environment variables shipped to the browser.
- Every table read must be protected by verified RLS or a purpose-built read-only RPC that checks `auth.uid()` and active membership server-side. A client-side `.eq('shop_id', ...)` filter is a usability filter, **not** the security boundary.
- Owner/admin web authorization must be a server-enforced membership role. Do not infer owner access from a local POS role, email domain, cached shop ID, or a profile display label.
- Phase 1 remains read-only. Hide/disable unfinished nav items; do not ship dead links or fake values.
- Before Phase 1 implementation, audit and reconcile canonical membership tables/policies and snapshot migration drift in the actual deployment. Add regression tests proving user A cannot read shop B, even when user A submits shop B's ID directly.
- Use bounded date ranges and indexes. Prefer a small aggregate RPC for dashboard charts if direct queries require large scans; ensure the RPC validates membership and business timezone.

## 4. Branch model proposal (design only; no migration in Phase 0)

Preferred direction: **`branches` + `branch_stock`**, rather than treating one product row's `stock` field as simultaneously representing stock in several locations.

Proposed tables/columns:
- `branches(id uuid, shop_id uuid, name text, code text, active boolean, is_default boolean, created_at timestamptz)`; unique active code/name per shop as agreed; exactly one default branch per shop after backfill.
- `branch_stock(shop_id uuid, branch_id uuid, product_id uuid, qty numeric, updated_at timestamptz)`; unique `(branch_id, product_id)`, checks against invalid negative quantities where business rules allow.
- Add `branch_id` to `sales`, `expenses`, `day_sessions`, `purchases/GRN receipts`, stock movement/ledger rows, and repair/transfer workflows as appropriate. For IMEI/serial stock, add `branch_id` to `inventory_units` and enforce that unit/product/branch/shop ownership agrees.
- Add explicit `stock_transfers` and `stock_transfer_lines` with from/to branch, status, creator/approver, timestamps and idempotency key. Completing a transfer must be one atomic server-side transaction and admin-authorized.
- Add `branch_id` to device registration (or a device-to-branch binding table) and enforce that each POS device's selected branch is authorized by the same shop.
- Existing products currently carry one `products.stock` value. Migration must snapshot each existing shop's stock into its default “Main” branch exactly once, with audit/reconciliation totals before and after; retain compatibility during rollout and never double-count the legacy column.
- Customer credit is proposed as **shop-level** initially, because existing customers and customer balances are shop-scoped. Invoices remain tagged to the branch where sold; statement/payment allocation remains at shop scope unless a later explicit business requirement changes it.
- Branch-scoped cash/day-end is per branch and per cashier session. Consolidated totals must be sums of distinct branch records, not duplicated shop-level totals.
- Do not implement branch tables or bind POS devices until Phase 1 is fully verified and a separate Phase 2 migration plan is approved.

## 5. Phase gates and verification

### Phase 0 acceptance checklist

- [x] This design/inventory document is committed.
- [x] Cloud/local map and known sync limitations are documented.
- [x] Phase 1 KPIs are split into computable-after-verification vs deferred.
- [x] Branch tables and backfill approach are design-only.
- [x] No POS runtime, schema, auth, backup or updater changes are included in this phase.

### Phase 1 gate (must be all green before Phase 2)

- [ ] Confirm production migration state and canonical membership/RLS path.
- [ ] Owner signs in with existing Supabase Auth; protected route and sign out work.
- [ ] Cross-tenant negative tests pass for direct table reads and any RPCs.
- [ ] Real cloud sales today and MTD reconcile against normalized cloud rows for the same shop/timezone.
- [ ] 14-day chart and date-range summary reconcile.
- [ ] Any enabled invoice/credit/expense/payment-mix views are backed by verified cloud data; unavailable KPIs show honest states.
- [ ] No fake cash/profit/credit numbers.
- [ ] Existing Electron POS smoke tests pass: cash sale, credit sale/settlement, day-end, automatic/manual Google Drive backup and recovery-key behavior, updater authorization/update check.
- [ ] Typecheck, lint, production build, security review and relevant automated tests are green.
- [ ] Commit and push Phase 1; publish a short Sinhala owner summary.

**Stop rule:** Phase 0 does not authorize Phase 1 implementation automatically. Phase 1 begins only after this Phase 0 document is reviewed/accepted and its deployment/security prerequisites are understood. Phase 2 must not begin until every Phase 1 gate is green.


## Phase 1 implementation update (2026-10-09)

- Separate app: `apps/owner-web`; desktop POS entry, Electron packaging, billing, day-end, Drive backup, and updater are not modified.
- Live production RLS and canonical membership checks are documented in `docs/PHASE1_SECURITY.md`. The checks verified own-shop reads and denied unrelated-shop/no-membership reads. Browser JWT sign-in and a two-real-shop test remain pending.
- Phase 1 sales values are gross completed invoice totals before partial returns. Profit, credit, expenses, payment mix, and cash-in-hand are deferred until coverage/accounting is verified.
- Phase 2 remains prohibited until every Phase 1 verification item is green.
