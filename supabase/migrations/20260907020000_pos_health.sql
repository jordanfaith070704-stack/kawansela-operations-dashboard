create or replace function public.get_pos_health(p_location_id uuid default null)
returns table(location_id uuid, provider text, status text, last_successful_sync_at timestamptz, last_error text)
language sql stable security definer set search_path=public,auth as $$
  select c.location_id,c.provider,c.status,c.last_successful_sync_at,c.last_error
  from public.pos_connections c
  where c.is_active
    and (case when app.is_master() then p_location_id is null or c.location_id=p_location_id
              else p_location_id is not null and c.location_id=p_location_id and app.is_location_member(c.location_id) end)
$$;
revoke all on function public.get_pos_health(uuid) from public,anon;
grant execute on function public.get_pos_health(uuid) to authenticated;
