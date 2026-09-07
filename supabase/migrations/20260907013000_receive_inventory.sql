-- Supply receiving is the controlled entry point for raw materials and
-- packaging. It creates location stock on first receipt and records the source.
create or replace function public.receive_inventory(
  p_location_id uuid,
  p_item_id uuid,
  p_quantity numeric,
  p_received_at timestamptz default now(),
  p_reference text default null,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare v_movement uuid;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  if p_quantity <= 0 then raise exception 'received quantity must be positive'; end if;
  if not exists(select 1 from public.locations where id=p_location_id and is_active) then raise exception 'location is not active'; end if;
  if not exists(select 1 from public.inventory_items where id=p_item_id) then raise exception 'inventory item not found'; end if;
  insert into public.location_inventory(location_id,item_id,quantity)
    values(p_location_id,p_item_id,p_quantity)
    on conflict(location_id,item_id) do update
      set quantity=location_inventory.quantity+excluded.quantity,updated_at=now();
  insert into public.inventory_movements(
    location_id,item_id,quantity,movement_type,source_type,note,created_by,created_at
  ) values (
    p_location_id,p_item_id,p_quantity,'receive','supply_receipt',
    concat_ws(' · ',nullif(trim(p_reference),''),nullif(trim(p_note),'')),auth.uid(),p_received_at
  ) returning id into v_movement;
  return v_movement;
end $$;
revoke all on function public.receive_inventory(uuid,uuid,numeric,timestamptz,text,text) from public, anon;
grant execute on function public.receive_inventory(uuid,uuid,numeric,timestamptz,text,text) to authenticated;
