create or replace function public.get_sales_product_recap(
  p_location_id uuid,
  p_period text default 'week'
) returns table(
  product_name text,
  cups bigint,
  revenue numeric,
  previous_cups bigint,
  previous_revenue numeric
)
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_timezone text := 'Asia/Jakarta';
  v_local_now timestamp;
  v_local_start timestamp;
  v_previous_start timestamp;
  v_previous_end timestamp;
  v_current_start_utc timestamptz;
  v_previous_start_utc timestamptz;
  v_previous_end_utc timestamptz;
begin
  if p_period not in ('week','month') then raise exception 'invalid period'; end if;

  if p_location_id is null then
    if auth.uid() is null or not app.is_master() then raise exception 'not authorized'; end if;
  else
    if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
    select timezone into v_timezone from public.locations where id=p_location_id;
    if v_timezone is null then raise exception 'location not found'; end if;
  end if;

  v_local_now := now() at time zone v_timezone;
  v_local_start := case p_period
    when 'week' then date_trunc('day',v_local_now)-interval '6 days'
    else date_trunc('month',v_local_now)
  end;
  v_previous_start := case p_period
    when 'week' then v_local_start-interval '7 days'
    else v_local_start-interval '1 month'
  end;
  v_previous_end := least(v_local_start, v_previous_start+(v_local_now-v_local_start));
  v_current_start_utc := v_local_start at time zone v_timezone;
  v_previous_start_utc := v_previous_start at time zone v_timezone;
  v_previous_end_utc := v_previous_end at time zone v_timezone;

  return query
  with current_sales as (
    select coalesce(r.name,'Produk') as name,
      coalesce(sum(greatest(s.quantity-coalesce(refunded.quantity,0),0)),0)::bigint as cups,
      coalesce(sum(s.total*(greatest(s.quantity-coalesce(refunded.quantity,0),0)::numeric/s.quantity)),0)::numeric as revenue
    from public.sales s
    left join public.recipes r on r.id=s.product_recipe_id
    left join lateral (
      select sum(rr.quantity)::integer as quantity
      from public.refund_resolutions rr where rr.sale_id=s.id
    ) refunded on true
    where s.occurred_at>=v_current_start_utc
      and s.occurred_at<=now()
      and (p_location_id is null or s.location_id=p_location_id)
    group by 1
  ), previous_sales as (
    select coalesce(r.name,'Produk') as name,
      coalesce(sum(greatest(s.quantity-coalesce(refunded.quantity,0),0)),0)::bigint as cups,
      coalesce(sum(s.total*(greatest(s.quantity-coalesce(refunded.quantity,0),0)::numeric/s.quantity)),0)::numeric as revenue
    from public.sales s
    left join public.recipes r on r.id=s.product_recipe_id
    left join lateral (
      select sum(rr.quantity)::integer as quantity
      from public.refund_resolutions rr where rr.sale_id=s.id
    ) refunded on true
    where s.occurred_at>=v_previous_start_utc
      and s.occurred_at<v_previous_end_utc
      and (p_location_id is null or s.location_id=p_location_id)
    group by 1
  )
  select coalesce(c.name,p.name),
    coalesce(c.cups,0)::bigint,
    coalesce(c.revenue,0)::numeric,
    coalesce(p.cups,0)::bigint,
    coalesce(p.revenue,0)::numeric
  from current_sales c
  full outer join previous_sales p on p.name=c.name
  order by coalesce(c.cups,0) desc, coalesce(c.revenue,0) desc;
end $$;

revoke all on function public.get_sales_product_recap(uuid,text) from public, anon;
grant execute on function public.get_sales_product_recap(uuid,text) to authenticated;

create or replace function public.get_cart_sales_performance(
  p_period text default 'week'
) returns table(
  location_id uuid,
  location_code text,
  location_name text,
  cups bigint,
  revenue numeric,
  previous_revenue numeric,
  active_days bigint
)
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_timezone text := 'Asia/Jakarta';
  v_local_now timestamp;
  v_local_start timestamp;
  v_previous_start timestamp;
  v_previous_end timestamp;
begin
  if auth.uid() is null or not app.is_master() then raise exception 'not authorized'; end if;
  if p_period not in ('week','month') then raise exception 'invalid period'; end if;

  v_local_now := now() at time zone v_timezone;
  v_local_start := case p_period
    when 'week' then date_trunc('day',v_local_now)-interval '6 days'
    else date_trunc('month',v_local_now)
  end;
  v_previous_start := case p_period
    when 'week' then v_local_start-interval '7 days'
    else v_local_start-interval '1 month'
  end;
  v_previous_end := least(v_local_start, v_previous_start+(v_local_now-v_local_start));

  return query
  with current_sales as (
    select s.location_id,
      sum(greatest(s.quantity-coalesce(refunded.quantity,0),0))::bigint as cups,
      sum(s.total*(greatest(s.quantity-coalesce(refunded.quantity,0),0)::numeric/s.quantity))::numeric as revenue,
      count(distinct (s.occurred_at at time zone v_timezone)::date)
        filter(where greatest(s.quantity-coalesce(refunded.quantity,0),0)>0)::bigint as active_days
    from public.sales s
    left join lateral (
      select sum(rr.quantity)::integer as quantity
      from public.refund_resolutions rr where rr.sale_id=s.id
    ) refunded on true
    where s.occurred_at>=v_local_start at time zone v_timezone
      and s.occurred_at<=now()
    group by s.location_id
  ), previous_sales as (
    select s.location_id,
      sum(s.total*(greatest(s.quantity-coalesce(refunded.quantity,0),0)::numeric/s.quantity))::numeric as revenue
    from public.sales s
    left join lateral (
      select sum(rr.quantity)::integer as quantity
      from public.refund_resolutions rr where rr.sale_id=s.id
    ) refunded on true
    where s.occurred_at>=v_previous_start at time zone v_timezone
      and s.occurred_at<v_previous_end at time zone v_timezone
    group by s.location_id
  )
  select l.id, l.code, l.name,
    coalesce(c.cups,0)::bigint,
    coalesce(c.revenue,0)::numeric,
    coalesce(p.revenue,0)::numeric,
    coalesce(c.active_days,0)::bigint
  from public.locations l
  left join current_sales c on c.location_id=l.id
  left join previous_sales p on p.location_id=l.id
  where l.is_active=true and l.archived_at is null
  order by coalesce(c.revenue,0) desc, l.code;
end $$;

revoke all on function public.get_cart_sales_performance(text) from public, anon;
grant execute on function public.get_cart_sales_performance(text) to authenticated;

create index if not exists sales_occurred_at_location_idx
  on public.sales(occurred_at desc, location_id);
