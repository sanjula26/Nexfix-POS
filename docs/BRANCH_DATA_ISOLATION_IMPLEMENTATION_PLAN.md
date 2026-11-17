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
| Manager | Only explicitly assigned branch(es), unless separately granted cross-branch permission | Assigned branches only |
| Cashier | Assigned branch only | Permitted cashier operations in assigned branch |
| Technician | Assigned branch only | Permitted repair/workflow operations in assigned branch |
| Unassigned / revoked cloud member or device | No branch operational data | No branch operational mutations |

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
| Customers, credit balances, credit settlements, quotations | UNDECIDED | Existing roadmap treats some customer/credit data as shop-level. Do not silently split balances or history; obtain owner decision before migration |
| Suppliers, price lists, shop settings | UNDECIDED / shop-level candidate | Confirm whether supplier and cost information should be hidden between branches |
| POS full-state snapshots | Admin-only until replaced | Never allow branch staff to download a shop-wide snapshot |
| Google Drive backups | Shop-scoped and admin-only | Restore must not merge another shop/branch dataset |

Unknown or unclassified data must not be exposed to branch-only users by default.

## Database enforcement
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
2. Decide the unresolved shared-data policy (customers/credit, suppliers/costs, quotations, warranty) with the shop owner.
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
3. Decide whether customer credit, phone/email, and shop-wide customer balances are owner-only or shared by branch before exposing them to staff.
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
| `get_owner_credit_customers` | No branch parameter | SECURITY INVOKER; active shop membership; shop-wide customer contact and credit/open-invoice balances | Owner-only or an explicitly approved shared-credit policy; cannot be safely branch-filtered today |
| `day_sessions` | Shop + selected branch filter | SELECT `private.is_shop_member(shop_id)` | Branch-level read policy; verify cashier identity and branch ownership on inserts/updates |
| `expenses` | Shop + selected branch filter | SELECT `private.is_shop_member(shop_id)` | Branch-level read policy; existing insert/update/delete are admin-only but not branch-scoped |
| `profiles` | Profile details for visible cloud members | Self or shop-admin read | Keep minimal profile disclosure; do not mistake this for local POS cashier directory |

### Additional verified policy details
- `sales` SELECT and `branches` SELECT are shop-member policies. `sale_items` and `sale_payments` traverse to the parent sale but still use shop-member scope.
- `day_sessions` SELECT and `expenses` SELECT are also shop-member policies. Their application-side branch filters do not enforce isolation.
- `customers` SELECT is shop-member; `get_owner_credit_customers` returns phone/email and credit data across the shop. Customer/credit branch policy remains an owner decision.
- `owner_daily_sales` SELECT is shop-member. `pos_state_snapshots` SELECT is legacy membership-based; current production row count was zero when checked.
- These policy results were read from production `pg_policies`; no user data rows were queried or changed.

### Storage boot-path clarification
- `POSProvider` initializes its React state synchronously from `loadState()` (localStorage or `buildSeed()`). If IndexedDB is not available, `ready` starts as true and the boot effect returns after `setReady(true)`; it does not block the POS tree.
- If IndexedDB is available but `idbLoadState()` returns null after an open/read error, the boot effect falls back to localStorage or seed and attempts `idbSaveState(local)` without checking the boolean result.
- The debounced `persistState()` later emits `nexfix:storage-error` on a failed durable write, but the listener is mounted inside `POS.tsx`, not as a global write gate. This warning is not equivalent to preventing unsafe writes or disabling the checkout action.
- No fix is included here because a safe change needs a provider-level storage status, a clearly defined read-only/degraded mode, and tests covering first-run empty database, legacy migration, IndexedDB unavailable, IndexedDB open failure, failed initial seed save, and failed later writes. A simplistic `ready=false` or seed removal could lock out existing shops or cause data-loss confusion.
