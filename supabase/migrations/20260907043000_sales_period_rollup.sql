create or replace function public.get_sales_rollup(
  p_location_id uuid,
  p_period text default 'day'
) returns table(
  bucket text,
  revenue numeric,
  cogs numeric,
  cups bigint,
  cash numeric,
  qris numeric
)
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_timezone text := 'Asia/Jakarta';
  v_local_now timestamp;
  v_local_start timestamp;
  v_utc_start timestamptz;
begin
  if p_period not in ('day','week','month') then raise exception 'invalid period'; end if;
  if p_location_id is null then
    if auth.uid() is null or not app.is_master() then raise exception 'not authorized'; end if;
  else
    if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
    select timezone into v_timezone from public.locations where id=p_location_id;
    if v_timezone is null then raise exception 'location not found'; end if;
  end if;

  v_local_now := now() at time zone v_timezone;
  v_local_start := case p_period
    when 'day' then date_trunc('day',v_local_now)
    when 'week' then date_trunc('day',v_local_now)-interval '6 days'
    else date_trunc('month',v_local_now)
  end;
  v_utc_start := v_local_start at time zone v_timezone;

  return query
  select
    case when p_period='day'
      then to_char(date_trunc('hour',s.occurred_at at time zone v_timezone),'YYYY-MM-DD"T"HH24:MI:SS')
      else to_char(date_trunc('day',s.occurred_at at time zone v_timezone),'YYYY-MM-DD')
    end as bucket,
    coalesce(sum(s.total),0)::numeric as revenue,
    coalesce(sum(s.cogs),0)::numeric as cogs,
    coalesce(sum(s.quantity),0)::bigint as cups,
    coalesce(sum(s.total) filter(where s.payment_method='cash'),0)::numeric as cash,
    coalesce(sum(s.total) filter(where s.payment_method in ('qris_static','qris_provider')),0)::numeric as qris
  from public.sales s
  where s.occurred_at>=v_utc_start
    and (p_location_id is null or s.location_id=p_location_id)
  group by 1
  order by 1;
end $$;
revoke all on function public.get_sales_rollup(uuid,text) from public, anon;
grant execute on function public.get_sales_rollup(uuid,text) to authenticated;
