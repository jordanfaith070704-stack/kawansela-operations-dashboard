-- Record multiple same-recipe batches atomically. Each batch retains its own
-- FIFO identity while raw inventory is deducted for the full production run.
create or replace function public.create_production_batches(
  p_location_id uuid,
  p_recipe_version_id uuid,
  p_produced_at timestamptz,
  p_batch_count integer
) returns integer
language plpgsql security definer set search_path = public, auth as $$
declare
  v_index integer;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then
    raise exception 'not authorized';
  end if;
  if p_batch_count < 1 or p_batch_count > 50 then
    raise exception 'batch count must be between 1 and 50';
  end if;
  for v_index in 1..p_batch_count loop
    perform public.create_production_batch(
      p_location_id, p_recipe_version_id, p_produced_at
    );
  end loop;
  return p_batch_count;
end $$;

revoke all on function public.create_production_batches(uuid,uuid,timestamptz,integer) from public, anon;
grant execute on function public.create_production_batches(uuid,uuid,timestamptz,integer) to authenticated;
