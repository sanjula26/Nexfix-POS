-- Isolated pgTAP regression for the Inventory editor's compare-and-set RPC.
-- All rows are synthetic and the test transaction is rolled back; no hosted data is touched.
begin;

select plan(7);

insert into auth.users (
  id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  'a1000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'stock-cas-regression@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Stock CAS Regression"}'::jsonb,
  now(),
  now()
);

insert into public.profiles (id, email, full_name, role)
values (
  'a1000000-0000-4000-8000-000000000001',
  'stock-cas-regression@example.invalid',
  'Stock CAS Regression',
  'admin'
)
on conflict (id) do update
set email = excluded.email, full_name = excluded.full_name, role = excluded.role;

insert into public.shops (id, name)
values ('a2000000-0000-4000-8000-000000000001', 'Stock CAS Isolated Test Shop');

insert into public.shop_memberships (user_id, shop_id, role, active)
values (
  'a1000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'admin',
  true
);

insert into public.branches (id, shop_id, name, code, active, is_default)
values (
  'a3000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'CI Main',
  'CI-MAIN',
  true,
  true
);

insert into public.products (id, shop_id, name, cost, price, stock)
values (
  'a4000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'CAS Regression Product',
  1,
  2,
  10
);

insert into public.branch_stock (shop_id, branch_id, product_id, qty)
values (
  'a2000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000001',
  10
);

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select lives_ok(
  $$select public.adjust_branch_stock_atomic_expected(
    'a2000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    'ci-stock-device',
    'a4000000-0000-4000-8000-000000000001',
    2,
    'CI compare-and-set success',
    'a5000000-0000-4000-8000-000000000001',
    10
  )$$,
  'a fresh expected quantity is accepted'
);

select is(
  (select qty from public.branch_stock
   where shop_id = 'a2000000-0000-4000-8000-000000000001'
     and branch_id = 'a3000000-0000-4000-8000-000000000001'
     and product_id = 'a4000000-0000-4000-8000-000000000001'),
  12.00::numeric,
  'the successful adjustment updates branch stock exactly once'
);

select is(
  (select stock from public.products
   where shop_id = 'a2000000-0000-4000-8000-000000000001'
     and id = 'a4000000-0000-4000-8000-000000000001'),
  12.00::numeric,
  'the successful adjustment keeps the shop product total aligned'
);

select throws_ok(
  $$select public.adjust_branch_stock_atomic_expected(
    'a2000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    'ci-stock-device',
    'a4000000-0000-4000-8000-000000000001',
    3,
    'CI stale compare-and-set rejection',
    'a5000000-0000-4000-8000-000000000002',
    10
  )$$,
  '40001',
  'Stock changed on another POS (expected 10, current 12.00). Refresh branch stock and retry.',
  'a stale expected quantity is rejected with serialization conflict'
);

select is(
  (select qty from public.branch_stock
   where shop_id = 'a2000000-0000-4000-8000-000000000001'
     and branch_id = 'a3000000-0000-4000-8000-000000000001'
     and product_id = 'a4000000-0000-4000-8000-000000000001'),
  12.00::numeric,
  'a rejected stale adjustment does not change branch stock'
);

select is(
  (select stock from public.products
   where shop_id = 'a2000000-0000-4000-8000-000000000001'
     and id = 'a4000000-0000-4000-8000-000000000001'),
  12.00::numeric,
  'a rejected stale adjustment does not change the shop product total'
);

select is(
  (select count(*)::integer from public.branch_stock_adjustments
   where shop_id = 'a2000000-0000-4000-8000-000000000001'
     and branch_id = 'a3000000-0000-4000-8000-000000000001'
     and product_id = 'a4000000-0000-4000-8000-000000000001'),
  1,
  'only the successful adjustment is recorded'
);

select * from finish();
rollback;
