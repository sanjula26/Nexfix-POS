-- Keep cloud kit/BOM sales consistent with the local POS inventory model.
-- Kit sale lines remain visible as the kit product, but stock is consumed from
-- BOM components. The trigger runs inside the sale transaction, so component
-- shortages abort the entire sale.

create or replace function private.consume_kit_bom_on_sale_item()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_shop_id uuid;
  v_kit public.products;
  v_component public.products;
  v_bom_qty numeric(12,2);
  v_had_bom boolean := false;
begin
  select s.shop_id into v_shop_id from public.sales s where s.id = new.sale_id;
  if v_shop_id is null then
    raise exception 'Sale shop could not be resolved for kit stock consumption';
  end if;

  select p.* into v_kit
  from public.products p
  where p.id = new.product_id and p.shop_id = v_shop_id
  for update;

  if not found or coalesce(v_kit.is_kit,false) is not true then return new; end if;

  for v_component in
    select cp.*
    from public.kit_items ki
    join public.products cp on cp.id = ki.component_product_id
    where ki.kit_product_id = v_kit.id and cp.shop_id = v_shop_id
    order by cp.id
    for update
  loop
    v_had_bom := true;
    select ki.qty into v_bom_qty
    from public.kit_items ki
    where ki.kit_product_id = v_kit.id and ki.component_product_id = v_component.id;

    if v_bom_qty is null or v_bom_qty <= 0 then
      raise exception 'Invalid BOM quantity for kit %', v_kit.name;
    end if;
    if v_component.stock < new.qty * v_bom_qty then
      raise exception 'Insufficient stock for kit component %', v_component.name;
    end if;

    update public.products
    set stock = stock - (new.qty * v_bom_qty), updated_at = now()
    where id = v_component.id and shop_id = v_shop_id;
  end loop;

  if v_had_bom then
    update public.products
    set stock = stock + new.qty, updated_at = now()
    where id = v_kit.id and shop_id = v_shop_id;
  end if;

  return new;
end;
$function$;

revoke all on function private.consume_kit_bom_on_sale_item() from public;

drop trigger if exists sale_items_consume_kit_bom on public.sale_items;
create trigger sale_items_consume_kit_bom
after insert on public.sale_items
for each row
execute function private.consume_kit_bom_on_sale_item();

do $do$
declare
  def text;
  old_products text := $old$
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.products p where p.id in (select si.product_id from public.sale_items si where si.sale_id=v_sale_id) and p.shop_id=p_shop_id),'[]'::jsonb),
  $old$;
  new_products text := $new$
    'products', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.id)
      from public.products p
      where p.shop_id=p_shop_id
        and (
          p.id in (select si.product_id from public.sale_items si where si.sale_id=v_sale_id)
          or p.id in (
            select ki.component_product_id
            from public.kit_items ki
            where ki.kit_product_id in (
              select si.product_id from public.sale_items si where si.sale_id=v_sale_id
            )
          )
        )
    ),'[]'::jsonb),
  $new$;
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='complete_sale_atomic' limit 1;
  if def is null then raise exception 'public.complete_sale_atomic definition not found'; end if;
  if position(old_products in def) = 0 then raise exception 'Expected product response query was not found'; end if;
  execute replace(def, old_products, new_products);
end
$do$;
