# Local-only two-tab stock editor regression (Windows)

This is the safe single-PC alternative to a physical two-PC stock race test. It exercises the real Inventory React UI and the real compare-and-set RPC against a disposable local Supabase database. Two browser tabs represent two independently opened editors; they are **not** two physical Windows devices.

## Safety rules

- Use only the local Supabase URL `http://127.0.0.1:54321` and its local anon key.
- Never paste a production Supabase URL/key into this procedure.
- Do not run `scripts/build-windows-test.ps1` for this test. That helper deliberately targets the live NexFix Supabase project.
- Do not use real customer, supplier, sales, GRN, repair, backup, or inventory records.
- Do not run `supabase db reset` if the local Supabase database contains work you need to keep. This guide does not require a reset.
- The test creates one synthetic local Auth user, one synthetic shop, one active branch and one clearly named QA product. Keep the local stack isolated from production.

## Prerequisites

- Windows PowerShell
- Node.js 22
- Docker Desktop running
- Supabase CLI available through `npx supabase`
- Repository checked out at the PR #283 branch

## 1. Start the local Supabase stack

From the repository root:

```powershell
npx supabase start
npx supabase status -o env
```

Confirm the reported API URL is `http://127.0.0.1:54321` (or localhost on port 54321). Open local Supabase Studio at `http://127.0.0.1:54323`.

If Docker or Supabase fails to start, stop here. Do not switch the test to the hosted production project.

## 2. Create a synthetic local Auth user

In local Supabase Studio:

1. Open **Authentication → Users**.
2. Add a new user with a unique test-only email, for example `stock-qa-20261121@example.invalid`.
3. Set a temporary test password and mark the email confirmed.
4. Copy the generated user UUID. Keep the password only in your local test session; do not commit it or save it to Notion.

## 3. Provision one isolated shop and one active branch

In local Studio **SQL Editor**, replace the test email below with the email created in step 2, then run this SQL. The IDs are reserved for this local QA fixture only.

```sql
DO $qa$
DECLARE
  v_user_id uuid;
  v_email text := lower('stock-qa-20261121@example.invalid');
  v_shop_id uuid := 'b2000000-0000-4000-8000-000000000001';
  v_branch_id uuid := 'b3000000-0000-4000-8000-000000000001';
BEGIN
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE lower(email) = v_email
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Create the synthetic local Auth user before running this fixture';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (v_user_id, v_email, 'Local Stock QA', 'admin')
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, role = EXCLUDED.role;

  INSERT INTO public.shops (id, name)
  VALUES (v_shop_id, 'NexFix Local Stock QA')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shop_memberships (user_id, shop_id, role, active)
  VALUES (v_user_id, v_shop_id, 'admin', true);

  INSERT INTO public.branches (id, shop_id, name, code, active, is_default)
  VALUES (v_branch_id, v_shop_id, 'Local QA Main', 'LOCAL-QA', true, true)
  ON CONFLICT (id) DO NOTHING;
END
$qa$;
```

This fixture intentionally has exactly one active branch. The stock RPC permits the single-branch path without creating a multi-branch device assignment. It does not weaken or bypass the stock compare-and-set check.

## 4. Run the renderer against local Supabase only

Open a new PowerShell window at the repository root. Read the local `ANON_KEY` from `npx supabase status -o env` and set it in this PowerShell session:

```powershell
$env:VITE_SUPABASE_URL = 'http://127.0.0.1:54321'
$env:VITE_SUPABASE_ANON_KEY = '<paste the LOCAL anon key here>'
$env:VITE_PUBLIC_APP_URL = 'http://127.0.0.1:5173/'
$env:VITE_SEED_DEMO = 'false'
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/` in Chrome. Use the first-run flow to create a local POS administrator; this local POS password is separate from the synthetic Supabase Auth password. In Settings, sign in to the synthetic local Supabase Auth account created above.

The local account must have the active shop membership from step 3. If the POS reports that the shop is not provisioned, stop and check the local fixture; do not use a hosted account as a workaround.

## 5. Run the stale-editor UI check in two tabs

1. In the first tab, create one ordinary non-IMEI/non-serial product named `LOCAL-QA-STOCK-ONLY`, with an initial stock quantity of 10.
2. Wait for the local cloud catalog sync to finish. Confirm the product appears in the local cloud shop and has branch stock 10 before continuing.
3. Duplicate the app URL into a second Chrome tab in the same browser profile. The tabs intentionally share the synthetic local POS session and local IndexedDB, but each has its own live React editor state.
4. In both tabs, open the Inventory page and open the same product editor while the branch quantity is 10. Leave both editors open.
5. In tab A, change stock from 10 to 12 and save. Confirm it succeeds.
6. In tab B, attempt to save a different quantity using the still-open editor. It must be rejected as a stale stock baseline; the open editor must stop allowing another stock save until it is closed and reopened.
7. Close and reopen the editor in tab B. Confirm it loads the current branch quantity of 12. Do not perform sales, GRNs, returns or other stock mutations during this test.

Expected outcome: tab A commits once; tab B receives the stale-quantity conflict and cannot repeatedly submit the old baseline. Reopening tab B loads 12.

## 6. Verify only the synthetic local fixture changed

In local Studio SQL Editor, run:

```sql
SELECT p.name, p.stock AS product_stock, bs.qty AS branch_stock
FROM public.products p
JOIN public.branches b
  ON b.shop_id = p.shop_id AND b.is_default = true AND b.active = true
JOIN public.branch_stock bs
  ON bs.shop_id = p.shop_id
 AND bs.branch_id = b.id
 AND bs.product_id = p.id
WHERE p.shop_id = 'b2000000-0000-4000-8000-000000000001'
  AND p.name = 'LOCAL-QA-STOCK-ONLY';

SELECT count(*) AS successful_adjustments
FROM public.branch_stock_adjustments
WHERE shop_id = 'b2000000-0000-4000-8000-000000000001'
  AND product_id = (
    SELECT id FROM public.products
    WHERE shop_id = 'b2000000-0000-4000-8000-000000000001'
      AND name = 'LOCAL-QA-STOCK-ONLY'
    LIMIT 1
  );
```

Expected after the two-tab stale-save check: product stock 12, branch stock 12, and exactly one successful adjustment. A rejected stale save must not create an adjustment or audit record.

## What this test does not prove

- It is a two-tab browser UI test, not two physical PCs.
- It does not test Electron's encrypted Windows Auth storage, updater, device registration, multi-branch device assignment, offline queue replay, or Google Drive backup/restore.
- It does not replace the separate Windows installer/portable packaging and Electron security CI checks.
- If any expected behavior differs, capture the visible error and local SQL result; do not retry the stock operation repeatedly.

## Stop the local test

Stop the Vite dev server with Ctrl+C. When finished with the local-only QA stack, run:

```powershell
npx supabase stop
```

No R2 upload, hosted Supabase write, public release, or production inventory change is part of this procedure.
