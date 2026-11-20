# Branch Data Isolation — Implementation Plan

Status: design and implementation gate; no database migration or production data change is included.
Related issue: https://github.com/sanjula26/Nexfix-POS/issues/259

## Product requirement
A staff member or POS terminal assigned to Branch A must only be able to read and mutate Branch A operational data. Branch B records must remain inaccessible even if a caller changes a PostgREST filter, supplies another branch UUID, invokes an RPC directly, replays an offline write, or opens a stale local cache.
The UI is a usability layer, not the security boundary. PostgreSQL RLS and server-side RPC authorization must enforce the boundary.

## Proposed access model
| Actor | Branch visibility | Mutation scope |
|---|---|---|
| Shop owner / explicitly privileged cloud admin | All active branches in the authorized shop | All branches, with audited privileged actions |
| Manager | Only explicitly assigned branch(es); no cross-branch access by virtue of the Manager role | Assigned branches only |
| Cashier | Assigned branch only | Permitted cashier operations in assigned branch |
| Technician | Assigned branch only | Permitted repair/workflow operations in assigned branch |
| Unassigned / revoked cloud member or device | No branch operational data | No branch operational mutations |

**Current Owner/Admin identity mapping:** the `shop_memberships.role` constraint currently allows `admin`, `manager`, `cashier`, `technician`, and `inventory_manager`; it has no separate `owner` role. Until a distinct server-verifiable owner entitlement is designed, all-branch access must be limited to the active cloud membership with `role = 'admin'`. The local POS `admin` role is not sufficient and must never be treated as a Supabase all-branch grant.

Keep local POS users/roles separate from Supabase Auth identities. Do not treat a shared cloud login as proof that each employee has a distinct identity.

## Identity and device binding
1. Require an authenticated cloud identity for cloud branch data access.
2. Model explicit active cloud-member-to-branch grants, and separately validate the registered device's active branch assignment.
3. The effective scope is the intersection of the user's active branch grants and the device's active branch assignment. A device binding must never widen a user's grants.
4. A shared cloud user on multiple devices has the union of its explicit user grants; each device is additionally restricted to its own bound branch. Prefer distinct cloud identities for staff when individual accountability is required.
5. Owner/admin all-branch access must be an explicit server-side privilege, never inferred from a client-supplied role, branch ID, or device ID.
6. Revocation must take effect on the next server request. Cached branch identity is not authorization.

## Data classification and default policy
| Data | Initial intended scope | Gate |
|---|---|---|
| Product catalogue / SKU definitions | Shop-wide read | Confirm no branch-private purchase cost or supplier fields are embedded |
| Branch stock, stock adjustments, inventory units / IMEI / serial | Branch-private | Enforce branch RLS and RPC checks |
| Sales, sale items, sale payments, cashier sessions, expenses | Branch-private | All parent and child rows must be scoped consistently |
| GRN / purchases and purchase items | Branch-private by default | Supplier master can be shared only if explicitly approved |
| Stock transfers | Visible only to assigned source/destination branches; owner sees all | RPC checks both ends and the caller's permission for each end |
| Repairs and warranty history | Branch-private by default | Repairs currently lacks a durable branch key; do not expose as branch-private until safely backfilled |
| Customer contact profiles / customer master | Owner/Admin shop-wide; branch staff only explicitly branch-linked profiles | No direct branch key exists; use a branch-safe projection/RPC, not shop-member SELECT on `customers` |
| Suppliers, price lists, quotations, shop settings | UNDECIDED / shop-level candidate | Confirm whether supplier, cost, quotation and price information should be hidden between branches |
| POS full-state snapshots | Admin-only until replaced | Never allow branch staff to download a shop-wide snapshot |
| Google Drive backups | Shop-scoped and admin-only | Restore must not merge another shop/branch dataset |

## Approved customer and credit visibility model — owner confirmed 2026-11-21

- **Owner/Admin:** full shop-wide customer contact profiles, all branch invoices, complete settlement history, and the canonical shop-wide customer credit balance.
- **Manager/Cashier/Technician/Inventory Manager and other branch staff:** only customer profiles explicitly linked to their assigned branch(es); only invoices whose `sales.branch_id` is in that assigned set; and only the invoice outstanding/settlement details for those invoices. An invoice in the staff member's own branch may show its own stored `customer_name` snapshot. It must not reveal another branch's customer profile, contact details, invoice or settlement history.
- **Balances:** the existing `customers.credit_balance` is shop-wide and must be Owner/Admin-only. Branch staff receive a server-computed outstanding total for invoices in their authorized branch set only. Do not return the shop-wide balance, even as a hidden field.
- **FIFO settlement:** branch staff may settle and FIFO-allocate only within their authorized branch set. A payment collected by a branch-only user must not allocate to an invoice outside that set. Owner/Admin may settle and allocate across the whole shop. Preserve payment tender legs, invoice allocations, idempotency, audit attribution, offline conflict handling and day-end totals.
- **Data-model gap:** `customers` currently has no `branch_id`; one canonical customer can have sales at multiple branches. `CustomerCreditPayment` currently lives inside the shop-wide POS snapshot and records a collection `branchId` plus invoice allocations; it is not a normalized server-side ledger with independently enforceable invoice-branch visibility. Design a canonical customer identity with explicit customer-to-branch visibility (or an equivalent secure branch-scoped projection) and a normalized/equivalently protected payment/allocation ledger. Do not duplicate customers, silently split `credit_balance`, or break historical FIFO allocations.
- **RPC and snapshot gates:** `get_owner_credit_customers(p_shop_id)` and direct `customers` table access must be Owner/Admin-only. Branch customer lookup and branch invoice outstanding must use narrow server-authorized RPCs. The full shop-wide `pos_state_snapshots` payload must never be downloaded by branch-only users.

- **Current cloud-sync compatibility risk (source-verified on main):** `sanitizeCloudSnapshotState()` removes only local users, sessions, device-local branch selection and admin PIN hash, then spreads the rest of `POSState`; therefore customers and `customerCreditPayments` remain in the shop-wide snapshot sent by `syncStateSnapshot()` and returned by `downloadStateSnapshot()`. The normalized customer sync path also maps the complete local `state.customers` array and reads the shop-wide `customers` table to match phone numbers. Simply tightening the customer table SELECT policy or snapshot SELECT policy would break current sync and could leave branch devices with stale/incomplete data. Replace these paths with owner/admin-only global sync plus narrow branch-authorized customer/profile and invoice-allocation sync before enabling branch-only accounts. Preserve offline queue, conflict/revision and Google Drive backup contracts.
- **Rollout:** existing historical customer/invoice/payment data must be reconciled using synthetic Branch A/B fixtures first. Unknown or ambiguous customer/branch links fail closed to Owner/Admin until safely resolved. This requires a reviewed schema/RLS/sync change; do not apply it to production as part of a documentation update.

### Customer and credit negative/positive tests required

- Branch A cannot SELECT or search customer contact profiles linked only to Branch B, including by direct table query, guessed customer UUID, search RPC, Owner Web route, CSV export or detail endpoint.
- Branch A can retrieve only customer projections explicitly linked to Branch A and can see the customer-name snapshot on Branch A invoices only.
- Branch A cannot read Branch B invoices, invoice payment details, settlement headers, allocations or credit history, even when it supplies Branch B sale/payment/customer IDs.
- Branch A's outstanding-credit aggregate contains only Branch A invoices and never returns the global `customers.credit_balance` or a cross-branch total.
- Branch A FIFO allocation can touch only invoices in its authorized branch set; attempts to allocate to Branch B must fail atomically. Owner/Admin shop-wide FIFO may allocate across branches.
- A settlement collected at Branch A cannot silently change an allocation on a Branch B invoice. Concurrent Branch A/Branch B settlement attempts must preserve idempotency, correct invoice due, tender legs and day-end totals.
- Owner/Admin can read full customer profiles, shop-wide balance, all invoices and complete settlement/allocation history; direct calls to `get_owner_credit_customers` by a branch-only identity are denied.
- Ambiguous historical customer/branch links fail closed to Owner/Admin until reconciled; no automatic customer duplication or balance split is allowed.

Unknown or unclassified data must not be exposed to branch-only users by default.

## Proposed customer and settlement storage boundary (design only; no schema created)

Candidate design for review before any migration:

1. Keep one canonical `public.customers` identity per real customer. Make direct table reads and unrestricted writes Owner/Admin-only. Do not copy the whole customer table into each branch.
2. Add a relation such as `public.customer_branch_access(shop_id, branch_id, customer_id, active, created_by, created_at)`, with composite shop/branch/customer foreign keys and uniqueness on (branch_id, customer_id). A branch profile is visible only when this explicit relation is active and the caller has a grant to that branch. A customer used at another branch is not automatically visible there; Owner/Admin can explicitly link the canonical identity to another branch.
3. Provide a narrow branch-customer lookup/create/update RPC. It must derive and validate the caller's effective branch grant server-side, verify the registered device's binding where applicable, return only approved contact fields, and never return global `credit_balance`, other branch links, or other-branch activity. A phone collision with a customer not linked to the caller's branch must return a generic safe response, not reveal the other branch's customer identity/contact data.
4. Normalize credit collections into a payment header (collecting branch, cashier/member, tender legs, idempotency key, timestamp) and invoice allocation rows (sale ID, target invoice branch, allocated amount). Every allocation must be validated against the target sale's shop/customer/status and branch. RLS/RPC projections must let branch staff see only allocations affecting their authorized invoices, without exposing a payment header's other-branch collection details. Owner/Admin can see the complete header and allocation history.
5. A branch-only cashier/manager can create a settlement only against invoices in their authorized branch set; FIFO orders only those invoices. Owner/Admin may run shop-wide FIFO. A shop-wide customer balance remains a canonical aggregate for Owner/Admin; branch staff receive a server-computed sum of outstanding invoices in their authorized branch set, never the global balance.
6. Add an immutable offline settlement command containing the original shop, branch, sale allocations, member, device, and idempotency key. Replay must reject revoked/reassigned branch scope or any allocation outside the caller's current grant; it must never silently remap an old payment to the device's new branch. Preserve snapshot revision conflict handling until the branch-safe sync protocol replaces the full snapshot.
7. Keep `get_owner_credit_customers(p_shop_id)` as an Owner/Admin-only consolidated read, with an explicit active cloud `role = 'admin'` check (or a separately verified Owner entitlement). Do not authorize it with `private.is_shop_admin`, because that helper includes Manager.

**Cross-branch customer reuse rule:** if the same person shops at Branch A and Branch B, the canonical customer ID may be explicitly linked to both branches by Owner/Admin. Staff at each branch then see the contact projection only because that branch link exists; they still cannot see the other branch's invoices or settlement history. A branch-created profile is not automatically shared. If a same-phone match exists only in another branch, ask Owner/Admin to link it rather than leaking the existing record or creating a duplicate canonical customer.

This is a proposed data contract, not an approved migration. Before implementing a new table, RPC contract or ledger, present the exact migration and obtain the required separate approval. Use synthetic fixtures to test unique-phone collisions, multi-branch customer links, partial FIFO, Owner/Admin cross-branch settlement, concurrency, offline replay and revoked grants.

**Existing FIFO helper limitation (source-verified on main):** `src/lib/customerCredit.ts::allocateCreditPaymentFIFO()` filters only by customer ID and completed status, then orders by invoice date/bill number. Its sale input type does not include `branchId`, and it accepts no authorized-branch set. Existing `tests/customer-credit-allocation.test.ts` covers ordinary FIFO/partial allocations but no branch filtering or cross-branch denial. The implementation must extend the domain contract to require the server-authorized branch set (not a client-selected branch), include branch provenance on every invoice/allocation, and add Branch A/B positive and negative tests. The browser helper may improve UX, but the server transaction/RPC must independently validate every allocation.

## Database enforcement

**Existing role-helper caveat (source-verified 2026-11-20):** `private.is_shop_admin(shop_id)` currently treats both `admin` and `manager` membership roles as true (the canonical helper was moved from `public` to `private`; its source predicate is `role in ('admin','manager')`). It is used by existing write policies and device-management paths. Do not reuse this helper as the all-branches privilege. The new branch authorization design must distinguish (1) role capabilities, (2) assigned-branch scope for Managers, and (3) explicit all-branch Owner/Admin entitlement. Preserve legitimate Manager actions only within their assigned branch(es), and audit every existing helper use before replacing policies.

1. Introduce a small private authorization helper with SECURITY DEFINER, a fixed empty search_path, fully qualified object references, strict auth.uid() checks, active shop membership, active branch, active member grant, and active device binding.
2. Revoke helper execution from PUBLIC and anon; grant only the minimum required role(s). Review function owner and RLS recursion behavior.
3. Apply SELECT, INSERT, UPDATE, and DELETE RLS policies separately to every branch-owned table. USING and WITH CHECK must both enforce scope.
4. For child rows, authorize through the parent row's branch/shop relation; do not trust a client-supplied branch_id alone.
5. Audit every SECURITY DEFINER RPC and every mutation path. Reject mismatched shop, branch, device, user, role, inactive branch, revoked assignment, and cross-branch IDs.
6. Keep owner reporting all-branch behavior only behind an explicit owner/admin check in the database function.
7. Ensure no anonymous grants, broad table grants, views, or RPCs bypass the RLS boundary.

## POS, cache, sync, and restore
- Partition IndexedDB stores, localStorage caches, and offline queues by both shop ID and branch ID (and retain device identity where required).
- Do not render cached records until the current cloud identity and branch binding have been revalidated; clear or quarantine stale in-memory views on account/branch switch.
- Queue entries must carry immutable shop/branch/device/actor/idempotency metadata. The server revalidates all of it during replay; reject mismatches rather than silently rerouting.
- Do not sync a single shop-wide snapshot to branch users. Keep snapshot read/write admin-only until a separately designed branch snapshot protocol is tested.
- Drive backup remains shop-scoped/admin-only unless a separate branch-backup feature is explicitly approved. Restore must validate the target shop and branch before applying data.
- Avoid putting secrets, tokens, recovery keys, or personal customer data in logs or tests.

## Required test matrix
- Branch A user cannot select Branch B rows by changing filters, IDs, joins, views, or RPC arguments.
- Branch A user cannot insert/update/delete Branch B records or move a row to Branch B.
- Wrong shop, wrong branch, wrong device, revoked member, revoked device, inactive branch, and missing session are denied.
- Owner/admin can access all authorized branches; manager/cashier/technician cannot exceed explicit grants.
- Same cloud identity on two devices is constrained by each device binding; test the intended shared-login behavior explicitly.
- Child rows (sale items/payments, purchase items, unit records) cannot be read without access to their parent branch.
- Stock transfer requires authorization for source and destination; no partial transfer on failure.
- Repair records with missing branch IDs remain inaccessible to branch-only roles until safely classified/backfilled.
- Snapshot endpoint cannot disclose another branch's operational data.
- Offline queue replay after branch switch, logout, revoked assignment, or device reassignment is rejected safely.
- Restore from another shop or branch is rejected; backup contents remain isolated.
- Owner Web branch selector and reports preserve explicitly authorized owner all-branch access.

## Migration and rollout sequence
1. Inventory every table, view, RPC, trigger, edge function, and sync path that reads or mutates shop/branch data.
2. Apply the owner-approved customer/credit visibility model recorded above. Obtain separate owner decisions for suppliers/costs, quotations and warranty sharing before changing those policies.
3. Implement schema and helper functions in a disposable local/staging database with representative synthetic Branch A/B data.
4. Add policies/RPC checks and run direct PostgREST + RPC negative tests under real authenticated test identities.
5. Implement client branch scoping, IndexedDB partitioning, offline replay checks, and snapshot restrictions.
6. Backfill missing branch IDs only from reliable source evidence. Ambiguous historical rows must be quarantined or remain owner-only; never guess Main.
7. Test backup/restore, updater compatibility, and Windows offline/online flows.
8. Review migration and rollback plan, then request explicit owner approval before any production migration.
9. Roll out with monitoring and a tested rollback path; do not delete historical records.

## Current verified baseline (2026-11-17)
- Production has active branches named Main and home.
- Production has six active registered POS devices and one active cloud membership identity.
- Branch-device binding rows do not cover all six active devices.
- Existing resolveCloudBranchId() treats the device binding as the authoritative branch selector in multi-branch shops, but this alone does not create per-employee authorization.
- Settings branch-management code can list active branches for the shop and permits admin/manager device binding. The current design therefore needs both a member grant and device binding before it can safely isolate employees.
- The single shop-wide pos_state_snapshots design is not suitable for branch-only readers.
- Production database inspection for this baseline was read-only. No production schema, RLS, permissions, customer, stock, sales, backup, or release data was changed.

## Explicit non-goals for the first migration
- No automatic reassignment of existing staff or devices.
- No automatic movement of old sales, credit balances, repairs, or stock records between branches.
- No production policy changes before staging verification and owner approval.
- No weakening of the admin-only snapshot write path to make cashier sync appear to work.

## Production policy/table inventory (read-only query, 2026-11-17)
- Tables with a direct branch_id column in the current public schema: branch_stock, branch_stock_adjustments, day_sessions, expenses, inventory_units, pos_device_branches, purchases, and sales.
- Operational child tables without their own branch_id must be authorized through their parent: sale_items and sale_payments through sales; purchase_items through purchases; repair_parts through repairs; transfer lines through stock transfers.
- repairs, warranty_claims, customers, quotations, suppliers, and the transfer header tables do not have a direct branch_id column in the inspected schema. Their intended branch visibility therefore cannot be safely implemented by adding a client-side filter alone.
- Read policies for branches, branch_stock, branch_stock_adjustments, day_sessions, expenses, inventory_units, pos_device_branches, purchases, sales, customers, quotations, repairs, suppliers, warranty_claims, and transfer records currently rely on shop-membership checks in the inspected policies. This is a shop boundary, not a per-branch boundary.
- pos_state_snapshots has a member SELECT policy keyed to shop membership. Because the snapshot is one row per shop, this is a direct cross-branch disclosure risk if non-admin branch users can read it.
- Some child table policies correctly traverse to a parent row, but the parent predicate is still shop-membership based. Parent traversal alone does not enforce branch isolation.
- These findings are based on schema metadata and pg_policies inspection only; no application queries were run as a different employee identity and no production records were read or changed.


## Claude review cross-check (2026-11-17)

The two supplied static review reports were cross-checked against the current `main` source and the branch-isolation audit. They are useful risk inventories, not runtime verification; both reports explicitly state that they did not run the live POS, production Supabase workflows, device/printer tests, or penetration tests.

### Findings confirmed or still open
- Large-file maintainability concern remains valid: `src/lib/store.tsx` is about 235 KB in the current main snapshot; `src/pages/POS.tsx`, `src/pages/Settings.tsx`, and `src/lib/cloudSync.ts` are also substantial. Continue with characterization tests and small extractions, not a rewrite.
- Offline queue, crash recovery, concurrent checkout, duplicate replay, and restore failure scenarios still need runtime/integration coverage.
- Backup existence is not proof of restore readiness. Wrong-shop, partial, corrupted, old-version, interrupted, duplicate, and large-backup restore scenarios remain release gates.
- Role/permission checks must be tested through direct PostgREST/RPC calls, not only UI visibility.
- Branch-level access remains a confirmed separate gap from shop-level tenant isolation; this plan and Issue #259 track it.

### Corrections against the 2026-11-12 report snapshot
- The report says no unit-test script/test runner was observed. Current `package.json` has `test` (Node test runner with TypeScript stripping) and `test:domain`; CI runs `npm test`, `npm run verify:boundaries`, typecheck, lint, and production build. Existing tests include IndexedDB queue/checkpoint persistence, credit allocation, supplier ledger, opening-float behavior, and branch-stock cache invariants. This is meaningful progress, but it is not yet full UI/E2E or live Supabase integration coverage.
- The report cites Vite 7.3.1 and an open update to 7.3.7. Current `main/package.json` declares Vite `^7.3.7`; verify the lockfile and advisory status in the release audit rather than treating that old finding as current.
- The report describes the fallback as if it lives in `src/lib/db.ts`. Current `db.ts:idbLoadState()` returns `null` on IndexedDB read/open failure instead of returning a seed. However, `src/lib/store.tsx` still handles a null boot result by loading localStorage or `buildSeed()`, setting that state, and attempting an IndexedDB save. This remaining boot-path behaviour needs a focused fail-closed/read-only UX review; do not claim the whole storage fallback risk is resolved.
- The current snapshot sanitizer removes local users, sessions, device-local branch selection and admin PIN hash, but otherwise serializes the POS state. A single shop-wide snapshot remains incompatible with branch-private state until the server-side read/write model is redesigned.

### Current CI evidence for this documentation PR
- PR #263 `source-security`: completed successfully.
- PR #263 `verify`: completed successfully.
- These are CI checks for this documentation-only change; they do not prove branch RLS isolation or runtime business correctness.

## Owner Web authorization cross-check (production read-only, 2026-11-17)

Owner Web is read-only, but read-only does not mean owner-only. The current UI and deployed RPCs have a shop-membership authorization boundary, not an owner/admin or per-branch boundary.

### Confirmed in current main source
- `apps/owner-web/src/App.tsx` resolves one active `shop_memberships` row for the signed-in user. It selects `role`, but the current tenant state stores only shop ID/name/currency; the role is not used to gate Owner Web access.
- The branch selector is a client-side presentation filter. A caller can bypass it and call the RPCs directly.
- The app invokes `get_owner_branch_daily_sales` with `p_branch_id = NULL` for all-branch aggregates, and invokes `get_owner_branch_stock_valuation` with NULL for all-branch valuation.
- Owner Web also invokes `get_owner_credit_customers`, which returns shop-wide customer names, phone/email, credit balances and open-invoice balances.

### Confirmed against deployed production definitions
- `public.get_owner_branch_daily_sales(uuid,date,date,uuid)`, `public.get_owner_branch_stock_valuation(uuid,uuid)`, and `public.get_owner_credit_customers(uuid)` are SECURITY INVOKER, have an empty search_path, and are executable by authenticated (not anon). These are positive controls.
- Each function checks only for an active `shop_memberships` row. Branch sales and stock valuation accept any active branch in the shop; NULL returns all branches. The credit RPC returns shop-wide credit/customer data.
- `public.owner_daily_sales` has an authenticated SELECT policy using `private.is_shop_member(shop_id)`; it is also shop-level, not owner-only.
- The current active production membership inventory contains one active `admin` membership. This is a latent authorization gap for future staff cloud identities, not evidence that a non-admin staff user has already accessed Owner Web.
- `pos_state_snapshots` currently has 0 rows in production. Its active SELECT policy is still membership-based (legacy `pos_shop_members` check); this is a latent exposure path, not an observed snapshot disclosure.

### Required correction before branch staff cloud accounts are enabled
1. Make Owner Web explicitly owner/admin-only at the server boundary, or define a narrowly scoped branch-report role with explicit grants. Do not trust the UI role check alone.
2. Add branch grant validation to branch-specific reports and keep all-branch aggregates/stock valuation behind an explicit owner/admin privilege.
3. Enforce the confirmed rule: Owner/Admin-only shop-wide customer contacts, global credit balance and full settlement history; branch staff receive only explicitly branch-linked customer profiles and invoices/settlements within their assigned branch set.
4. Test direct authenticated RPC calls for Branch A, Branch B, manager, cashier, technician, revoked member and owner/admin; include NULL/all-branch arguments and cross-branch IDs.
5. Keep the full POS snapshot read path unavailable to branch-only users until a branch-safe sync protocol exists.

No production function, grant, RLS policy, data, or setting was changed during this inspection.

## Owner Web direct data-access and policy matrix (production read-only, 2026-11-17)

The current Owner Web `App.tsx` data calls were enumerated from source. These are all read paths; the branch selector does not change the underlying database authorization rules.

| Owner Web data path | Current application filter | Production policy / RPC boundary | Isolation requirement |
|---|---|---|---|
| `shop_memberships`, `shops` | Active signed-in membership resolves one shop | Membership self/admin read; shop member read | Retain and enforce cloud role; do not treat every active member as Owner Web owner |
| `branches` | Active branches for selected shop | `private.is_shop_member(shop_id)` | Branch list may be available to member, but branch data/report access must use explicit grants |
| `sales` | Shop + completed + date range; selected branch filter is added client-side | `private.is_shop_member(shop_id)` | Enforce branch scope in RLS; do not trust the optional client filter |
| `get_owner_branch_daily_sales` | Selected branch or NULL for all | SECURITY INVOKER; active shop membership; any active branch / NULL all | Owner/admin-only for NULL; branch grant for specific branch |
| `get_owner_branch_stock_valuation` | Selected branch or NULL for all | SECURITY INVOKER; active shop membership; any active branch / NULL all; exposes unit cost and potential profit | Owner/admin-only for all-branch and cost-sensitive output; branch grant for branch-specific output |
| `sale_items`, `sale_payments` | Fetched only after parent invoice is loaded | Parent `sales` row + `private.is_shop_member(shop_id)` | Parent access must be branch-authorized before child access |
| `get_owner_credit_customers` | No branch parameter | SECURITY INVOKER; currently active shop membership only; returns shop-wide contact and credit/open-invoice balances | Replace with Owner/Admin-only authorization; retain this RPC for consolidated Owner/Admin reconciliation only |
| `day_sessions` | Shop + selected branch filter | SELECT `private.is_shop_member(shop_id)` | Branch-level read policy; verify cashier identity and branch ownership on inserts/updates |
| `expenses` | Shop + selected branch filter | SELECT `private.is_shop_member(shop_id)` | Branch-level read policy; existing insert/update/delete are admin-only but not branch-scoped |
| `profiles` | Profile details for visible cloud members | Self or shop-admin read | Keep minimal profile disclosure; do not mistake this for local POS cashier directory |

### Additional verified policy details
- `sales` SELECT and `branches` SELECT are shop-member policies. `sale_items` and `sale_payments` traverse to the parent sale but still use shop-member scope.
- `day_sessions` SELECT and `expenses` SELECT are also shop-member policies. Their application-side branch filters do not enforce isolation.
- `customers` SELECT is currently shop-member; `get_owner_credit_customers` returns phone/email and credit data across the shop. The owner has now approved Owner/Admin-only global customer/credit visibility plus branch-scoped customer projections and invoice balances; current policies do not enforce that decision.
- `owner_daily_sales` SELECT is shop-member. `pos_state_snapshots` SELECT is legacy membership-based; current production row count was zero when checked.
- These policy results were read from production `pg_policies`; no user data rows were queried or changed.

### Storage boot-path clarification
- `POSProvider` initializes its React state synchronously from `loadState()` (localStorage or `buildSeed()`). If IndexedDB is not available, `ready` starts as true and the boot effect returns after `setReady(true)`; it does not block the POS tree.
- If IndexedDB is available but `idbLoadState()` returns null after an open/read error, the boot effect falls back to localStorage or seed and attempts `idbSaveState(local)` without checking the boolean result.
- The debounced `persistState()` later emits `nexfix:storage-error` on a failed durable write, but the listener is mounted inside `POS.tsx`, not as a global write gate. This warning is not equivalent to preventing unsafe writes or disabling the checkout action.
- No fix is included here because a safe change needs a provider-level storage status, a clearly defined read-only/degraded mode, and tests covering first-run empty database, legacy migration, IndexedDB unavailable, IndexedDB open failure, failed initial seed save, and failed later writes. A simplistic `ready=false` or seed removal could lock out existing shops or cause data-loss confusion.


## Existing branch-migration enforcement cross-check (2026-11-18)

A filename/content review of the current `main` migration history was used to separate controls that already exist from the missing employee-level authorization layer. This is a repository-source audit; it does not claim that every historical migration has been applied to every environment.

### Controls already present in the migration source
- `20261009080000_add_branch_model_and_backfill.sql` creates `branches` and `branch_stock`, adds `branch_id` to sales, expenses, day sessions, purchases and inventory units, and backfills the legacy single-branch rows to the default branch. It also creates a trigger that validates an active branch belongs to the same shop.
- That migration's SELECT policies for `branches`, `branch_stock`, `stock_transfers` and `stock_transfer_lines` still use `private.is_shop_member(shop_id)`. These policies establish shop membership, not branch visibility.
- `20261009083000_bind_pos_devices_to_branches.sql` creates `pos_device_branches` and an admin/manager-controlled device assignment RPC. Its branch-aware sale/GRN wrappers check the selected device binding when the shop has multiple active branches.
- `20261014085952_restrict_direct_branch_transaction_rpc.sql` revokes direct authenticated execution of the lower-level sale/GRN SECURITY DEFINER implementations and leaves the device-bound wrapper entry points available.
- `20261014091202_enforce_registered_device_branch_binding.sql` strengthens the device-bound transaction path by requiring a registered, non-revoked device belonging to the authenticated cloud user and matching the selected branch. Other branch stock/unit RPCs contain similar device registration/binding checks.
- `20260923180000_harden_cloud_snapshot_admin_only.sql` retains an explicit shop-admin requirement for publishing the full-shop POS snapshot. This must remain separate from any branch-user read path.

### Missing authorization layer — do not confuse device assignment with staff assignment
- The reviewed migration inventory contains the device-to-branch table `pos_device_branches`, but no equivalent active cloud-member-to-branch grant table or helper was found in the branch-related migration set.
- The branch transaction wrappers validate shop membership/role and device binding; they do not establish that the signed-in staff identity has an independently granted branch membership. A shared cloud identity therefore remains a shared authorization identity even when two devices have different branch bindings.
- The branch-related RLS policies still need a complete current-policy inventory and branch-aware replacement. A device-bound mutation RPC does not make direct PostgREST SELECTs branch-private.
- The existing owner reporting RPCs also need explicit owner/admin or branch-grant enforcement; a client-side branch selector is not authorization.

### Implementation consequence
Do not start by adding a UI branch filter or by reusing `pos_device_branches` as if it were a staff membership table. The next safe database design step is to specify the member-grant identity, grant lifecycle/revocation, owner/admin all-branch privilege and same-cloud-user/multiple-device semantics, then test it on a complete isolated staging schema. Customer/credit visibility is now owner-approved and recorded above; supplier/cost, quotation and warranty sharing remain separate owner decisions. No migration, RLS policy, grant, production data or environment was changed by this cross-check.



## Owner Web RPC and aggregate scope cross-check (2026-11-18)

The current `main` migration source was inspected for the Owner Web reporting functions. These are additional, concrete cases where a branch selector is not an authorization boundary.

- `20261009094114_owner_web_branch_reporting.sql` defines `get_owner_branch_daily_sales(p_shop_id, p_from, p_to, p_branch_id default null)` and `get_owner_branch_stock_valuation(p_shop_id, p_branch_id default null)` as `SECURITY INVOKER`. Both check active shop membership and validate that a supplied branch belongs to the shop and is active. Neither checks that the caller is an owner/admin or has an explicit grant to the requested branch. When `p_branch_id` is null, the function intentionally returns all branches in the shop. With shop-member RLS still in place, a branch-only member can potentially request another branch or omit the filter.
- `20261009095808_owner_web_operational_read_views.sql` defines `get_owner_credit_customers(p_shop_id)` as `SECURITY INVOKER`, checks only active shop membership, has no branch argument, and aggregates customer contact and credit against completed sales across the shop. The owner has approved Owner/Admin-only access to this global result; enforce that inside the RPC and keep it unavailable to branch-only users.
- The branch model migration comments that `owner_daily_sales` remains a shop-level aggregate for Owner Web Phase 1 compatibility; its member SELECT policy is also shop-scoped. It cannot be treated as a branch-private report source without a separate branch-aware aggregate and authorization contract.
- The device-to-branch assignment table's own SELECT policy is shop-member based. That can reveal device-to-branch mapping to shop members; review whether that mapping itself is confidential, but do not confuse this with granting the member access to operational records.

### Required follow-up before enabling branch-only Owner Web access

1. Put an explicit owner/admin-or-member-branch-grant check inside each Owner Web RPC. A supplied `p_branch_id` must be checked against the caller's grant; null/all-branch mode must require explicit owner/admin privilege.
2. Keep customer credit and the legacy shop-wide aggregate behind an Owner/Admin-only boundary; implement the approved branch-scoped customer projection and invoice-allocation reconciliation before enabling branch staff access.
3. Test each RPC directly under Branch A and Branch B cloud identities, including omitted/null branch arguments, forged foreign branch IDs, inactive grants, revoked membership, and owner all-branch access.
4. Review all underlying table RLS policies and view/function grants as well; `SECURITY INVOKER` alone does not make a shop-member policy branch-aware.

This is a source/migration review, not a live impersonation test. No database, RLS, grants, production rows or application behavior were changed.


## Follow-up source audit — table policies and cross-branch RPCs (2026-11-18)

This section is a source-level migration review against current `main`, not a new production query or an identity-impersonation test. It complements the production policy observations above.

### Effective policy scope still stops at shop membership

- Branch-keyed operational tables — `sales`, `purchases`, `day_sessions`, `expenses`, `inventory_units`, `branch_stock`, and `branch_stock_adjustments` — have read policies using `private.is_shop_member(shop_id)` (or the equivalent membership helper). Their `branch_id` does not narrow SELECT visibility to the caller's assigned branch.
- Branch model tables — `branches`, `pos_device_branches`, `stock_transfers`, and `stock_transfer_lines` — also allow shop-member reads. Device assignment is therefore not itself a private employee-to-branch grant.
- Child rows inherit the same gap through their parent: `sale_items` and `sale_payments` authorize through `sales.shop_id`; `purchase_items` through `purchases.shop_id`; `repair_parts` through `repairs.shop_id`; and `quotation_items` through `quotations.shop_id`. Parent traversal is structurally useful but currently enforces shop, not branch.
- The hardening migrations narrow some writes to admin/manager while retaining shop-member reads. This improves mutation control but does not provide branch confidentiality.
- `audit_log` and `owner_daily_sales` are also shop-member readable. Treat their contents as shop-wide until a branch-aware policy or owner-only boundary is implemented.

### Tables without a reliable branch key

- `customers`, `repairs`, `warranty_claims`, and `quotations` have no direct branch key in the inspected schema. Their current membership-based policies cannot safely hide another branch's records.
- `suppliers` are shop-wide; the hardened policy permits shop-member reads while restricting writes. If supplier identity, purchase price, or terms are private between branches, split shared supplier identity from branch-specific supplier terms/cost data rather than applying an arbitrary UI filter.
- `products` are shop-wide catalogue records and include `cost` as well as selling price. A future shared-catalogue policy must explicitly decide whether cost is owner/manager-only or branch-granted; do not assume product SELECT is harmless simply because SKU/name are shared.
- `inventory_units` have a branch key but are currently shop-member readable; their IMEI/serial, purchase cost, warranty and sale linkage therefore need the same branch enforcement as stock quantities.

### RPC paths requiring explicit branch authorization

- `complete_stock_transfer` is a SECURITY DEFINER RPC executable by authenticated users. Its latest source definition checks active shop membership with role admin/manager, validates both branch IDs belong to the same shop and are active, and validates stock/IMEI movement. It does not check the caller's explicit grant to the source and destination branches or a registered device binding. Keep completion unavailable to branch-only managers until both-end branch authorization is added; a manager may transfer only when explicitly authorized for both endpoints.
- `create_shop_branch` currently permits both admin and manager cloud roles. Branch creation is shop-wide administration and must be Owner/Admin-only under the confirmed Manager assigned-branch-only rule.
- `set_pos_device_branch` currently permits both admin and manager roles to assign a supplied device ID to any active branch in the shop. It does not verify that the device is registered/non-revoked or that the caller has a grant to the target branch. Make device assignment Owner/Admin-only, or require a separately audited capability that cannot expand the caller's branch scope.
- The current Settings source contains the comment `Branch UI deactivated in POS Settings — backend retained for future multi-branch`. Hidden/deactivated UI is not a security boundary: the authenticated RPCs remain directly callable and must enforce the restrictions themselves.
- `get_owner_branch_daily_sales` and `get_owner_branch_stock_valuation` check active shop membership and validate a supplied branch, but not owner/admin role or member branch grant; NULL requests all branches. Their SECURITY INVOKER setting is positive, but the current underlying shop-member SELECT policies still permit shop-wide data.
- `get_owner_credit_customers` has no branch parameter and returns customer identifiers/contact details and shop-wide credit/open-invoice balances. Keep owner/admin-only until a deliberate customer/credit sharing model is approved and enforced in the database.
- Device-bound sale, GRN, stock-adjustment and tracked-unit RPC wrappers check registered device identity and branch binding in multi-branch shops. They still do not intersect that binding with a per-member branch grant because no such grant layer exists yet. Do not treat device binding as employee authorization.
- `set_pos_device_branch` checks the caller's shop role and that the target branch is active in the shop. Its source-level checks do not prove that the supplied device ID corresponds to a registered, non-revoked device; add this integrity check in a future staged change.

### Snapshot and rollout cautions

- The snapshot SELECT policy in the migration history still references legacy `pos_shop_members`. The device registration bridge creates/updates that compatibility membership from an active `shop_memberships` identity; the later snapshot hardening restricts snapshot writes to admin but does not itself replace the legacy SELECT policy. Keep snapshot reads admin-only until the deployed policy is verified and replaced safely. A previous production read-only inspection found zero snapshot rows; that is a latent access-path finding, not evidence of an observed disclosure.
- Do not add a new permissive policy alongside an old broad policy: PostgreSQL permissive policies combine with OR. The eventual migration must drop/replace superseded policies and test the complete effective policy set.
- Before rollout, test direct table SELECT/INSERT/UPDATE/DELETE and direct RPC invocation as Branch A, Branch B, unassigned member, revoked member, wrong device, reassigned device, and owner/admin. Include NULL/all-branch RPC calls, transfer source/destination combinations, parent/child row IDs, stale cache and offline replay.

No SQL, production policy, grant, customer data, or application behavior was changed as part of this source audit.


## Follow-up source audit — offline replay and sale/repair workflows (2026-11-18)

### Branch-sensitive mutation paths that currently rely on shop membership

- The current `private.process_sale_return_atomic` SECURITY DEFINER implementation checks active shop membership and role (`admin`, `manager`, `cashier`), loads the sale by `shop_id + sale_id`, derives its `branch_id`, and restores stock to that sale branch. It does not verify the caller's branch grant or registered device branch. The public SECURITY INVOKER wrapper is executable by authenticated users. A branch-only cashier could therefore attempt a return against another branch's sale ID unless another layer blocks the request; the current source does not show that branch check.
- `private.request_sale_reversal` likewise checks shop membership/role and sale existence/status, but not the sale branch against the caller's branch. Approval/rejection are admin-only, but a cashier/manager can create a pending request for another branch's sale.
- `private.register_trade_in_atomic` checks shop membership/role and derives branch from the linked sale, but does not validate a registered device or caller branch grant. It must be included in the same branch authorization review as returns.
- `private.process_purchase_return_atomic` does check active shop membership/role, registered device identity, and (in multi-branch shops) device binding against the original purchase branch. This is a useful control but still needs the member-grant intersection.
- `private.process_repair_delivery_atomic` uses the currently assigned device branch for stock consumption because `repairs` has no durable branch column. That protects stock from arbitrary branch arguments but does not prove that the repair itself originated at the current branch. Do not expose repairs as branch-private until a durable, trustworthy branch attribution/backfill rule is designed.

### Offline queue metadata and reassignment risk

- The normalized `sale_create` queue payload stores `input.branchId`, but not the original device ID; replay uses the current `getMachineIdentity().id`. Server validation must reject stale or mismatched branch/device/session combinations. Do not silently reroute a queued sale after device reassignment.
- `purchase_receive` stores the purchase payload (including its branch where present) and device ID. It still requires server-side member-grant + device-binding validation.
- `return_create` stores sale ID and return lines only; `sale_reversal_request` stores sale ID/reason only. The server must derive the immutable branch from the parent sale and authorize the current actor/device against that branch at replay, not trust a client-supplied branch.
- `repair_delivery` stores repair ID, repair payload and device ID, but no immutable branch ID or original branch attribution. Because the RPC uses the device's current branch, an offline repair queued on one branch and replayed after the device is reassigned could consume parts from the new branch while updating a branchless repair record. This is a data-attribution risk; fail closed until a durable repair branch and immutable queue metadata are implemented.
- Snapshot sync remains a separate full-shop compatibility path. Branch-only users must not download or publish a shop-wide snapshot; normalized branch-scoped operations are the required path.

### Required direct tests before enabling branch-only staff

- Branch A cashier calls return/trade-in/reversal request using Branch B sale ID: must be denied by the database RPC.
- Branch A device queues a sale/return/repair offline, then is reassigned to Branch B before replay: stale operations must be rejected and remain pending/quarantined, never be re-attributed.
- Branch B technician attempts to deliver a Branch A repair: denied until repair branch ownership is represented and validated.
- Branch A inventory manager attempts supplier return for Branch B GRN: denied even if the client sends a forged purchase ID/device/branch tuple.

These are source-level authorization findings, not live exploit tests. No SQL, production policy, application code, queue behavior, or production data was changed.


## Post-merge CI baseline — 2026-11-18

- Main now classifies root `@tailwindcss/vite` and `tailwindcss` as development-only dependencies and carries an npm-generated lockfile. The production-only security audit passed on the merged commit; Electron runtime is updated to 44.11.4.
- The full development/build-tool audit remains separate: 19 findings (14 high, 5 moderate), tracked in Issue #267. Do not force-downgrade Vite/electron-builder or suppress advisories to clear the report.
- This plan remains documentation only. No production branch authorization, RLS policy, grants, snapshot policy, customer-sharing rule, or SQL migration has been changed. The approved customer/credit policy still requires implementation and isolated staging tests; supplier, repair, warranty and quotation visibility still need separate design/owner decisions.


## Live cloud identity boundary recheck — 2026-11-21 (aggregate-only SQL)

A read-only aggregate query against the operational Supabase project returned:

- 6 active registered devices.
- 1 distinct active `auth.users` identity across those devices.
- 3 device-to-branch bindings across 2 active branches.
- 1 active `shop_memberships` row / 1 distinct active shop user.

No user IDs, device IDs, customer details, sales details or other row contents were returned by this aggregate query.

**Security consequence:** RLS based only on `auth.uid()` cannot distinguish the six terminals or the local POS employees using that single cloud identity. A device ID supplied by renderer code is forgeable and cannot be treated as an authenticated employee or terminal credential. A device-only branch binding can constrain a physical terminal only if the server receives a non-forgeable device proof; it still does not implement the confirmed per-Manager/per-staff assignment model.

Before implementation, choose a trusted actor model:
- Preferred: each cloud staff identity is individually authenticated and mapped to the local POS user, with explicit member-to-branch grants; or
- An alternative server-issued, short-lived, non-forgeable staff/device authorization token tied to a local POS user and branch grant, validated by every read/write RPC. Direct table reads must remain unavailable where the token cannot be checked.

Do not trust local `user.id`, role labels, `device_id`, branch selector state, or user metadata as proof. Keep the existing updater cloud account separate from local POS login until a reviewed identity-binding flow exists. This is a design blocker, not a claim that current users have been isolated.

## Supabase environment readiness recheck — 2026-11-21 (metadata only)

The connected Supabase project list and table/migration metadata were rechecked read-only:

- The operational project contains 44 public tables and 159 recorded migrations; latest recorded migration is `20261110120537 add_expected_branch_stock_guard`.
- Metadata reports 2 active branch rows, 3 `pos_device_branches` rows, 6 `pos_devices` rows, 1 active `shop_memberships` row, 35 sales rows, 3 customer rows and 0 `pos_state_snapshots` rows. No customer, sale, membership, device or other business row contents were queried in this recheck.
- The connected project named `NexFix POS Staging` still contains only 5 public tables (`shop_memberships`, `pos_shops`, `pos_shop_members`, `pos_devices`, `pos_state_snapshots`) and 3 fixture migrations (`20261110131158`, `20261110131205`, `20261110131510`). It does not contain `sales`, `customers`, branch stock, purchases, repairs, or the production RLS/RPC topology.
- Therefore this staging project cannot validate the customer/credit or complete branch-isolation migration. Do not copy production customer/sales data into it or treat the five-table fixture as a full-schema staging environment.
- No SQL was executed, no schema/data was changed, and no migration was applied. A full-schema synthetic test environment is still required before implementation; creating or expanding that schema requires separate approval.


## Owner decision — individual Cloud identity per staff member — 2026-11-21

The owner approved proceeding with a separate authenticated Cloud account for each staff member. This is an approved product/security direction, not approval to create or apply a database schema or production migration.

### Intended identity boundary

- Each employee has an individual Supabase Auth identity and active shop_memberships row. Cloud role is authoritative for server permissions; the local POS role label is not a cloud authorization claim.
- Owner/Admin provisions or invites staff accounts. Staff cannot self-enroll into the shop, grant themselves branches, change their role, or promote themselves to Owner/Admin.
- A trusted server-side mapping links the Cloud Auth identity to the intended local POS employee record. A renderer-supplied local user ID or email is not proof of identity.
- Each staff identity receives explicit active branch grants. The effective branch scope is the intersection of the staff member's grants and the registered device's verified branch binding. A Manager receives only explicitly assigned branches; the Manager role never grants all-branch access.
- Owner/Admin all-branch access is checked server-side using the active Cloud membership role admin (or a future separately verified owner entitlement). Do not reuse private.is_shop_admin, which includes Manager.
- Revoking the Auth user, shop membership, staff mapping, branch grant, or device authorization must fail closed on the next server request and must not be bypassed by cached state or offline replay.

### Keep updater authentication separate

- The existing Cloud Admin/updater session and per-device updater credential are a separate trust domain from the staff operational-data identity.
- Do not use the existing signInToCloud() / shared Supabase Auth client as the staff-login mechanism without a separately reviewed session design. The current client persists a Cloud session and provisions/refreshes the private updater credential; a staff sign-in must not overwrite the updater owner's session or grant an employee access to private release authorization.
- Preferred design: a dedicated staff Auth client/session lifecycle with its own secure persistence, bound to the local POS user after Owner/Admin-controlled pairing. The staff session must not call updater-token issuance, register_pos_device as an updater owner, or owner bootstrap flows.
- Keep local POS login and offline operation intact. If staff Cloud authorization is unavailable or revoked, cloud reads/writes fail closed while permitted local/offline workflows continue under their existing local permission rules; queued commands retain immutable actor, shop, branch, device and idempotency provenance and are revalidated on replay.
- Audit attribution for cloud writes uses the authenticated staff auth.uid(), never a client-supplied employee ID.

### Candidate server data contract — design only

A future migration may require (names are provisional):
1. An explicit staff identity mapping from (shop_id, auth_user_id) to the local POS employee identifier, with active/revoked state and unique constraints.
2. A member-to-branch grant relation with (shop_id, auth_user_id, branch_id, active, created_by, created_at), constrained to the same shop and active branches.
3. Owner/Admin-only provisioning/invitation and grant-management RPCs or Edge Functions. Service-role credentials must remain server-side; never ship them to the renderer.
4. Narrow branch-scoped read/write RPCs and RLS predicates that derive the actor from auth.uid(), validate active membership + mapping + branch grant + registered device binding, and check every parent/child relation.
5. Revocation and audit records; no long-lived bearer token or renderer-supplied device_id/local_user_id can replace server-side identity checks.

### Rollout and compatibility gates

- Do not enable individual staff Cloud accounts against the current shared shop-wide snapshot/customer sync. Replace full-shop snapshot download and normalized shop-wide customer sync with Owner/Admin global sync plus branch-authorized projections first.
- Preserve current updater Admin credentials and existing one-time Windows updater authorization. Staff Cloud login must not repeatedly prompt for or mutate updater credentials.
- Test separate Owner/Admin, Branch A Manager, Branch A Cashier, Branch B staff, unassigned staff, revoked staff and two devices; include direct table/RPC calls, null/all-branch Owner Web requests, offline queue replay, account switching, app restart and updater regression.
- The connected staging project is not a full operational schema. Use a complete synthetic Branch A/B fixture before production rollout; never copy production customer or sales records into staging.
- Exact mapping/grant table, RPC, RLS and session changes must be designed as a concrete migration with rollback and tests, then receive separate approval before schema creation/application. The owner's approval here confirms the individual-Cloud-account direction only.

No application code, database schema, migration, RLS policy, Auth account, membership, branch grant, production setting, or R2 object was changed by recording this decision.
### Source-grounded session isolation design — 2026-11-21

Current source review confirms that `src/lib/supabase.ts` creates one shared Supabase client with the default project-scoped Auth storage key and one custom `authStorage` adapter. `src/lib/cloudAuth.ts` subscribes to that client and persists its sessions into the Cloud updater recovery record; `refreshDesktopUpdaterCredentialsInternal()` can issue `authorize_pos_updater_device` credentials. The shared client therefore must remain the updater/owner trust domain.

Electron already encrypts Supabase Auth storage entries through `safeStorage` and stores them in a keyed map in the secure recovery file. `isCloudAuthStorageKey()` accepts namespaced `sb-...-auth-token` and PKCE verifier keys. Supabase JS supports an explicit `auth.storageKey` option (see [Supabase JS client initialization](https://supabase.com/docs/reference/javascript/initializing) and [AuthOptions storageKey type](https://github.com/supabase/auth-js/blob/master/src/lib/types.ts)).

Proposed client split, subject to implementation review:

1. Keep the existing exported `supabase` client and default storage key unchanged for the current Cloud Admin/updater flows. Do not rename or migrate its existing key as part of the staff rollout.
2. Add a separately constructed staff-only client using the same publishable key and encrypted storage adapter but a unique key such as `sb-ocmzgamnehwbkuwkjdrr-staff-auth-token`. Confirm the generated PKCE verifier key also passes the Electron key validator. Use an explicit `storageKey`; never share the default key.
3. The staff client must not be imported by `cloudAuth.ts` updater provisioning. It must not subscribe to `saveCloudUpdaterRecovery`, call `ensureCloudShop` as an owner bootstrap, call `register_pos_device`, call `authorize_pos_updater_device`, or call updater credential IPC.
4. Give staff sign-in/out a separate lifecycle and UI status. Staff sign-out clears only the staff client's local session/storage key. It must not set the existing global `cloudAuthSignedOut` marker or sign out the updater client. Owner/Admin updater sign-out must not erase staff storage either.
5. Do not let both Auth clients auto-consume the same callback URL. Use explicit staff invitation/reset callback routing with a flow correlation ID, then call `staffClient.auth.exchangeCodeForSession(code)` only on the staff client. Current Electron main code captures `code` and optional `sb_flow_id` in `pendingAuthCallback` and emits an event if a window exists, but source review found no consumer or pending-callback retrieval API. A closed-app callback can be retained without being delivered; fix and test callback handoff before using invite/magic-link flows. Do not assume the current callback bridge is already complete.
6. Staff Cloud sign-in should be optional for local POS login. No staff Cloud session must block local login or permitted offline POS work; it must fail closed only for cloud operations that require authenticated staff authorization.

Current Electron `safeStorage` persistence is OS-bound and the existing updater token is separately encrypted. The staff session can reuse the already namespaced Auth storage adapter without storing a password, but its storage key and sign-out lifecycle must be tested independently. Browser/dev mode uses localStorage, so test the separate key there too.

### Provisioning/invitation design remains gated

- Do not expose a renderer-side Supabase admin API or service-role key. Owner/Admin staff invitation and local-user pairing must run in a server-side Edge Function or tightly scoped server RPC, with active Owner/Admin membership checked from `auth.uid()`.
- Invite acceptance must bind the Auth user to the pre-created staff mapping; email address alone is not a local POS employee identity proof. An invitation token must be single-use/expiring and bound to the intended shop and staff mapping.
- Role and branch grants are assigned by Owner/Admin on the server, not taken from client metadata or invitation query parameters. The server validates that branch IDs belong to the same shop and are active.
- Until the mapping/grant schema and authorization RPCs are separately approved and deployed, the staff client must not be used to unlock operational cloud reads/writes. A separate login UI alone is not branch isolation.

### Additional account/session regression tests

- Existing updater Admin signs in, provisions a device token, restarts app, and downloads private update while no staff account is signed in.
- Staff signs in/out repeatedly on the same Windows profile; updater Admin session, updater recovery record, device token, R2 update check and local POS login remain unchanged.
- Switching local cashier/admin does not switch or overwrite the staff Auth identity. Signing out the updater account does not clear the staff Auth session; signing out staff does not clear updater credentials.
- Two staff accounts on one device cannot inherit each other's persisted Auth session or branch cache. A staff account on another Windows profile/device cannot reuse the first device's secure storage or device grant.
- Test fresh install, upgrade from current shared-session build, browser/dev storage, safeStorage unavailable, corrupt storage, app restart, refresh-token rotation, expired/revoked Auth user, revoked shop membership, revoked staff mapping and revoked branch grant.
- Exercise invitation callback when app is open, app is closed, app is already running, callback is replayed, flow ID mismatches, code expires, and callback URL is malformed. A callback must never authenticate the updater client accidentally.
- Run all tests with the existing Admin updater session in place; assert staff sign-in never calls updater-token issuance or mutates `cloudUpdaterDeviceToken`.

These are design/test specifications only. No staff Auth client, invitation flow, IPC, schema, migration, Edge Function, Auth user or branch grant was implemented in this documentation update.