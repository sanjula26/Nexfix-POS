-- Synthetic pgTAP coverage for source-sale branch authorization.
-- Every row is inserted inside a transaction and rolled back; no hosted data is used.
begin;

select plan(39);

insert into auth.users (
  id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
(
  'b1000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated',
  'sale-branch-guard-admin@example.invalid', '',
  now(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Sale Branch Guard Admin"}'::jsonb, now(), now()
),
(
  'b1000000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated',
  'sale-branch-guard-other@example.invalid', '',
  now(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Sale Branch Guard Other User"}'::jsonb, now(), now()
);

insert into public.shops (id, name)
values
  ('b2000000-0000-4000-8000-000000000001', 'Sale Branch Guard Multi Shop'),
  ('b2000000-0000-4000-8000-000000000002', 'Sale Branch Guard Single Shop');

insert into public.shop_memberships (user_id, shop_id, role, active)
values
  ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'admin', true),
  ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002', 'admin', true),
  ('b1000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'cashier', true);

insert into public.pos_shops (shop_id, created_by)
values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001');

insert into public.branches (id, shop_id, name, code, active, is_default)
values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Branch A', 'SG-A', true, true),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'Branch B', 'SG-B', true, false),
  ('b3000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000002', 'Single Branch', 'SG-C', true, true),
  ('b3000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000002', 'Retired Branch', 'SG-D', true, false);

insert into public.sales (id, shop_id, bill_no, subtotal, total, branch_id)
values
  ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'SG-A-001', 100, 100, 'b3000000-0000-4000-8000-000000000001'),
  ('b4000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'SG-B-001', 100, 100, 'b3000000-0000-4000-8000-000000000002'),
  ('b4000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000002', 'SG-C-001', 100, 100, 'b3000000-0000-4000-8000-000000000003'),
  ('b4000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000002', 'SG-D-001', 100, 100, 'b3000000-0000-4000-8000-000000000004');

insert into public.products (id, shop_id, name, cost, price, stock)
values (
  'b6000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'Sale Branch Guard Product',
  50,
  100,
  10
);

insert into public.sale_items (id, sale_id, product_id, name, qty, price, cost, unit_ids)
values (
  'b7000000-0000-4000-8000-000000000001',
  'b4000000-0000-4000-8000-000000000001',
  'b6000000-0000-4000-8000-000000000001',
  'Sale Branch Guard Product',
  1,
  100,
  50,
  '{}'::uuid[]
);


-- Sales can only be created against active branches. Retire Branch D after
-- inserting its historical sale so the authorization guard can verify the
-- historical inactive-branch rejection path.
update public.branches
set active = false
where id = 'b3000000-0000-4000-8000-000000000004';

insert into public.pos_devices (shop_id, device_id, user_id, revoked_at)
values
  ('b2000000-0000-4000-8000-000000000001', 'guard-device-a', 'b1000000-0000-4000-8000-000000000001', null),
  ('b2000000-0000-4000-8000-000000000001', 'guard-device-b', 'b1000000-0000-4000-8000-000000000001', null),
  ('b2000000-0000-4000-8000-000000000001', 'guard-device-other-user', 'b1000000-0000-4000-8000-000000000002', null),
  ('b2000000-0000-4000-8000-000000000001', 'guard-device-revoked', 'b1000000-0000-4000-8000-000000000001', now()),
  ('b2000000-0000-4000-8000-000000000002', 'guard-device-legacy', 'b1000000-0000-4000-8000-000000000001', null),
  ('b2000000-0000-4000-8000-000000000002', 'guard-device-stale', 'b1000000-0000-4000-8000-000000000001', null);

insert into public.pos_device_branches (shop_id, device_id, branch_id, assigned_by)
values
  ('b2000000-0000-4000-8000-000000000001', 'guard-device-a', 'b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000001', 'guard-device-b', 'b3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000001', 'guard-device-other-user', 'b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000001', 'guard-device-revoked', 'b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000002', 'guard-device-stale', 'b3000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select lives_ok(
  $$select private.assert_pos_device_can_access_sale(
    'b2000000-0000-4000-8000-000000000001',
    'guard-device-a',
    'b4000000-0000-4000-8000-000000000001'
  )$$,
  'a registered Branch A device can access a Branch A sale'
);

select throws_ok(
  $$select private.assert_pos_device_can_access_sale(
    'b2000000-0000-4000-8000-000000000001',
    'guard-device-a',
    'b4000000-0000-4000-8000-000000000002'
  )$$,
  'P0001',
  'This POS device is not assigned to the sale branch',
  'a Branch A device cannot access a Branch B sale'
);

select throws_ok(
  $$select public.process_sale_return_atomic_for_device_branch(
    'b2000000-0000-4000-8000-000000000001',
    'b5000000-0000-4000-8000-000000000001',
    'b4000000-0000-4000-8000-000000000002',
    'guard-device-a', 'branch mismatch', 'refund', 'cash', '[]'::jsonb
  )$$,
  'P0001',
  'This POS device is not assigned to the sale branch',
  'the public sale-return RPC rejects a cross-branch sale before accounting'
);

select throws_ok(
  $$select public.register_trade_in_atomic_for_device_branch(
    'b2000000-0000-4000-8000-000000000001',
    'guard-device-a',
    'b4000000-0000-4000-8000-000000000002',
    'b5000000-0000-4000-8000-000000000002',
    'b6000000-0000-4000-8000-000000000001',
    25, 'SG-IMEI', null
  )$$,
  'P0001',
  'This POS device is not assigned to the sale branch',
  'the public trade-in RPC rejects a cross-branch sale before inventory mutation'
);

select throws_ok(
  $$select public.request_sale_reversal_for_device_branch(
    'b2000000-0000-4000-8000-000000000001',
    'b5000000-0000-4000-8000-000000000003',
    'b4000000-0000-4000-8000-000000000002',
    'guard-device-a', 'branch mismatch'
  )$$,
  'P0001',
  'This POS device is not assigned to the sale branch',
  'the public reversal-request RPC rejects a cross-branch sale'
);

select throws_ok(
  $$select private.assert_pos_device_can_access_sale(
    'b2000000-0000-4000-8000-000000000001',
    'guard-device-not-registered',
    'b4000000-0000-4000-8000-000000000001'
  )$$,
  'P0001',
  'POS device is not registered to this user for this shop',
  'an unregistered device is rejected'
);

select throws_ok(
  $$select private.assert_pos_device_can_access_sale(
    'b2000000-0000-4000-8000-000000000001',
    'guard-device-other-user',
    'b4000000-0000-4000-8000-000000000001'
  )$$,
  'P0001',
  'POS device is not registered to this user for this shop',
  'a device registered to a different cloud user is rejected'
);

select throws_ok(
  $$select private.assert_pos_device_can_access_sale(
    'b2000000-0000-4000-8000-000000000001',
    'guard-device-revoked',
    'b4000000-0000-4000-8000-000000000001'
  )$$,
  'P0001',
  'POS device is not registered to this user for this shop',
  'a revoked device is rejected'
);

select lives_ok(
  $$select private.assert_pos_device_can_access_sale(
    'b2000000-0000-4000-8000-000000000002',
    'guard-device-legacy',
    'b4000000-0000-4000-8000-000000000003'
  )$$,
  'a registered device without a binding remains compatible in a single-active-branch shop'
);

select throws_ok(
  $$select private.assert_pos_device_can_access_sale(
    'b2000000-0000-4000-8000-000000000002',
    'guard-device-stale',
    'b4000000-0000-4000-8000-000000000003'
  )$$,
  'P0001',
  'This POS device has a stale branch assignment and is not assigned to the sale branch',
  'a stale conflicting branch assignment is rejected even when only one branch remains active'
);

select throws_ok(
  $$select private.assert_pos_device_can_access_sale(
    'b2000000-0000-4000-8000-000000000002',
    'guard-device-stale',
    'b4000000-0000-4000-8000-000000000004'
  )$$,
  'P0001',
  'Sale branch is not active in this shop',
  'a sale attached to an inactive branch is rejected'
);

select throws_ok(
  $$select public.process_sale_return_atomic(
    'b2000000-0000-4000-8000-000000000001',
    'b5000000-0000-4000-8000-000000000004',
    'b4000000-0000-4000-8000-000000000001',
    'legacy client', 'refund', 'cash', '[]'::jsonb
  )$$,
  'P0001',
  'This Nexfix POS client is outdated. Update the POS before processing a Cloud sale return.',
  'the old sale-return RPC fails closed with an upgrade message'
);

select throws_ok(
  $$select public.register_trade_in_atomic(
    'b2000000-0000-4000-8000-000000000001',
    'b4000000-0000-4000-8000-000000000001',
    'b5000000-0000-4000-8000-000000000005',
    'b6000000-0000-4000-8000-000000000002',
    25, 'SG-OLD-IMEI', null
  )$$,
  'P0001',
  'This Nexfix POS client is outdated. Update the POS before registering a Cloud trade-in.',
  'the old trade-in RPC fails closed with an upgrade message'
);

select throws_ok(
  $$select public.request_sale_reversal(
    'b2000000-0000-4000-8000-000000000001',
    'b5000000-0000-4000-8000-000000000006',
    'b4000000-0000-4000-8000-000000000001',
    'legacy client'
  )$$,
  'P0001',
  'This Nexfix POS client is outdated. Update the POS before requesting a Cloud bill reversal.',
  'the old bill-reversal RPC fails closed with an upgrade message'
);

select ok(
  has_function_privilege('authenticated', 'public.process_sale_return_atomic_for_device_branch(uuid,uuid,uuid,text,text,text,text,jsonb)', 'EXECUTE'),
  'authenticated can execute the guarded sale-return RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.register_trade_in_atomic_for_device_branch(uuid,text,uuid,uuid,uuid,numeric,text,text)', 'EXECUTE'),
  'authenticated can execute the guarded trade-in RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.request_sale_reversal_for_device_branch(uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'authenticated can execute the guarded bill-reversal RPC'
);
select ok(
  not has_function_privilege('authenticated', 'private.assert_pos_device_can_access_sale(uuid,text,uuid)', 'EXECUTE'),
  'authenticated cannot call the private authorization helper directly'
);
select ok(
  not has_function_privilege('authenticated', 'private.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb)', 'EXECUTE'),
  'authenticated cannot bypass the guarded sale-return wrapper'
);
select ok(
  not has_function_privilege('authenticated', 'private.register_trade_in_atomic(uuid,uuid,uuid,uuid,numeric,text,text)', 'EXECUTE'),
  'authenticated cannot bypass the guarded trade-in wrapper'
);
select ok(
  not has_function_privilege('authenticated', 'private.request_sale_reversal(uuid,uuid,uuid,text)', 'EXECUTE'),
  'authenticated cannot bypass the guarded bill-reversal wrapper'
);
select ok(
  not has_function_privilege('anon', 'public.process_sale_return_atomic_for_device_branch(uuid,uuid,uuid,text,text,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.register_trade_in_atomic_for_device_branch(uuid,text,uuid,uuid,uuid,numeric,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.request_sale_reversal_for_device_branch(uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'anon cannot execute any guarded sale transaction RPC'
);


select ok(
  has_function_privilege('authenticated', 'public.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb)', 'EXECUTE'),
  'older authenticated clients can reach the sale-return upgrade stub'
);
select ok(
  has_function_privilege('authenticated', 'public.register_trade_in_atomic(uuid,uuid,uuid,uuid,numeric,text,text)', 'EXECUTE'),
  'older authenticated clients can reach the trade-in upgrade stub'
);
select ok(
  has_function_privilege('authenticated', 'public.request_sale_reversal(uuid,uuid,uuid,text)', 'EXECUTE'),
  'older authenticated clients can reach the bill-reversal upgrade stub'
);
select ok(
  not has_function_privilege('anon', 'public.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.register_trade_in_atomic(uuid,uuid,uuid,uuid,numeric,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.request_sale_reversal(uuid,uuid,uuid,text)', 'EXECUTE'),
  'anon cannot execute any legacy sale-transaction RPC'
);


select is(
  (public.resolve_sale_return_target_for_device_branch(
    'SG-A-001',
    'guard-device-a'
  ) ->> 'sale_id'),
  'b4000000-0000-4000-8000-000000000001',
  'a Branch A device can resolve a Branch A bill number'
);

select throws_ok(
  $select public.resolve_sale_return_target_for_device_branch(
    'SG-B-001',
    'guard-device-a'
  )$,
  'P0001',
  'This POS device is not assigned to the sale branch',
  'a Branch A device cannot resolve a Branch B bill number'
);

select is(
  jsonb_array_length(public.resolve_sale_return_items_for_device_branch(
    'b2000000-0000-4000-8000-000000000001',
    'b4000000-0000-4000-8000-000000000001',
    'guard-device-a',
    '[{"product_id":"b6000000-0000-4000-8000-000000000001","qty":1,"unit_ids":[]}]'::jsonb
  )),
  1,
  'a Branch A device can resolve items for its own sale'
);

select throws_ok(
  $select public.resolve_sale_return_items_for_device_branch(
    'b2000000-0000-4000-8000-000000000001',
    'b4000000-0000-4000-8000-000000000002',
    'guard-device-a',
    '[{"product_id":"b6000000-0000-4000-8000-000000000001","qty":1,"unit_ids":[]}]'::jsonb
  )$,
  'P0001',
  'This POS device is not assigned to the sale branch',
  'a Branch A device cannot resolve items for a Branch B sale'
);

select throws_ok(
  $select public.resolve_sale_return_target('SG-A-001')$,
  'P0001',
  'This Nexfix POS client is outdated. Update the POS before looking up a Cloud return bill.',
  'the old bill-number resolver fails closed with an upgrade message'
);

select throws_ok(
  $select public.resolve_sale_return_items(
    'b2000000-0000-4000-8000-000000000001',
    'b4000000-0000-4000-8000-000000000001',
    '[{"product_id":"b6000000-0000-4000-8000-000000000001","qty":1,"unit_ids":[]}]'::jsonb
  )$,
  'P0001',
  'This Nexfix POS client is outdated. Update the POS before looking up Cloud return items.',
  'the old return-item resolver fails closed with an upgrade message'
);

select ok(
  has_function_privilege('authenticated', 'public.resolve_sale_return_target_for_device_branch(text,text)', 'EXECUTE'),
  'authenticated can execute the guarded bill-number resolver'
);
select ok(
  has_function_privilege('authenticated', 'public.resolve_sale_return_items_for_device_branch(uuid,uuid,text,jsonb)', 'EXECUTE'),
  'authenticated can execute the guarded return-item resolver'
);
select ok(
  not has_function_privilege('authenticated', 'private.resolve_sale_return_target(text)', 'EXECUTE'),
  'authenticated cannot bypass the guarded bill-number resolver'
);
select ok(
  not has_function_privilege('authenticated', 'private.resolve_sale_return_items(uuid,uuid,jsonb)', 'EXECUTE'),
  'authenticated cannot bypass the guarded return-item resolver'
);
select ok(
  has_function_privilege('authenticated', 'public.resolve_sale_return_target(text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.resolve_sale_return_items(uuid,uuid,jsonb)', 'EXECUTE'),
  'older authenticated clients can reach both read-only resolver upgrade stubs'
);
select ok(
  not has_function_privilege('anon', 'public.resolve_sale_return_target_for_device_branch(text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.resolve_sale_return_items_for_device_branch(uuid,uuid,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.resolve_sale_return_target(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.resolve_sale_return_items(uuid,uuid,jsonb)', 'EXECUTE'),
  'anon cannot execute any old or guarded Sale return resolver RPC'
);

select * from finish();
rollback;
