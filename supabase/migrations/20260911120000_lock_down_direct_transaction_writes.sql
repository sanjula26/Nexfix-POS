-- Keep core transactional writes behind SECURITY DEFINER RPCs.
-- Authenticated clients retain only the SELECT privileges needed by the POS UI.
revoke insert, update, delete, truncate on table public.sales,
  public.sale_items,
  public.sale_payments,
  public.inventory_units,
  public.counters,
  public.audit_log,
  public.pos_devices,
  public.pos_state_snapshots
from authenticated;
