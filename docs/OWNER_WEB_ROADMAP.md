# NexFix Owner Web + Multi-Branch Roadmap

**Status:** Phase 0, Phase 1, Phase 1.5 and Phase 2 branch model/POS binding are implemented on `main`. Phase 3 was explicitly authorized on 2026-10-09; branch-aware Owner Web UI/reporting is committed and its additive reporting RPCs are deployed. See the Phase 3 verification status below.
**Reviewed against:** `main` at the time of this document's creation.
**Scope boundary:** Phase 3 may add read-only Owner Web UI/reporting and membership-checked SECURITY INVOKER reporting RPCs. It must not change desktop POS runtime, authentication/session behavior, cloud sync writes, Drive backup, updater, or R2 publishing.

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

## 4. Phase 2 branch model and compatibility contract

**Implemented model:** Strategy A — products remain the shop-wide catalog and legacy total-stock mirror; `branch_stock(shop_id, branch_id, product_id, qty)` is the operational stock quantity for each branch.

- `branches` has a default Main branch for every existing shop, unique `(shop_id, code)`, and one default branch per shop. New branches start with zero stock.
- `branch_stock` uses `(branch_id, product_id)` as its primary key and has shop/branch/product foreign-key indexes. Existing product stock was backfilled to Main once; a single-active-branch trigger preserves legacy `products.stock` behavior.
- `branch_id` is required/backfilled on normalized `sales`, `expenses`, `day_sessions`, `purchases`/GRN headers, and `inventory_units`. Returns inherit their source sale/GRN branch; stock transfers record both source and destination branches.
- IMEI/serial units belong to one branch. Sale validation rejects units from another branch; atomic unit add/delete, transfer, supplier return, sale return, sale reversal and trade-in paths reconcile branch quantities and the shop total.
- Stock transfers and stock adjustments are atomic server-side operations with shop/role checks, quantity validation and idempotency. Transfer lines support exact in-stock IMEI/serial IDs and transfer the unit's branch in the same transaction.
- POS devices are bound to a branch when a shop has multiple active branches. Settings auto-selects Main for a single-branch shop; a cached multi-branch shop requires an explicit branch before branch-sensitive stock/day-end operations.
- Offline stock checks use a selected-branch cache. Branch stock adjustments and tracked-unit add/delete use durable IndexedDB queue operations; queued stock adjustments bootstrap the pre-change product quantity before applying their idempotent delta.
- Customer credit remains shop-level initially. Sales and day-end sessions are branch-tagged; consolidated owner reporting remains shop-level in Phase 2.
- `owner_daily_sales` intentionally remains shop-level. Owner Web Phase 1 KPIs continue to work unchanged; branch selectors, branch-level KPIs and all-branches views remain Phase 3+.


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
- Phase 2 was started after the owner confirmed the Phase 0/1/1.5 prerequisites. Remaining Phase 2 runtime/regression verification is tracked below; CI green alone is not treated as proof of live stock-transfer behavior.


## Phase 1.5 implementation update (2026-10-09)

- Added shop-scoped daily sales aggregates and a sales-table trigger; the dashboard/report reads the aggregate RPC instead of downloading invoice rows to calculate totals.
- The aggregate RPC validates the authenticated user's active shop membership and repairs the requested range on read as a fallback.
- Invoice list defaults to the latest 30 days, selects only six columns, and uses 50-row server-side pages. Dashboard recent invoices are capped at five. Refresh is manual/on-load only; no polling.
- Expected egress: dashboard uses at most 31 daily aggregate rows plus 5 recent invoices, compared with the former query cap of 10,000 invoice rows (99.69% fewer rows at that cap; byte savings vary). Fallback still performs server-side aggregation.
- The additive SQL migrations were applied to the connected production project and are checked into supabase/migrations/20261009064402_owner_daily_sales_aggregates.sql, supabase/migrations/20261009064831_fix_owner_daily_sales_rpc_ambiguity.sql, and supabase/migrations/20261009065025_make_owner_daily_sales_trigger_nonblocking.sql, and supabase/migrations/20261009065416_optimize_owner_daily_sales_range_query.sql, and supabase/migrations/20261009065523_split_owner_daily_sales_refresh_helper.sql. The public aggregate RPC is SECURITY INVOKER; only the membership-checked refresh helper in the private schema is SECURITY DEFINER. The aggregate trigger is best-effort so aggregate cache errors do not block POS sales sync. Desktop POS/Drive/updater/R2 were not changed.
- Phase 2 branches remain out of scope and were not started.

## Phase 2 implementation update (2026-10-09)

### Live reconciliation and regression tests

- The connected production shop has 23 products with a shop-wide stock total of 1,174 and Main-branch stock total of 1,174; mismatch count is 0.
- A rollback-only database integration test exercised atomic tracked-unit creation, a transfer containing tracked and untracked stock, idempotent transfer retry, unit branch movement, and atomic unit deletion. Assertions passed and all writes were rolled back.
- Separate rollback-only tests exercised sale return, supplier return, trade-in and sale reversal stock reconciliation. Assertions passed; temporary GRN/return/unit/reversal records were rolled back. Follow-up checks found zero test records and the production stock totals unchanged.
- Existing sales, purchases/GRNs, expenses, day sessions and inventory units are backfilled to Main and have no null `branch_id` rows in the production check. The actual connected shop remains single-branch after the rollback-only tests.
- Manual tracked-unit add/edit/delete now uses the atomic branch-scoped cloud RPCs online and durable queue operations offline. New GRNs must be received at their originating branch; supplier returns validate the GRN branch and tracked-unit branch.
- The migrations are committed under `supabase/migrations/`: `20261009080000_add_branch_model_and_backfill.sql`, `20261009081500_add_branch_aware_transaction_rpcs.sql`, `20261009083000_bind_pos_devices_to_branches.sql`, `20261009084500_add_branch_provisioning_rpc.sql`, `20261009090000_harden_branch_rpc_idempotency.sql`, `20261009091500_add_branch_stock_adjustment_rpc.sql`, `20261009091600_branch_stock_primary_key_and_fk_indexes.sql`, `20261009091700_add_branch_inventory_units_atomic_rpc.sql`, `20261009091800_delete_branch_inventory_unit_atomic_rpc.sql`, `20261009091900_branch_stock_returns_reversals_tradeins.sql`, and `20261009092000_reconcile_tracked_stock_across_branches.sql`.
- `owner_daily_sales` remains shop-level. No Owner Web branch UI or Phase 3 work was started.

### Phase 2 checklist

- [x] Additive schema, Main-branch backfill, transactional `branch_id`, branch-scoped units, RLS and device binding are applied.
- [x] Branch stock transfer and stock-adjustment RPCs enforce shop membership/role, same-shop branches, quantity checks and idempotency.
- [x] Tracked-unit add/delete and supplier-return paths enforce branch ownership; sale returns, reversals and trade-ins reconcile stock across branches.
- [x] Production product total and branch-stock total reconcile (1,174 units; delta 0; 0 mismatched products).
- [x] Rollback-only transfer, tracked-unit, sale-return, supplier-return, trade-in and reversal integration tests passed; test records and stock changes were rolled back.
- [x] POS CI passed: https://github.com/sanjula26/NexFix-POS/actions/runs/37910038697
- [x] POS Security Audit passed: https://github.com/sanjula26/NexFix-POS/actions/runs/37910038970
- [x] Windows Desktop Build passed on code commit `83426a87655a8978b7988b960ba39db7dc062673`, including installer/portable artifact verification, checksums, private Cloudflare R2 publishing, Supabase compatibility chunks, cleanup and final private-release verification: https://github.com/sanjula26/NexFix-POS/actions/runs/37910038785
- [x] Phone Sales deployment passed on the same commit; Owner Web Phase 1 remains read-only and shop-level: https://github.com/sanjula26/NexFix-POS/actions/runs/37910038874
- [x] Branch stock primary key and branch-related foreign-key indexes are deployed and recorded in migration source.
- [x] Branch selection guards, GRN-to-branch binding, branch-scoped day-end, atomic stock editing and offline queue behavior are implemented.
- [x] Final production reconciliation after rollback-only tests: 23 products, 1,174 shop units, 1,174 branch units, delta 0; no test rows remained.
- [x] Phase 3 was not started during Phase 2; the owner explicitly authorized Phase 3 on 2026-10-09.

**Phase gate:** Phase 2 verification is green on the functional code commit above. Do not add Owner Web branch selectors, branch-level Owner Web KPIs, or all-branches aggregation until Phase 3 is explicitly authorized.


## Phase 3 implementation update (2026-10-09)

- Added the Owner Web branch switcher using only active branches for the membership-resolved shop, a `Currently viewing` label, a today's sales snapshot, and a manual snapshot refresh. Single-branch shops select their sole branch without presenting an unnecessary `All branches` choice.
- Dashboard KPIs/charts, invoice pages, and sales reports follow the shared branch selector. `All branches` uses a branch/date aggregate RPC and combines aggregate rows rather than downloading all sales.
- Added read-only stock valuation and low-stock-by-branch reporting, including CSV export. Cost value = `branch_stock.qty × products.cost`; selling value = `branch_stock.qty × products.price`; potential profit = selling value − cost value. Inactive products with remaining branch stock remain visible so the valuation reconciles to stock rows; inactive branches are excluded from this active-branch report.
- Added `public.get_owner_branch_daily_sales` and `public.get_owner_branch_stock_valuation`. Both are SECURITY INVOKER, require `auth.uid()` plus active membership in the supplied shop, validate any branch against that same shop, and grant execution only to `authenticated`. The sales date predicate uses the existing shop/branch/created_at index shape. No service-role key is used in browser code.
- Credit and cash-in-hand remain shop/POS-day-session level and are not represented as branch-level numbers. No polling was added; branch snapshot refresh is manual.
- Applied the reporting migrations to the connected production Supabase project and checked them into `supabase/migrations/20261009094114_owner_web_branch_reporting.sql` and `supabase/migrations/20261009094302_optimize_owner_branch_daily_sales_range.sql`.
- Production SQL verification: today's branch sales RPC returned 4 completed invoices / LKR 91,650, matching a direct shop-scoped sales aggregation (4 / LKR 91,650). Stock valuation RPC returned 23 product/branch rows; cost value LKR 257,000 and selling value LKR 2,494,800 matched the direct `branch_stock` × product cost/price calculation; potential profit was LKR 2,237,800.
- The connected production shop currently has one active branch (Main). Single-branch UX and data reconciliation were checked against live data, but a multi-branch interaction cannot be exercised against production until a second active branch exists. Owner Web CI completed successfully for the Phase 3 UI fix commit: https://github.com/sanjula26/NexFix-POS/actions/runs/37913373846 (dependency install, typecheck, lint, and production build all passed). The connected production shop still has only one active branch, so a true multi-branch interaction smoke test remains pending. Do not claim the full UI checklist is 100% green until that multi-branch behavior can be exercised.

### Phase 3 checklist

- [x] Branch switcher, current-view label, today's snapshot and manual refresh are implemented.
- [x] Dashboard, sales pages and sales summary are branch-filtered; all-branches values use branch-scoped aggregate rows.
- [x] Stock cost/selling/potential-profit valuation, low-stock status and stock CSV export are implemented.
- [x] RPCs enforce active shop membership and same-shop branch validation; no service-role browser key or polling.
- [x] Live sales aggregate and stock valuation calculations match direct database calculations.
- [x] One-branch selector UX stays simple.
- [x] Desktop POS, Drive backup, updater and R2 files were not modified; Phase 4/5 were not started.
- [x] Owner Web dependency install, typecheck, lint and production build passed in Owner Web CI: https://github.com/sanjula26/NexFix-POS/actions/runs/37913373846.
- [ ] Interactive multi-branch smoke test remains pending because production currently has only one active branch.
