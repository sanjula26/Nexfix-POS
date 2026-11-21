#!/usr/bin/env bash
# Deterministic two-session compare-and-set race test.
# Runs only against the disposable local Supabase database started by CI.
set -Eeuo pipefail

if [[ -z "${DB_URL:-}" ]]; then
  status_env="$(supabase status -o env)"
  DB_URL="$(printf '%s\n' "$status_env" | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
fi
if [[ -z "${DB_URL:-}" || "$DB_URL" != *"127.0.0.1:54322"* ]]; then
  echo "Refusing concurrency test: DB_URL is not the local Supabase database." >&2
  exit 2
fi
command -v psql >/dev/null 2>&1 || {
  echo "psql is required for the two-session concurrency test." >&2
  exit 2
}

shop_id="b2000000-0000-4000-8000-000000000001"
user_id="b1000000-0000-4000-8000-000000000001"
branch_id="b3000000-0000-4000-8000-000000000001"
product_id="b4000000-0000-4000-8000-000000000001"
adjustment_a="b5000000-0000-4000-8000-000000000001"
adjustment_b="b5000000-0000-4000-8000-000000000002"
app_a="nexfix-stock-cas-a"
app_b="nexfix-stock-cas-b"
tmp_dir="$(mktemp -d)"
pid_a=""
pid_b=""

db() { psql "$DB_URL" -X -v ON_ERROR_STOP=1 "$@"; }
cleanup() {
  set +e
  [[ -n "$pid_a" ]] && kill "$pid_a" 2>/dev/null
  [[ -n "$pid_b" ]] && kill "$pid_b" 2>/dev/null
  [[ -n "$pid_a" ]] && wait "$pid_a" 2>/dev/null
  [[ -n "$pid_b" ]] && wait "$pid_b" 2>/dev/null
  db -c "DROP TRIGGER IF EXISTS nexfix_cas_test_pause ON public.branch_stock;
         DROP FUNCTION IF EXISTS public.nexfix_cas_test_pause();
         DELETE FROM public.audit_log WHERE shop_id='$shop_id';
         DELETE FROM public.shops WHERE id='$shop_id';
         DELETE FROM auth.users WHERE id='$user_id';" >/dev/null 2>&1
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

# Create committed synthetic fixtures so both independent sessions can see them.
db <<SQL
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '$user_id', 'authenticated', 'authenticated',
  'stock-cas-concurrency@example.invalid', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Stock CAS Concurrency"}'::jsonb, now(), now()
);
INSERT INTO public.profiles (id, email, full_name, role)
VALUES ('$user_id', 'stock-cas-concurrency@example.invalid', 'Stock CAS Concurrency', 'admin');
INSERT INTO public.shops (id, name) VALUES ('$shop_id', 'Stock CAS Concurrency Test Shop');
INSERT INTO public.shop_memberships (user_id, shop_id, role, active)
VALUES ('$user_id', '$shop_id', 'admin', true);
INSERT INTO public.branches (id, shop_id, name, code, active, is_default)
VALUES ('$branch_id', '$shop_id', 'CI Race Branch', 'CI-RACE', true, true);
INSERT INTO public.products (id, shop_id, name, cost, price, stock)
VALUES ('$product_id', '$shop_id', 'CAS Concurrency Fixture', 1, 2, 10);
INSERT INTO public.branch_stock (shop_id, branch_id, product_id, qty)
VALUES ('$shop_id', '$branch_id', '$product_id', 10)
ON CONFLICT (branch_id, product_id) DO UPDATE
SET qty = excluded.qty, updated_at = now();

CREATE OR REPLACE FUNCTION public.nexfix_cas_test_pause()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF NEW.shop_id = '$shop_id'::uuid
     AND NEW.branch_id = '$branch_id'::uuid
     AND NEW.product_id = '$product_id'::uuid
     AND NEW.qty IS DISTINCT FROM OLD.qty THEN
    PERFORM pg_sleep(3);
  END IF;
  RETURN NEW;
END;
\$function\$;

CREATE TRIGGER nexfix_cas_test_pause
BEFORE UPDATE ON public.branch_stock
FOR EACH ROW EXECUTE FUNCTION public.nexfix_cas_test_pause();
SQL

rpc_sql() {
  local adjustment_id="$1"
  local note="$2"
  printf "SELECT set_config('request.jwt.claim.sub','%s',false);\n" "$user_id"
  printf "SELECT set_config('request.jwt.claims','{\\"sub\\":\\"%s\\",\\"role\\":\\"authenticated\\"}',false);\n" "$user_id"
  printf "\\set VERBOSITY verbose\n"
  cat <<SQL
SELECT public.adjust_branch_stock_atomic_expected(
  '$shop_id', '$branch_id', 'ci-stock-device', '$product_id',
  2, '$note', '$adjustment_id', 10
);
SQL
}

PGAPPNAME="$app_a" psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f <(rpc_sql "$adjustment_a" "concurrent session A") >"$tmp_dir/a.out" 2>"$tmp_dir/a.err" &
pid_a=$!

# Wait until A is inside the test-only pause after it has acquired the stock locks.
a_paused=0
for _ in $(seq 1 100); do
  if db -Atqc "SELECT 1 FROM pg_stat_activity WHERE application_name='$app_a' AND wait_event='PgSleep'" | grep -q 1; then
    a_paused=1
    break
  fi
  sleep 0.1
done
if [[ "$a_paused" != 1 ]]; then
  echo "Session A did not reach the deterministic lock-hold point." >&2
  cat "$tmp_dir/a.err" >&2
  exit 1
fi

PGAPPNAME="$app_b" psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f <(rpc_sql "$adjustment_b" "concurrent session B") >"$tmp_dir/b.out" 2>"$tmp_dir/b.err" &
pid_b=$!

# Prove B is blocked on a database lock while A still owns the product row.
b_waiting=0
for _ in $(seq 1 100); do
  if db -Atqc "SELECT 1 FROM pg_stat_activity WHERE application_name='$app_b' AND wait_event_type='Lock'" | grep -q 1; then
    b_waiting=1
    break
  fi
  sleep 0.1
done
if [[ "$b_waiting" != 1 ]]; then
  echo "Session B was not observed waiting on A's stock lock." >&2
  cat "$tmp_dir/b.err" >&2
  exit 1
fi

set +e
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e
pid_a=""
pid_b=""

if [[ "$status_a" -ne 0 ]]; then
  echo "Session A should succeed, exit=$status_a" >&2
  cat "$tmp_dir/a.err" >&2
  exit 1
fi
if [[ "$status_b" -eq 0 ]] || ! grep -q '40001' "$tmp_dir/b.err"; then
  echo "Session B should fail with SQLSTATE 40001, exit=$status_b" >&2
  cat "$tmp_dir/b.err" >&2
  exit 1
fi

db <<SQL
DROP TRIGGER nexfix_cas_test_pause ON public.branch_stock;
DROP FUNCTION public.nexfix_cas_test_pause();
DO \$assert\$
DECLARE
  v_branch_qty numeric;
  v_product_stock numeric;
  v_adjustments integer;
  v_audit integer;
BEGIN
  SELECT qty INTO v_branch_qty FROM public.branch_stock
    WHERE shop_id='$shop_id' AND branch_id='$branch_id' AND product_id='$product_id';
  SELECT stock INTO v_product_stock FROM public.products
    WHERE shop_id='$shop_id' AND id='$product_id';
  SELECT count(*) INTO v_adjustments FROM public.branch_stock_adjustments
    WHERE shop_id='$shop_id' AND branch_id='$branch_id' AND product_id='$product_id';
  SELECT count(*) INTO v_audit FROM public.audit_log
    WHERE shop_id='$shop_id' AND action='STOCK_ADJUSTMENT'
      AND details LIKE '%$adjustment_a%';
  IF v_branch_qty <> 12 OR v_product_stock <> 12 OR v_adjustments <> 1 OR v_audit <> 1 THEN
    RAISE EXCEPTION 'CAS race invariant failed: branch %, product %, adjustments %, audit %',
      v_branch_qty, v_product_stock, v_adjustments, v_audit;
  END IF;
END;
\$assert\$;
SQL

echo "PASS: session A committed; session B waited on the product lock then failed with SQLSTATE 40001."
echo "PASS: branch stock=12, product stock=12, adjustment rows=1, matching audit rows=1."
