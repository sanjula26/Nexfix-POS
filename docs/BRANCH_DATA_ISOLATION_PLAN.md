# Branch Data Isolation — Security Design and Rollout Plan

**Status:** Design/audit only; no schema or production data changes.  
**Reviewed:** 2026-11-17  
**Tracking issue:** https://github.com/sanjula26/Nexfix-POS/issues/259

## 1. User-visible requirement

A person working at Branch A should see and operate on Branch A's operational records only. They must not gain access to Branch B by changing a URL, query filter, branch ID, local storage value, or RPC argument. An explicitly authorized shop owner/admin may have an all-branches view. Branch restrictions must be enforced in Supabase, not just by hiding controls.

## 2. Current architecture confirmed in source

- Shop membership is Supabase Auth (auth.uid() + active shop_memberships); local POS users, roles, passwords and cashier sessions are separate IndexedDB records.
- Branches are rows in public.branches; branch quantities are in public.branch_stock.
- A terminal is bound to a branch by public.pos_device_branches and set_pos_device_branch().
- Branch IDs are already attached to sales, expenses, day sessions, purchases/GRNs and inventory units. Transfers have from/to branch IDs. Repairs have no durable branch column in the reviewed model.
- The POS cloud snapshot is one revisioned row per shop. sanitizeCloudSnapshotState() strips local users, local sessions, the device-local branch selection and admin PIN hash, but otherwise copies the POS state. downloadStateSnapshot() selects the whole shop snapshot.
- Existing SELECT RLS policies reviewed for branches, branch_stock, pos_device_branches, stock_transfers, stock_transfer_lines, and branch_stock_adjustments use private.is_shop_member(shop_id). This is shop isolation, not branch isolation. Similar shop-scoped reads exist on normalized operational tables. UI filters cannot replace RLS.
- Device binding protects several write RPCs, but does not by itself restrict direct SELECT queries.
- A single cloud identity can be used on multiple terminals. Since Supabase RLS sees auth.uid(), not a trustworthy terminal identity from the renderer, a device row alone is insufficient to express "this authenticated person is only Branch A" when the same cloud account owns multiple device bindings.

## 3. Approved data classification baseline (2026-11-21; remaining rows still require owner decisions)

| Data | Proposed visibility | Reason / caution |
|---|---|---|
| Product catalogue (name, SKU, category, barcode, descriptions) | Shop-wide read | Shared catalogue avoids duplicate products; branch stock is separate |
| Branch stock and stock adjustment history | Assigned branch only | Core branch-private operational data |
| IMEI/serial inventory units | Assigned branch only | Unit ownership and saleability are branch-bound |
| Sales, sale items, sale payments, returns/reversals | Assigned branch only | Contains branch revenue, customer and tender history |
| Purchases/GRNs, purchase items/returns | Assigned branch only | Supplier cost and receipt history are operationally private |
| Expenses and day sessions/cashier balances | Assigned branch only | Branch cash and expense privacy |
| Repairs, repair parts, warranty claims | Assigned branch only after adding reliable branch attribution | Existing repair records need a safe historical backfill rule |
| Stock transfers | Source/destination branch participants; owner/admin all | Do not expose unrelated branches' transfer documents |
| Customer contact profiles and customer master data | Owner/Admin shop-wide; branch staff only explicitly branch-linked profiles | `customers` has no branch key and currently exposes shop-wide contact data; use a branch-safe projection, not direct shop-member reads |
| Suppliers and supplier balances | Decision required; currently shop-level in parts of the model | Suppliers may serve multiple branches |
| Quotations, kits, promotions, price lists | Decision required | May be shared commercial master data or branch-owned work |
| Shop settings, users, audit log, backup/restore | Owner/admin only unless narrowly delegated | High-impact or sensitive shop-level information |
| Owner Web consolidated reports | Owner/admin only | Branch users receive assigned-branch views only |

The owner approved a branch-private customer/credit model on 2026-11-21: Owner/Admin may see all customer contact profiles, invoices, settlements and the shop-wide credit balance. Branch staff may see only customer contact profiles explicitly linked to their assigned branch(es), invoices belonging to those branch(es), and the outstanding/settlement details for those invoices. They must not see another branch's customer contact profile, invoice history, settlement history, or the global `customers.credit_balance`. A branch user's FIFO settlement is restricted to invoices in their authorized branch set; only Owner/Admin may allocate across all branches. Do not expose a global customer balance as a shortcut.

This approved policy is not yet implemented. The `customers` table has no `branch_id`; a customer may have sales in several branches. The current `CustomerCreditPayment` ledger is embedded in the shop-wide POS state snapshot (with a collection `branchId` and invoice allocations), not stored as a normalized branch-secure settlement ledger. Design a canonical customer identity plus explicit customer-to-branch visibility relation/projection, and a normalized or equivalently secure invoice-allocation ledger. Avoid duplicating customers or corrupting existing balances. Keep the current shop-wide customer RPC and direct customer-table access Owner/Admin-only until branch-safe RPCs and snapshot replacement are proven. Existing invoice `customer_name` is a denormalized snapshot on each sale; branch-scoped invoice access may show that invoice's own customer label, but must not expose other-branch customer records.

## 4. Identity and authorization model

Recommended target:
- Keep shop_memberships as the tenant boundary.
- Add explicit branch grants for cloud identities (for example a shop-member-to-branch assignment relation) with a clear all-branches privilege for owner/admin.
- Require active membership, active branch, explicit branch grant and—where applicable—registered device-to-branch binding for branch operations.
- Keep local POS role checks for local screens and actions, but never treat local role labels as Supabase identity or as an RLS authorization claim.
- Decide whether each terminal has its own cloud identity. If the same owner cloud account is signed in on every branch terminal, RLS will regard those terminals as the same user. Either intentionally grant that identity all assigned branches or move branch-level access to distinct cloud identities / a signed server-verifiable device authorization design. Never trust a raw renderer-supplied device_id as the sole read authorization credential.
- Admin/owner cross-branch access must be explicit and audited. Managers may access only branch(es) explicitly assigned to them; the Manager role itself never grants cross-branch access. Additional branches require an explicit assignment by Owner/Admin.

## 5. Database enforcement

- Introduce a narrowly scoped helper such as private.can_access_shop_branch(shop_id, branch_id), SECURITY DEFINER with an empty fixed search_path, strict auth.uid(), active shop membership, active branch and explicit grant checks.
- Replace shop-only SELECT policies on branch-owned rows with branch-aware predicates. For child tables, authorize through the parent sale/purchase/repair/transfer row rather than trusting a client-provided shop ID.
- For transfers, require access to either endpoint for branch staff; only owner/admin sees all transfer records.
- Every mutation RPC must verify the requested branch against the caller's grant and the registered device binding. Validate related parent IDs belong to that same branch.
- Do not create broad permissive policies alongside existing policies: PostgreSQL permissive policies combine with OR. Drop/replace old policies in the same migration and test the effective policy set.
- Keep all SECURITY DEFINER functions on empty search_path, schema-qualify objects, revoke PUBLIC/anon, grant only the intended role, and test negative paths.

## 6. Snapshot and offline sync (critical dependency)

The current one-row-per-shop snapshot is incompatible with branch-private operational data if branch users can download it. Do not simply add a branch filter to the UI.

Safe rollout choices to evaluate:
1. Keep the full shop snapshot owner/admin-only and stop using it as a data-distribution path for branch staff; use normalized branch-scoped rows and narrow atomic RPCs for operational synchronization.
2. Or design versioned branch snapshots with (shop_id, branch_id) isolation and a separate, explicitly shared catalogue/master-data channel. Define merge rules before implementation; do not merge full state arrays by last-write-wins.

In either design:
- Snapshot writes remain admin-only; do not grant cashier access to upsert_pos_snapshot.
- Partition IndexedDB branch caches and offline queue metadata by shop + branch.
- A branch/account switch must not render stale cached rows from the previous branch.
- A queued operation must retain its original shop/branch/idempotency key and be rejected if current authorization no longer matches; never silently replay it under another branch.
- Conflict handling must preserve pending operations and make the failure visible.
- Backups remain shop-scoped and admin-only by default. Restore must verify shop identity and must not import another branch's operational state into a branch-only cache.

## 7. UI behavior

- Branch staff should see one assigned branch name as a read-only current-branch label, not a dropdown exposing every branch.
- Admin/owner may switch among authorized branches and choose "All branches" where reporting supports it.
- Manager branch selector shows only granted branches.
- Branch assignment management is admin/owner-only, requires online cloud authorization and records an audit event.
- If the terminal has no valid assignment, branch-sensitive screens and writes fail closed with a clear instruction to contact the owner; do not fall back to Main or trust a stale localStorage branch ID.
- Display branch name/code in POS, Inventory, GRN, Repairs, Day End, Sales history, reports, CSV/PDF exports and printouts where branch scope matters.

## 8. Rollout phases and gates

### Phase A — Inventory and tests
- Enumerate every table, view, RPC and client query that contains or returns branch-owned data.
- Capture current production policy/function definitions read-only and reconcile migration drift.
- Add policy/RPC test fixtures for Branch A, Branch B, owner/admin, manager, cashier and unauthenticated callers.
- No production writes.

### Phase B — Authorization schema and RLS
- Agree on identity model and shared-vs-private data matrix.
- Add branch grant relation and helper in an additive migration.
- Replace branch SELECT policies and tighten mutation RPCs.
- Test direct PostgREST access with real authenticated JWTs and SQL role tests.
- Deploy only to isolated staging first.

### Phase C — Snapshot and offline separation
- Prevent branch staff from reading shop-wide snapshots.
- Implement normalized/branch-scoped synchronization or branch snapshots with tested merge semantics.
- Partition local caches and offline queues.
- Test offline branch switching, stale queues, conflict/retry, restore and restart.

### Phase D — UI and reporting
- Hide all-branch selectors from branch users.
- Render only authorized branch options.
- Apply branch scope to every list, detail view, report, CSV/PDF export and printout.
- Preserve owner/admin consolidated reporting.

### Phase E — production release gate
- Backfill repairs and any branch-ambiguous historical rows using an explicit approved rule.
- Verify all branch-negative tests against staging.
- Confirm rollback plan and migration order.
- Owner approval required before production schema/policy migration.

## 9. Acceptance test matrix

- Branch A cannot read Branch B rows through direct table queries even when it supplies Branch B's UUID.
- Branch A cannot read Branch B sale items/payments by guessing a sale ID.
- Branch A cannot read Branch B GRN/purchase items, expenses, day sessions, units, stock adjustments, repair history or unrelated transfers.
- Branch A cannot mutate Branch B through every RPC, including legacy RPC overloads.
- Branch A's branch list and device assignment APIs reveal only granted branches.
- Owner/admin can view all authorized branches; a normal manager/cashier cannot.
- Same cloud user on two terminals follows the chosen identity policy and cannot accidentally inherit wider scope.
- A revoked member/branch grant/device loses access immediately.
- Offline queues cannot replay to a different branch after reassignment or account switch.
- Full shop snapshot and backup/restore do not expose branch-private operational data to branch staff.
- Shared product/customer/supplier behavior follows the approved matrix.
- Existing single-branch shops remain backward compatible.

## 10. Explicit non-goals

- Do not change local POS login/passwords or merge them with Supabase Auth.
- Do not change updater device tokens or private R2 release flow.
- Do not weaken admin-only full-state snapshot writes.
- Do not migrate production data or alter production RLS until staging tests and owner approval pass.
- Do not change Google Drive shop partitioning as part of the first branch-isolation migration.


## 11. Production and staging read-only verification (2026-11-17)

### Production project

Read-only Supabase inspection of the configured production project confirmed:
- 1 shop, 2 active branches, 6 non-revoked devices, 3 device-to-branch binding rows.
- The 3 binding rows cover only 1 of the 2 active branches at the time of inspection.
- 1 active cloud shop membership exists (role admin); all 6 active devices resolve to 1 distinct cloud Auth user. Therefore device binding cannot distinguish branch access at RLS level while the same cloud identity is shared across terminals.
- 35 normalized sales rows exist. No purchase, repair or warranty rows were returned by the aggregate count. The POS snapshot table currently has 0 rows, so the snapshot policy is a latent exposure path, not evidence that a snapshot was downloaded in this inspection.
- Read-only pg_policies inspection confirmed SELECT policies for branches, branch_stock, pos_device_branches, stock_transfers, stock_transfer_lines, branch_stock_adjustments, sales, day_sessions, expenses, inventory_units, purchases, repairs, warranty_claims and child sale/purchase/repair records are based on shop membership, not branch grants.
- The production pos_state_snapshots SELECT policy is named pos_state_snapshots_select_member and checks legacy pos_shop_members membership. Snapshot writes remain separately hardened; do not weaken or re-open them.

### Staging project

- Supabase project status currently reports ACTIVE_HEALTHY and database tools respond.
- The staging project is not yet a full NexFix schema deployment: migration history contains only three staging fixture/policy migrations (20261110131158, 20261110131205, 20261110131510), and the public schema inventory shows only the minimal POS cloud fixture tables. The production branch tables and operational tables are not present there.
- Therefore staging is reachable but not yet suitable for validating the complete branch-isolation migration. Do not apply production migrations or copy production data into staging as an automatic shortcut.

### Implication

The current production data confirms this is not a hypothetical multi-branch UI issue: there are two active branches and multiple devices, but all active devices use one cloud identity and the current RLS rules authorize at shop level. A safe solution must first decide how branch identities are represented. The most practical candidate is separate cloud identities or explicit member-to-branch grants for each branch terminal/user, with owner/admin all-branch access; however, if one cloud identity remains shared by every terminal, user-level grants alone will not isolate those terminals. The design must not rely on a renderer-supplied device_id as a read security credential.


## 12. Owner Web reporting RPC authorization gap — production (read-only, 2026-11-17)

Deployed function definitions and execute grants were inspected read-only:
- public.get_owner_branch_daily_sales(shop_id, from, to, branch_id DEFAULT NULL) is executable by authenticated, not anon. It checks only active shop_memberships and accepts any active branch in the shop; NULL returns all branch totals.
- public.get_owner_branch_stock_valuation(shop_id, branch_id DEFAULT NULL) is executable by authenticated, not anon. It checks only active shop membership and accepts any branch or NULL for all branches. Its result includes stock quantities, unit cost, selling value and potential profit.
- public.get_owner_credit_customers(shop_id) is executable by authenticated, not anon and checks only active shop membership; it returns shop-wide customer credit balances and open-invoice balances.

These functions use an empty search_path and authenticated-only execute grants, which are positive controls, but their authorization scope is shop-wide rather than branch/owner-only. The UI branch selector is not a security boundary. The isolation rollout must add explicit owner/admin authorization for all-branch and financial reports, and branch grant checks for branch-specific reports. No function, grant, data or schema was changed during this inspection.
