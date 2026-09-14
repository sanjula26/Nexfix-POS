revoke all on function private.bootstrap_first_shop(text) from public;
revoke all on function private.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public;
revoke all on function private.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb) from public;
revoke all on function private.resolve_sale_return_items(uuid,uuid,jsonb) from public;
revoke all on function private.register_pos_device_impl(text,text) from public;
revoke all on function private.upsert_pos_snapshot_impl(text,text,bigint,jsonb) from public;
