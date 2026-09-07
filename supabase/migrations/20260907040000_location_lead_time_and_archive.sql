alter table public.location_inventory
  add column if not exists lead_days integer not null default 1 check (lead_days between 0 and 120);

alter table public.locations
  add column if not exists archived_at timestamptz;

create or replace function public.set_location_lead_time(
  p_location_id uuid,
  p_item_id uuid,
  p_lead_days integer
) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null or not app.is_master() then raise exception 'not authorized'; end if;
  if p_lead_days < 0 or p_lead_days > 120 then raise exception 'invalid lead time'; end if;
  if not exists(select 1 from public.locations where id=p_location_id and archived_at is null) then
    raise exception 'location not found or archived';
  end if;
  if not exists(select 1 from public.inventory_items where id=p_item_id) then raise exception 'item not found'; end if;
  insert into public.location_inventory(location_id,item_id,quantity,lead_days)
    values(p_location_id,p_item_id,0,p_lead_days)
  on conflict(location_id,item_id) do update
    set lead_days=excluded.lead_days,updated_at=now();
  insert into public.audit_logs(location_id,actor_id,action,entity_type,entity_id,after_data)
    values(p_location_id,auth.uid(),'SET_LEAD_TIME','location_inventory',p_item_id,
      jsonb_build_object('lead_days',p_lead_days));
end $$;
revoke all on function public.set_location_lead_time(uuid,uuid,integer) from public, anon;
grant execute on function public.set_location_lead_time(uuid,uuid,integer) to authenticated;

create or replace function public.archive_location(p_location_id uuid)
returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null or not app.is_master() then raise exception 'not authorized'; end if;
  if not exists(select 1 from public.locations where id=p_location_id and archived_at is null for update) then
    raise exception 'location not found or already archived';
  end if;
  update public.pos_connections
    set is_active=false,status='inactive',effective_until=coalesce(effective_until,now()),updated_at=now()
    where location_id=p_location_id and is_active;
  update public.payment_profiles set is_active=false where location_id=p_location_id and is_active;
  update public.locations set is_active=false,archived_at=now() where id=p_location_id;
  insert into public.audit_logs(location_id,actor_id,action,entity_type,entity_id,after_data)
    values(p_location_id,auth.uid(),'ARCHIVE','locations',p_location_id,
      jsonb_build_object('is_active',false,'history_preserved',true));
end $$;
revoke all on function public.archive_location(uuid) from public, anon;
grant execute on function public.archive_location(uuid) to authenticated;
