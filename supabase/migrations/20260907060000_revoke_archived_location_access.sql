create or replace function public.archive_location(p_location_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  revoked_memberships integer := 0;
begin
  if auth.uid() is null or not app.is_master() then
    raise exception 'not authorized';
  end if;

  if not exists(
    select 1
    from public.locations
    where id = p_location_id and archived_at is null
    for update
  ) then
    raise exception 'location not found or already archived';
  end if;

  update public.pos_connections
    set is_active = false,
        status = 'inactive',
        effective_until = coalesce(effective_until, now()),
        updated_at = now()
    where location_id = p_location_id and is_active;

  update public.payment_profiles
    set is_active = false
    where location_id = p_location_id and is_active;

  delete from public.memberships
    where location_id = p_location_id and role <> 'master';
  get diagnostics revoked_memberships = row_count;

  update public.locations
    set is_active = false, archived_at = now()
    where id = p_location_id;

  insert into public.audit_logs(
    location_id, actor_id, action, entity_type, entity_id, after_data
  ) values (
    p_location_id,
    auth.uid(),
    'ARCHIVE',
    'locations',
    p_location_id,
    jsonb_build_object(
      'is_active', false,
      'history_preserved', true,
      'operator_memberships_revoked', revoked_memberships
    )
  );
end
$function$;

revoke all on function public.archive_location(uuid) from public, anon;
grant execute on function public.archive_location(uuid) to authenticated;
