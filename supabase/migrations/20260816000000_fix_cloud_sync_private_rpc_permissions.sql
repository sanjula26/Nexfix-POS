grant usage on schema private to authenticated;
grant execute on function private.register_pos_device_impl(text,text) to authenticated;
grant execute on function private.upsert_pos_snapshot_impl(text,text,bigint,jsonb) to authenticated;
