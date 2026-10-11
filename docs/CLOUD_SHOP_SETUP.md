# Cloud shop setup and Windows authorization

## Existing shop (normal production flow)

1. Sign in to the existing Supabase Auth account in NexFix POS Settings.
2. Confirm that the account has an active row in `public.shop_memberships` for the intended shop.
3. Click **Authorize this Windows PC** to authorize the private updater on this machine.

The POS client deliberately does not call `bootstrap_first_shop`. An account without an active membership must be added by the shop owner; do not create a second shop to work around a membership error.

To inspect membership in the Supabase SQL Editor:

```sql
select u.email, m.user_id, m.shop_id, s.name as shop_name, m.role, m.active
from auth.users u
left join public.shop_memberships m on m.user_id = u.id
left join public.shops s on s.id = m.shop_id
where lower(u.email) = lower('CLOUD-USER-EMAIL')
order by m.created_at;
```

For an existing shop, an authorized database administrator can add the intended Auth user to the intended shop after verifying both IDs:

```sql
insert into public.shop_memberships (user_id, shop_id, role, active)
values ('AUTH-USER-UUID', 'EXISTING-SHOP-UUID', 'cashier', true)
on conflict (user_id, shop_id)
do update set active = true;
```

Use `admin` only when the shop owner explicitly grants admin access. Do not expose service-role credentials in the POS client.

## First-ever install on a truly empty project (owner-only SQL path)

This is **not** part of the app's normal authorization flow. First create/confirm the intended user in Supabase Auth, then run the following in the Supabase SQL Editor as the trusted database owner. Replace the email and shop name. This function itself refuses to run if any shop already exists. Do not use this on a provisioned production project.

```sql
begin;

-- Set the Auth identity only for this transaction so auth.uid() inside the
-- guarded first-shop function resolves to the intended, already-created user.
select set_config(
  'request.jwt.claim.sub',
  (select id::text from auth.users where lower(email) = lower('OWNER-EMAIL')),
  true
);
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select id::text from auth.users where lower(email) = lower('OWNER-EMAIL')),
    'role', 'authenticated'
  )::text,
  true
);

select public.bootstrap_first_shop('SHOP-NAME');

commit;
```

Verify the selected email exists before running. If the function is missing or blocked, stop and have the Supabase project owner apply the reviewed database migration; do not grant broad execution privileges just to bypass the guard. The client intentionally never retries bootstrap or surfaces a raw bootstrap permission error.
