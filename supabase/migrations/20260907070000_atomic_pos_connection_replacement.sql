create or replace function public.activate_pos_connection_replacement(
  p_connection_id uuid,
  p_external_store_id text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location_id uuid;
begin
  if not app.is_service_role() then
    raise exception 'not authorized';
  end if;

  select location_id into v_location_id
  from public.pos_connections
  where id = p_connection_id
    and provider = 'loyverse'
    and is_active = false
  for update;

  if not found then
    raise exception 'candidate connection not found';
  end if;

  update public.pos_connections
    set is_active = false,
        status = 'inactive',
        effective_until = coalesce(effective_until, now()),
        updated_at = now()
    where location_id = v_location_id
      and provider = 'loyverse'
      and id <> p_connection_id
      and is_active = true;

  update public.pos_connections
    set external_store_id = p_external_store_id,
        status = 'healthy',
        is_active = true,
        effective_from = coalesce(effective_from, now()),
        effective_until = null,
        last_attempt_at = now(),
        last_error = null,
        updated_at = now()
    where id = p_connection_id;

  return v_location_id;
end
$function$;

revoke all on function public.activate_pos_connection_replacement(uuid,text)
  from public, anon, authenticated;
grant execute on function public.activate_pos_connection_replacement(uuid,text)
  to service_role;
