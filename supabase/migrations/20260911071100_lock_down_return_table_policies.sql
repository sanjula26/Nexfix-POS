-- Return records are intentionally RPC-only from the browser.
-- Explicit deny policies keep direct authenticated table access closed and
-- remove the RLS-enabled-without-policy advisor finding.
create policy "sale_return_items_no_direct_access"
on public.sale_return_items
for all
to authenticated
using (false)
with check (false);

create policy "sale_returns_no_direct_access"
on public.sale_returns
for all
to authenticated
using (false)
with check (false);
