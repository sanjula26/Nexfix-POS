-- Ensure a regular Cloud member can read an active branch but cannot
-- reactivate/create Main as a side effect of loading Settings.
-- All synthetic rows are rolled back at the end of this test.
begin;

select plan(16);

insert into auth.users (
  id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
(
  'c1000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated',
  'ensure-branch-admin@example.invalid', '',
  now(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Ensure Branch Admin"}'::jsonb, now(), now()
),
(
  'c1000000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated',
  'ensure-branch-cashier@example.invalid', '',
  now(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Ensure Branch Cashier"}'::jsonb, now(), now()
),
(
  'c1000000-0000-4000-8000-000000000003',
  'authenticated', 'authenticated',
  'ensure-branch-manager@example.invalid', '',
  now(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Ensure Branch Manager"}'::jsonb, now(), now()
);

insert into public.shops (id, name)
values
  ('c2000000-0000-4000-8000-000000000001', 'Ensure Branch Two-Branch Shop'),
  ('c2000000-0000-4000-8000-000000000002', 'Ensure Branch No-Active Shop');

insert into public.shop_memberships (user_id, shop_id, role, active)
values
  ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'admin', true),
  ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'admin', true),
  ('c1000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'cashier', true),
  ('c1000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'cashier', true),
  ('c1000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000002', 'manager', true);

insert into public.branches (id, shop_id, name, code, active, is_default)
values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Main', 'MAIN', false, true),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Branch B', 'BRANCH-B', true, false),
  ('c3000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000002', 'Main', 'MAIN', false, true);

-- Regular cashier: Settings can read an active branch, but this lookup must not
-- reactivate the inactive default or create a new branch.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select is(
  public.ensure_default_branch('c2000000-0000-4000-8000-000000000001'::uuid) -> 'branch' ->> 'id',
  'c3000000-0000-4000-8000-000000000002',
  'cashier receives an already-active branch rather than the retired default'
);

select is(
  (public.ensure_default_branch('c2000000-0000-4000-8000-000000000001'::uuid) ->> 'read_only')::boolean,
  true,
  'cashier branch-list hydration is explicitly read-only'
);

select is(
  (select active from public.branches where id='c3000000-0000-4000-8000-000000000001'),
  false,
  'cashier cannot reactivate the inactive Main branch'
);

select is(
  (select count(*) from public.branches where shop_id='c2000000-0000-4000-8000-000000000001'),
  2::bigint,
  'cashier branch lookup does not create an extra branch'
);

select is(
  (select count(*) from public.branches where shop_id='c2000000-0000-4000-8000-000000000001' and active),
  1::bigint,
  'cashier branch lookup leaves the active branch count unchanged'
);

select throws_ok(
  $$select public.ensure_default_branch('c2000000-0000-4000-8000-000000000002'::uuid)$$,
  '42501',
  'No active branch is configured. Ask a Cloud Admin or Manager to restore the Main branch.',
  'cashier cannot restore Main when the shop has no active branches'
);

select is(
  (select active from public.branches where id='c3000000-0000-4000-8000-000000000003'),
  false,
  'failed cashier recovery leaves the inactive Main branch unchanged'
);

-- Manager retains existing administrative recovery capability.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select lives_ok(
  $$select public.ensure_default_branch('c2000000-0000-4000-8000-000000000002'::uuid)$$,
  'manager can recover the Main branch when no active branch exists'
);

select is(
  (public.ensure_default_branch('c2000000-0000-4000-8000-000000000002'::uuid) -> 'branch' ->> 'id'),
  'c3000000-0000-4000-8000-000000000003',
  'manager recovery returns the existing Main branch'
);

select is(
  (select active from public.branches where id='c3000000-0000-4000-8000-000000000003'),
  true,
  'manager recovery reactivates the existing Main branch'
);

-- Admin can also recover a retired default while another branch remains active.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select lives_ok(
  $$select public.ensure_default_branch('c2000000-0000-4000-8000-000000000001'::uuid)$$,
  'admin can recover an inactive default branch'
);

select is(
  (public.ensure_default_branch('c2000000-0000-4000-8000-000000000001'::uuid) -> 'branch' ->> 'id'),
  'c3000000-0000-4000-8000-000000000001',
  'admin recovery returns Main even while another branch is active'
);

select is(
  (select active from public.branches where id='c3000000-0000-4000-8000-000000000001'),
  true,
  'admin recovery reactivates the existing Main branch'
);

select ok(
  has_function_privilege('authenticated', 'public.ensure_default_branch(uuid)', 'EXECUTE'),
  'authenticated can call the guarded branch hydration RPC'
);

select ok(
  not has_function_privilege('anon', 'public.ensure_default_branch(uuid)', 'EXECUTE'),
  'anonymous users cannot call the branch hydration RPC'
);

select * from finish();
rollback;
