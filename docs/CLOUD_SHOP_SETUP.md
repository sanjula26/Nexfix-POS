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


## Cloud session persistence forensic note (2026-10-11)

- `signInWithPassword` emits an Auth event before the UI had verified that the session was readable from the configured storage. Settings also used a separate direct sign-in implementation, so it could report success without using the same durable-session checks.
- The Electron secure `nexfix_cloud_signed_out` marker is separate from browser `localStorage`. The old `signInToCloud` helper cleared only the browser marker; Settings had a separate direct-sign-in path that cleared both markers but did not wait for an already-running startup `restoreCloudSession()`. That in-flight restore could observe the old signed-out marker and sign out the newly created session after the login appeared successful.
- The old auth-storage adapter silently fell back to browser-only storage when Electron secure writes failed. That could make the current window look signed in while no durable session existed for relaunch.
- `ensureCloudShop` appended the restore error to an existing sign-in-required message, producing the duplicated `Cloud sign-in required once in Settings.` string.
- `completeSaleCloud` called `ensureCloudShop` without an explicit restore at the sale boundary and surfaced that concatenated error.

The fix centralizes Settings sign-in through `signInToCloud`, drains an in-flight startup restore before clearing both sign-out markers, verifies `getSession()` and the configured auth-storage read-back, verifies the encrypted Electron refresh-token recovery save/read-back, and resolves active shop membership before returning success. Auth events now trigger a verified status refresh rather than optimistically painting the UI green. The sale path restores before shop resolution, retries one transient empty session, and returns one actionable sign-in message. It does not auto-sign-in a cashier, weaken membership/RLS, change local POS login, or alter the independent Windows updater device token / Google Drive backup paths.

Manual verification still required on the installed Windows POS: sign in, sell, navigate away/back, fully exit/reopen, sell again, then explicitly sign out and confirm the sale shows one clear sign-in message. Typecheck/lint and these physical-app checks must pass before calling the fix fully verified.
