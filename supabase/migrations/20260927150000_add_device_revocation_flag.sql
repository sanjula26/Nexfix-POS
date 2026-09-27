-- Nexfix POS: keep server-side desktop update/device revocation state aligned with production schema.
-- The production pos_devices table uses user_id (not owner_id).

alter table public.pos_devices
  add column if not exists revoked_at timestamptz;

create index if not exists pos_devices_active_idx
  on public.pos_devices(user_id, shop_id, revoked_at);
