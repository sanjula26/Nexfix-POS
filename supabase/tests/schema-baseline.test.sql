begin;

select plan(13);

select has_table('public', 'customers', 'customers table is present');
select has_table('public', 'sales', 'sales table is present');
select has_table('public', 'sale_payments', 'sale payments table is present');
select has_table('public', 'day_sessions', 'day sessions table is present');
select has_table('public', 'branches', 'branches table is present');
select has_table('public', 'branch_stock', 'branch stock table is present');
select has_table('public', 'pos_devices', 'POS devices table is present');
select has_table('public', 'pos_device_branches', 'POS device branch assignments table is present');
select has_table('public', 'shop_memberships', 'shop memberships table is present');
select has_table('public', 'pos_state_snapshots', 'POS state snapshots table is present');
select has_table('public', 'desktop_releases', 'desktop releases table is present');

select ok(
  not has_column_privilege('anon', 'public.customers', 'credit_balance', 'UPDATE'),
  'anon cannot directly update customer credit balance'
);
select ok(
  not has_column_privilege('authenticated', 'public.customers', 'credit_balance', 'UPDATE'),
  'authenticated clients cannot directly update customer credit balance'
);

select * from finish();

rollback;
