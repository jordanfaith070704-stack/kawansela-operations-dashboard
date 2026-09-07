-- Phase I operational transactions.  All mutations below are scoped to the
-- authenticated member's location and run atomically.

create table if not exists public.batch_waste_events (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete restrict,
  batch_id uuid not null references public.production_batches(id) on delete restrict,
  ml_wasted integer not null check (ml_wasted > 0),
  cogs numeric(14,2) not null check (cogs >= 0),
  occurred_at timestamptz not null default now(),
  note text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.batch_waste_events enable row level security;
create policy "batch waste read scoped" on public.batch_waste_events
  for select to authenticated using ((select app.is_location_member(location_id)));
create trigger audit_batch_waste_events after insert or update or delete on public.batch_waste_events
  for each row execute function public.write_audit();

alter table public.daily_reconciliations
  add column if not exists expected_cash numeric(14,2) not null default 0,
  add column if not exists expected_qris numeric(14,2) not null default 0,
  add column if not exists sales_total numeric(14,2) not null default 0,
  add column if not exists cash_variance numeric(14,2),
  add column if not exists qris_variance numeric(14,2);
create trigger audit_daily_reconciliations after insert or update or delete on public.daily_reconciliations
  for each row execute function public.write_audit();
create trigger audit_stock_counts after insert or update or delete on public.stock_counts
  for each row execute function public.write_audit();

-- A production transaction may only use the recipe version which the Master
-- has explicitly selected as active.  The batch retains that version ID.
create or replace function public.create_production_batch(
  p_location_id uuid,
  p_recipe_version_id uuid,
  p_produced_at timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare
  v_batch uuid;
  v_recipe public.recipe_versions%rowtype;
  v_cost numeric(14,2) := 0;
  v_line record;
  v_line_count integer := 0;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then
    raise exception 'not authorized';
  end if;
  if p_produced_at > now() + interval '5 minutes' then
    raise exception 'production time cannot be in the future';
  end if;

  select rv.* into v_recipe
  from public.recipe_versions rv
  join public.recipes r on r.id = rv.recipe_id
  where rv.id = p_recipe_version_id
    and rv.version = r.active_version
  for share of rv, r;
  if not found then
    raise exception 'only the active Master Recipe version can be produced';
  end if;

  -- Create first so every exact raw-material movement has a durable source.
  insert into public.production_batches(
    location_id, recipe_version_id, produced_at, use_by, batch_cost, created_by
  ) values (
    p_location_id, p_recipe_version_id, p_produced_at,
    p_produced_at + make_interval(days => v_recipe.carry_days), 0, auth.uid()
  ) returning id into v_batch;

  for v_line in
    select l.item_id, l.quantity, i.standard_unit_cost
    from public.recipe_version_lines l
    join public.inventory_items i on i.id = l.item_id
    where l.recipe_version_id = p_recipe_version_id
    order by l.item_id
  loop
    v_line_count := v_line_count + 1;
    perform 1 from public.location_inventory
      where location_id = p_location_id and item_id = v_line.item_id
        and quantity >= v_line.quantity
      for update;
    if not found then
      raise exception 'insufficient inventory for recipe item %', v_line.item_id;
    end if;
    update public.location_inventory
      set quantity = quantity - v_line.quantity, updated_at = now()
      where location_id = p_location_id and item_id = v_line.item_id;
    insert into public.inventory_movements(
      location_id, item_id, quantity, movement_type, source_type, source_id, note, created_by
    ) values (
      p_location_id, v_line.item_id, -v_line.quantity, 'production_use',
      'production_batch', v_batch, '900 ml production', auth.uid()
    );
    v_cost := v_cost + v_line.quantity * v_line.standard_unit_cost;
  end loop;
  if v_line_count = 0 then
    raise exception 'active recipe has no ingredient lines';
  end if;

  update public.production_batches set batch_cost = v_cost where id = v_batch;
  return v_batch;
end $$;

-- A full or daily count is the only route for changing counted on-hand stock.
create or replace function public.record_stock_opname(
  p_location_id uuid,
  p_mode text,
  p_lines jsonb,
  p_counted_at timestamptz default now(),
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare
  v_count uuid;
  v_line jsonb;
  v_item_id uuid;
  v_physical numeric(14,3);
  v_system numeric(14,3);
  v_seen integer;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  if p_mode not in ('daily','full') then raise exception 'invalid count mode'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'count lines are required'; end if;
  select count(*) - count(distinct (entry->>'item_id')) into v_seen from jsonb_array_elements(p_lines) entry;
  if v_seen <> 0 then raise exception 'each inventory item may be counted once'; end if;

  insert into public.stock_counts(location_id, mode, counted_at, created_by)
    values(p_location_id, p_mode, p_counted_at, auth.uid()) returning id into v_count;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    begin
      v_item_id := (v_line->>'item_id')::uuid;
      v_physical := (v_line->>'physical_quantity')::numeric;
    exception when others then raise exception 'each count line requires item_id and physical_quantity';
    end;
    if v_physical < 0 then raise exception 'physical quantity cannot be negative'; end if;
    select quantity into v_system from public.location_inventory
      where location_id = p_location_id and item_id = v_item_id for update;
    if not found then raise exception 'inventory item % is not configured for this location', v_item_id; end if;
    insert into public.stock_count_lines(stock_count_id, item_id, system_quantity, physical_quantity)
      values(v_count, v_item_id, v_system, v_physical);
    if v_system <> v_physical then
      update public.location_inventory set quantity = v_physical, updated_at = now()
        where location_id = p_location_id and item_id = v_item_id;
      insert into public.inventory_movements(
        location_id,item_id,quantity,movement_type,source_type,source_id,note,created_by,created_at
      ) values (
        p_location_id,v_item_id,v_physical-v_system,'opname_adjustment','stock_opname',v_count,p_note,auth.uid(),p_counted_at
      );
    end if;
  end loop;
  return v_count;
end $$;

create or replace function public.record_inventory_waste(
  p_location_id uuid,
  p_item_id uuid,
  p_quantity numeric,
  p_occurred_at timestamptz default now(),
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare v_movement uuid;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  if p_quantity <= 0 then raise exception 'waste quantity must be positive'; end if;
  perform 1 from public.location_inventory
    where location_id=p_location_id and item_id=p_item_id and quantity >= p_quantity for update;
  if not found then raise exception 'insufficient inventory for waste'; end if;
  update public.location_inventory set quantity=quantity-p_quantity, updated_at=now()
    where location_id=p_location_id and item_id=p_item_id;
  insert into public.inventory_movements(
    location_id,item_id,quantity,movement_type,source_type,note,created_by,created_at
  ) values (
    p_location_id,p_item_id,-p_quantity,'waste','inventory_waste',p_note,auth.uid(),p_occurred_at
  ) returning id into v_movement;
  return v_movement;
end $$;

create or replace function public.record_batch_waste(
  p_location_id uuid,
  p_batch_id uuid,
  p_ml_wasted integer,
  p_occurred_at timestamptz default now(),
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare v_batch public.production_batches%rowtype; v_waste uuid; v_cogs numeric(14,2);
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  if p_ml_wasted <= 0 then raise exception 'waste volume must be positive'; end if;
  select * into v_batch from public.production_batches
    where id=p_batch_id and location_id=p_location_id and status in ('open','expired') for update;
  if not found or v_batch.remaining_ml < p_ml_wasted then raise exception 'insufficient prepared batch volume for waste'; end if;
  v_cogs := (p_ml_wasted::numeric / v_batch.initial_ml) * v_batch.batch_cost;
  update public.production_batches set remaining_ml=remaining_ml-p_ml_wasted,
    status=case when remaining_ml-p_ml_wasted=0 then 'wasted' else status end where id=p_batch_id;
  insert into public.batch_waste_events(location_id,batch_id,ml_wasted,cogs,occurred_at,note,created_by)
    values(p_location_id,p_batch_id,p_ml_wasted,v_cogs,p_occurred_at,p_note,auth.uid()) returning id into v_waste;
  return v_waste;
end $$;

create or replace function public.close_daily_reconciliation(
  p_location_id uuid,
  p_business_date date,
  p_opening_cash numeric default 0,
  p_actual_cash numeric default null,
  p_actual_qris numeric default null,
  p_other_cash_in numeric default 0,
  p_cash_refund numeric default 0,
  p_note text default null
) returns public.daily_reconciliations
language plpgsql security definer set search_path = public, auth as $$
declare
  v_timezone text; v_expected_cash numeric(14,2); v_expected_qris numeric(14,2);
  v_sales_total numeric(14,2); v_result public.daily_reconciliations%rowtype;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  if p_business_date > (now() at time zone (select timezone from public.locations where id=p_location_id))::date then
    raise exception 'cannot close a future business date';
  end if;
  if p_opening_cash < 0 or p_other_cash_in < 0 or p_cash_refund < 0 or p_actual_cash < 0 or p_actual_qris < 0 then
    raise exception 'reconciliation amounts cannot be negative';
  end if;
  select timezone into v_timezone from public.locations where id=p_location_id;
  if not found then raise exception 'location not found'; end if;
  if exists(select 1 from public.daily_reconciliations where location_id=p_location_id and business_date=p_business_date and closed_at is not null) then
    raise exception 'this business date is already closed';
  end if;
  select
    coalesce(sum(total) filter (where payment_method='cash'),0) + p_opening_cash + p_other_cash_in - p_cash_refund,
    coalesce(sum(total) filter (where payment_method in ('qris_static','qris_provider')),0),
    coalesce(sum(total),0)
  into v_expected_cash,v_expected_qris,v_sales_total
  from public.sales
  where location_id=p_location_id and (occurred_at at time zone v_timezone)::date=p_business_date;
  insert into public.daily_reconciliations(
    location_id,business_date,opening_cash,actual_cash,actual_qris,other_cash_in,cash_refund,note,closed_by,closed_at,
    expected_cash,expected_qris,sales_total,cash_variance,qris_variance
  ) values (
    p_location_id,p_business_date,p_opening_cash,p_actual_cash,p_actual_qris,p_other_cash_in,p_cash_refund,p_note,auth.uid(),now(),
    v_expected_cash,v_expected_qris,v_sales_total,
    case when p_actual_cash is null then null else p_actual_cash-v_expected_cash end,
    case when p_actual_qris is null then null else p_actual_qris-v_expected_qris end
  ) returning * into v_result;
  return v_result;
end $$;

revoke all on function public.create_production_batch(uuid,uuid,timestamptz) from public, anon;
revoke all on function public.record_stock_opname(uuid,text,jsonb,timestamptz,text) from public, anon;
revoke all on function public.record_inventory_waste(uuid,uuid,numeric,timestamptz,text) from public, anon;
revoke all on function public.record_batch_waste(uuid,uuid,integer,timestamptz,text) from public, anon;
revoke all on function public.close_daily_reconciliation(uuid,date,numeric,numeric,numeric,numeric,numeric,text) from public, anon;
grant execute on function public.create_production_batch(uuid,uuid,timestamptz) to authenticated;
grant execute on function public.record_stock_opname(uuid,text,jsonb,timestamptz,text) to authenticated;
grant execute on function public.record_inventory_waste(uuid,uuid,numeric,timestamptz,text) to authenticated;
grant execute on function public.record_batch_waste(uuid,uuid,integer,timestamptz,text) to authenticated;
grant execute on function public.close_daily_reconciliation(uuid,date,numeric,numeric,numeric,numeric,numeric,text) to authenticated;

-- A version that has produced even one batch is historical evidence. It may be
-- read and audited, but never edited or deleted in place.
create or replace function public.prevent_historical_recipe_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old_version_id uuid;
  v_new_version_id uuid;
begin
  if tg_table_name='recipe_versions' then
    v_old_version_id := case when tg_op='INSERT' then null else old.id end;
    v_new_version_id := new.id;
  else
    v_old_version_id := case when tg_op='INSERT' then null else old.recipe_version_id end;
    v_new_version_id := case when tg_op='DELETE' then null else new.recipe_version_id end;
  end if;
  if exists(select 1 from public.production_batches where recipe_version_id in (v_old_version_id, v_new_version_id)) then
    raise exception 'a recipe version used in production is immutable; publish a new version instead';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function public.prevent_historical_recipe_change() from public, anon, authenticated;
create trigger prevent_historical_recipe_versions before update or delete on public.recipe_versions
  for each row execute function public.prevent_historical_recipe_change();
create trigger prevent_historical_recipe_lines before insert or update or delete on public.recipe_version_lines
  for each row execute function public.prevent_historical_recipe_change();

create index if not exists production_batches_fifo_location_recipe_idx
  on public.production_batches(location_id, recipe_version_id, produced_at)
  where status='open';
create index if not exists sales_location_occurred_at_idx on public.sales(location_id, occurred_at);
create index if not exists inventory_movements_location_item_created_idx on public.inventory_movements(location_id,item_id,created_at desc);
create index if not exists batch_waste_events_location_occurred_idx on public.batch_waste_events(location_id,occurred_at desc);
