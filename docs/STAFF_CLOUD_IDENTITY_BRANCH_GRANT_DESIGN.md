# Staff Cloud Identity and Branch Grant Design

Status: documentation-only proposal; not an approved schema or rollout.
Date: 2026-11-21
Related work:
- [Branch Data Isolation Implementation Plan](./BRANCH_DATA_ISOLATION_IMPLEMENTATION_PLAN.md)
- [PR #282 — Staff Auth callback foundation](https://github.com/sanjula26/Nexfix-POS/pull/282)
- [Issue #259 — Branch data isolation](https://github.com/sanjula26/Nexfix-POS/issues/259)

## 1. Purpose and hard safety boundary

Define how an individually authenticated staff member receives access to one or more assigned branches, how a POS device further narrows that access, and how revocation is enforced.

This document is a design proposal only. It does not create tables, migrations, policies, functions, Auth users, grants, or production settings. It does not authorize operational Staff data access. A successful Staff Supabase Auth session from PR #282 is identity proof only; it is not a shop membership, branch grant, device authorization, or permission to read POS data.

The first implementation must run against a complete disposable Supabase project created from the repository migrations, with synthetic data only. Do not use production or a partial fixture for branch-isolation acceptance tests.

## 2. Identity model — keep the four identities separate

| Identity / record | Meaning | Must not be treated as |
|---|---|---|
| Local POS user | Employee profile and local role used for offline/local POS login | Supabase Auth identity |
| Supabase Auth user | Individually authenticated cloud principal (auth.uid()) | A local cashier/admin ID |
| Shop membership | The cloud user's membership and shop-level role for one shop | A branch grant |
| Registered POS device | A specific installed device with its own registration/revocation state | Proof that its user may access that branch |

A local employee record may be linked to a cloud membership only through an explicit, audited mapping. Do not match users by display name, phone number, or email string at runtime. Email is a login/delivery attribute, not the authorization key.

**Individual accountability requirement:** each staff member who needs cloud access must use a distinct provisioned Supabase Auth identity. A shared cloud login remains one principal and cannot provide per-employee attribution, even if two devices are bound to different branches.

## 3. Proposed authorization model

For a normal branch-scoped staff request, the server must prove all of the following:

1. A valid authenticated request exists and auth.uid() is non-null.
2. The user has exactly one applicable active membership for the requested shop (or the request is rejected as ambiguous).
3. The membership is active and its role is allowed for the requested operation.
4. The membership has an active explicit grant for the target branch.
5. The registered device belongs to the same authenticated cloud user and shop, is active/not revoked, and is assigned to that same branch.
6. The branch is active and belongs to the same shop.
7. For child records, the parent row belongs to that same authorized shop and branch.
8. The requested operation is permitted for the role; branch scope alone does not grant every action.

Effective branch access is the intersection of active member grants and the current device's active branch binding. A device binding can only narrow access; it must never create or widen a member grant. A caller-supplied branch ID, role, device ID, local user ID, or UI selection is untrusted until independently verified against server records.

### Role policy proposal

| Cloud membership role | Proposed branch scope | Important restriction |
|---|---|---|
| admin | All active branches in its own shop | Explicit server-side all-branch privilege; never infer from a UI role or the existing private.is_shop_admin helper |
| manager | Explicitly assigned branch(es) only | No implicit all-branch access; cross-branch transfer requires a separate explicit privileged workflow |
| cashier | Explicitly assigned branch(es) only | Sales, sessions and returns must be branch-checked server-side |
| technician | Explicitly assigned branch(es) only | Repair access remains blocked until repairs have reliable branch provenance |
| inventory_manager | Explicitly assigned branch(es) only | Stock/IMEI/GRN and supplier-cost access must be separately permissioned |

The existing private.is_shop_admin(shop_id) helper includes both admin and manager; it is not safe as the all-branch predicate. The eventual implementation needs a separately named, narrowly defined helper (for example, private.is_shop_owner_admin(shop_id)) that checks the active membership and the explicitly approved all-branch role. Never broaden that helper to include manager.

The profiles.role constraint and shop_memberships.role are separate existing role sources. Do not silently change or merge them. The proposed inventory_manager cloud role needs a compatibility decision for profile/local role mapping before UI enablement.

## 4. Proposed membership-to-branch grant record

The following is a logical design, not executable migration SQL. Exact foreign-key columns and existing primary keys must be verified against the complete target schema before implementation.

Proposed relation: shop_membership_branch_grants

| Field | Purpose / constraint |
|---|---|
| id | Stable primary key |
| shop_id | Tenant key; must match both membership and branch |
| shop_membership_id | FK to the active membership record; do not store a second independently editable user ID |
| branch_id | FK to a branch in the same shop |
| granted_at, granted_by | Server-generated grant audit metadata |
| revoked_at, revoked_by | Nullable revocation audit metadata |
| created_at, updated_at | Server-managed timestamps |

Required integrity rules:
- A composite FK or equivalent database constraint must ensure the membership and branch belong to the same shop; never rely only on a client check.
- At most one current active grant exists for a membership/branch pair. Historical grant rows should be retained; re-grant must not erase the previous revoke history.
- Only the explicit shop Owner/Admin server privilege may grant or revoke another member's branch assignments.
- Clients must not write grant rows directly. Use a narrow server-side RPC that derives the actor from auth.uid(), validates the actor's membership and target membership, and writes audit metadata server-side.
- Grant/revoke RPCs must reject inactive memberships, inactive branches, cross-shop IDs, self-escalation, and attempts by Manager/Cashier/Technician/Inventory Manager to alter grants.
- RLS must deny direct client writes to this relation. Reads should expose only the minimum assignment information needed by the current member and Owner/Admin; do not reveal unrelated staff details.
- The grant table is authorization data, not a UI preference or device setting.

Before coding, confirm whether membership IDs are stable and unique per shop and inspect existing FK/unique constraints. If not, adapt the logical key without weakening tenant integrity.

## 5. Device assignment and multi-device semantics

- Keep pos_device_branches as device-to-branch binding; do not repurpose it as staff-to-branch authorization.
- A device must be registered, active, not revoked, and bound to the same authenticated cloud user making the request.
- For a normal staff session, the device's branch must also have an active grant for that membership.
- One staff member may have grants to several branches, but each device is restricted to its own assigned branch. Moving a device to another branch requires Owner/Admin authorization and must invalidate the old branch's cached authorization.
- If the same cloud identity is signed in on two devices, each request is restricted by that request's registered device binding. This does not make the identity individually attributable to two different employees; distinct cloud identities remain required for staff accountability.
- Missing, duplicate, stale, or conflicting active device bindings fail closed. Do not silently choose the first row.
- Single-branch shops must follow the same explicit identity and branch checks; a single active branch is not a reason to bypass member grants.

## 6. Provisioning, assignment and revocation lifecycle

### Provision staff
1. Owner/Admin creates or invites the staff Auth identity through a controlled provisioning path; self-signup remains disabled.
2. The staff member completes the Staff-only PKCE email link flow using the isolated Staff Supabase client.
3. Owner/Admin creates/activates the correct shop membership and maps it to the local employee record using stable IDs.
4. Owner/Admin assigns one or more active branches through the audited grant RPC.
5. The device is registered to the staff cloud identity and assigned to one of that member's granted branches.
6. Only after all server-side checks and tests pass may the app enable operational Staff cloud sync.

### Change branch assignment
1. Owner/Admin revokes the old branch grant and grants the new branch using server-side transactions.
2. The device binding is changed through its own authorized operation; member grant and device assignment must agree before access resumes.
3. Old in-memory views and branch caches are cleared/quarantined; local offline records are not deleted.
4. Any queued operation retains its original actor, shop, branch, device and idempotency metadata. It is not rewritten to the new branch.

### Revoke access
- Revoke the member grant and/or membership and/or device independently; each is a separate authorization control.
- Server authorization must reflect revocation on the next request. Do not depend on JWT role claims or client cache expiry for revocation.
- On next sync/heartbeat, the client clears cloud-authorized views and stops cloud mutations. Preserve local POS data for Owner/Admin recovery; do not auto-delete sales or local records.
- Queued writes from a revoked member/device are rejected or quarantined for Owner/Admin review. Never replay them under another user or device.
- Re-grant is a new auditable event, not an undo that removes the prior revocation history.

## 7. Server enforcement and migration ordering

1. Inventory every table, view, RPC, trigger, edge function, snapshot, Owner Web report, sync path and offline queue mutation that reads or writes branch-owned data.
2. Decide shared-data rules (Section 9) before exposing those datasets to staff.
3. Build the full disposable staging schema from repository migrations and seed synthetic Shop A with Branch A and Branch B.
4. Implement and test membership/branch grant integrity and narrowly scoped authorization helpers first.
5. Replace existing broad shop-member SELECT policies on branch-owned data. Do not add a new permissive policy beside a broad old policy: PostgreSQL permissive policies combine with OR.
6. Apply separate SELECT/INSERT/UPDATE/DELETE policies with both USING and WITH CHECK; authorize child rows through their parent branch.
7. Review all SECURITY DEFINER functions, RPC execute grants, views, snapshot endpoints and Owner Web aggregates. Verify fixed search_path, fully qualified references, minimal privileges and safe function ownership.
8. Add member-grant checks to device-bound sale, GRN, stock, unit, return, reversal, trade-in, repair and transfer paths. A valid device binding alone is insufficient.
9. Add client branch partitioning and stale-cache clearing only after the server boundary is proven. UI filters are not security.
10. Test offline replay, reassignment, revocation, backup/restore and rollback before production approval.
11. Prepare a reversible migration and monitoring plan. Obtain separate explicit Owner approval before any production schema/RLS/grant/data change.

Keep full-shop pos_state_snapshots and Google Drive backup/restore admin-only until a branch-safe protocol is independently designed and tested.

## 8. Required synthetic staging fixture

Use a disposable project with the complete current migration history and no real customer or business data.

| Fixture identity | Role | Grants | Device binding |
|---|---|---|---|
| OwnerAdmin | admin | All branches via explicit privilege | One device on A; optionally another on B |
| ManagerA | manager | A only | Device A |
| CashierA | cashier | A only | Device A2 |
| TechnicianB | technician | B only | Device B |
| InventoryA | inventory_manager | A only | Device A3 |
| Unassigned | cashier | None | Registered device A |
| RevokedA | cashier | Historical A grant, revoked | Device A |
| WrongShop | Active member of Shop B only | Shop B branch | Shop B device |
| NoDevice | cashier | A only | No registered device |
| RevokedDevice | cashier | A only | Device revoked |
| ReassignedDevice | cashier | A only | Device now bound to B |

Create synthetic Branch A and Branch B records for every branch-owned parent and child table, including sales/items/payments, purchases/items, sessions, expenses, stock, stock adjustments, inventory units, transfers/lines, returns, reversals, trade-ins and relevant audit records. Include missing-branch legacy repair/customer/warranty/quotation fixtures to prove they remain owner-only.

## 9. Product decisions required before staff rollout

These are not safe to decide by implementation assumption:

| Dataset / capability | Safe default until decision | Decision needed |
|---|---|---|
| Customer directory, phone/email | Owner/Admin only | Shared shop-wide, assigned-branch, or owner-only? |
| Credit balances, statements, FIFO settlements | Owner/Admin only | Is credit shared across branches or partitioned by originating sale/branch? |
| Quotations | Owner/Admin only | Which branch owns a quote, and can another branch convert it? |
| Repairs and repair history | Owner/Admin only while branchless | How is origin branch established for new and historical records? |
| Warranty claims/history | Owner/Admin only while branchless | Which branch owns a claim and who can service it? |
| Supplier directory | Shop-wide only if contact identity is approved as shared | Should supplier identity be shared while prices/terms are branch-private? |
| Product catalogue cost/margin | Owner/Admin only for cost and margin | Which roles may view cost, purchase price and profit? |
| Stock transfers | Owner/Admin only initially | Should a Manager be allowed to initiate/approve transfers between two explicitly assigned branches? |
| Full-shop snapshots and Drive backup | Owner/Admin only | No branch-staff access until a branch-safe format exists |

Do not silently convert shop-wide credit into branch balances or move historical transactions. Do not infer a missing branch from the currently selected branch or current device.

## 10. Acceptance tests — all must pass before enabling staff operations

### Identity and grant checks
- No session, invalid session, wrong shop, no membership, inactive membership and ambiguous membership are denied.
- A user with no branch grant cannot read or mutate branch records even when the device is bound to that branch.
- A user granted A cannot access B by changing URL/query filters, UUIDs, joins, embedded relations, view names or RPC arguments.
- Manager with A grant cannot request NULL/all-branch reporting or B data.
- Admin can access all branches in its own shop; Admin cannot access another shop.
- private.is_shop_admin is not used as the all-branch predicate.
- Revoked member, revoked grant, inactive branch and revoked device are denied on the next server request.

### Device intersection checks
- Member grant A + device A succeeds for allowed actions.
- Member grant A + device B is denied.
- Member grants A+B + device A sees only A; same identity on device B sees only B.
- Missing, duplicate or mismatched device binding fails closed.
- Device reassignment does not widen the member grant or reattribute pending offline writes.

### Parent/child and mutation checks
- Branch A cannot read Branch B sale items/payments by supplying a child ID.
- Branch A cannot read Branch B purchase items, repair parts or transfer lines through direct table queries.
- Branch A cannot insert, update, delete or move a record into B by forging shop_id, branch_id, parent ID or device ID.
- Return, reversal, trade-in, GRN, stock, IMEI/unit and transfer RPCs verify both actor grant and device binding against the parent/source/destination branch.
- A cross-branch transfer fails atomically; no partial stock or serial-number movement occurs.

### Offline, snapshots and reports
- Queue created on A then replayed after device reassignment to B is rejected/quarantined, not rerouted.
- Queue created by a revoked member/device cannot replay under a new identity.
- Cached A data is not rendered as cloud-authorized after logout, branch switch, revocation or identity change.
- Branch-only staff cannot read or publish a shop-wide snapshot or restore a full-shop Drive backup.
- Owner Web NULL/all-branch reports, credit RPCs and cost/profit valuation are denied to branch-only users unless an explicit approved policy says otherwise.
- Direct authenticated PostgREST and RPC calls are tested; passing UI tests alone is insufficient.

### Rollback and recovery
- Failed migration/partial deployment has a rehearsed rollback that restores previous application compatibility without deleting records.
- Existing local POS login and offline operation remain available if cloud authorization is unavailable, but no unverified cloud data is displayed or mutated.
- Restore and backup tests prove shop identity and branch provenance before applying data.

## 11. Release gates and current status

| Gate | Current status |
|---|---|
| Separate Staff Auth client/callback foundation (PR #282) | CI green; PR remains Draft; sign-in UI, hosted redirect allowlist and physical Windows flow still unverified |
| Membership-to-branch grant schema | Proposed only; not implemented or approved |
| Full staging schema and synthetic A/B fixture | Not yet available/verified |
| Branch RLS and RPC enforcement | Not implemented end-to-end; production remains shop-member scoped in audited paths |
| Offline cache/queue branch isolation | Open |
| Customer/credit/supplier/quotation/repair/warranty policy | Owner decisions required |
| Direct PostgREST/RPC negative tests | Not run |
| Production migration approval | Not granted; no production changes authorized |

**Do not merge this design as proof of security. Do not enable operational Staff access or deploy a production migration until every required gate has evidence and the owner separately approves the production change.**
