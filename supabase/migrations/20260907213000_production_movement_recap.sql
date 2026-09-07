create or replace function public.get_production_movement_recap(
  p_location_id uuid,
  p_period text default 'day'
) returns table(
  produced_ml bigint,
  produced_batches bigint,
  sold_ml bigint,
  wasted_ml bigint,
  restored_ml bigint,
  net_change_ml bigint,
  ready_ml bigint
)
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_timezone text;
  v_local_now timestamp;
  v_local_start timestamp;
  v_start_utc timestamptz;
begin
  if p_period not in ('day','week','month') then raise exception 'invalid period'; end if;
  if auth.uid() is null or not app.is_location_member(p_location_id) then
    raise exception 'not authorized';
  end if;

  select timezone into v_timezone from public.locations where id=p_location_id;
  if v_timezone is null then raise exception 'location not found'; end if;

  v_local_now := now() at time zone v_timezone;
  v_local_start := case p_period
    when 'day' then date_trunc('day',v_local_now)
    when 'week' then date_trunc('day',v_local_now)-interval '6 days'
    else date_trunc('month',v_local_now)
  end;
  v_start_utc := v_local_start at time zone v_timezone;

  return query
  with production as (
    select coalesce(sum(b.initial_ml),0)::bigint as ml, count(*)::bigint as batches
    from public.production_batches b
    where b.location_id=p_location_id
      and b.produced_at>=v_start_utc and b.produced_at<=now()
  ), sold as (
    select coalesce(sum(a.ml_used),0)::bigint as ml
    from public.sale_batch_allocations a
    join public.sales s on s.id=a.sale_id
    where s.location_id=p_location_id
      and s.occurred_at>=v_start_utc and s.occurred_at<=now()
  ), wasted as (
    select coalesce(sum(w.ml_wasted),0)::bigint as ml
    from public.batch_waste_events w
    where w.location_id=p_location_id
      and w.occurred_at>=v_start_utc and w.occurred_at<=now()
  ), restored as (
    select coalesce(sum(r.ml_restored),0)::bigint as ml
    from public.refund_batch_restorations r
    join public.refund_resolutions rr on rr.id=r.refund_resolution_id
    join public.sales s on s.id=rr.sale_id
    where s.location_id=p_location_id
      and rr.resolved_at>=v_start_utc and rr.resolved_at<=now()
  ), ready as (
    select coalesce(sum(b.remaining_ml),0)::bigint as ml
    from public.production_batches b
    where b.location_id=p_location_id and b.status='open' and b.remaining_ml>0
  )
  select p.ml,p.batches,s.ml,w.ml,r.ml,
    (p.ml+r.ml-s.ml-w.ml)::bigint,
    ready.ml
  from production p cross join sold s cross join wasted w cross join restored r cross join ready;
end $$;

revoke all on function public.get_production_movement_recap(uuid,text) from public, anon;
grant execute on function public.get_production_movement_recap(uuid,text) to authenticated;

create index if not exists refund_resolutions_resolved_at_idx
  on public.refund_resolutions(resolved_at desc);
