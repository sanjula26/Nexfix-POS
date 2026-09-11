-- Harden SECURITY DEFINER helpers against search_path hijacking.
-- All referenced application objects are schema-qualified in these functions.

alter function private.is_shop_member(uuid) set search_path = '';
alter function private.is_shop_admin(uuid) set search_path = '';
alter function private.register_pos_device_impl(text,text) set search_path = '';
alter function private.upsert_pos_snapshot_impl(text,text,bigint,jsonb) set search_path = '';
