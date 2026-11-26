-- Durable operator opening cash and an append-only cash ledger.
-- No historical reconciliations or balances are backfilled or rewritten.
create table public.operator_days (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete restrict,
  business_date date not null,
  opening_cash numeric(14,2) not null check (opening_cash >= 0 and opening_cash <> 'NaN'::numeric),
  opened_by uuid not null references auth.users(id),
  opened_at timestamptz not null default clock_timestamp(),
  unique (location_id,business_date)
);

create table public.operator_cash_movements (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  business_date date not null,
  kind text not null check (kind in ('income','expense')),
  amount numeric(14,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
  reason text not null check (length(trim(reason)) between 1 and 500),
  request_id uuid not null,
  occurred_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references auth.users(id),
  foreign key (location_id,business_date) references public.operator_days(location_id,business_date) on delete restrict,
  unique (location_id,request_id)
);
create index operator_cash_movements_day_idx
  on public.operator_cash_movements(location_id,business_date,occurred_at,id);

alter table public.operator_days enable row level security;
alter table public.operator_cash_movements enable row level security;
revoke all on public.operator_days, public.operator_cash_movements from public, anon, authenticated;
grant select on public.operator_days, public.operator_cash_movements to authenticated;
create policy "operator days read scoped" on public.operator_days
  for select to authenticated using ((select app.is_location_member(location_id)));
create policy "operator cash movements read scoped" on public.operator_cash_movements
  for select to authenticated using ((select app.is_location_member(location_id)));
create trigger audit_operator_days after insert or update or delete on public.operator_days
  for each row execute function public.write_audit();
create trigger audit_operator_cash_movements after insert or update or delete on public.operator_cash_movements
  for each row execute function public.write_audit();

alter table public.daily_reconciliations
  add column cash_day_id uuid references public.operator_days(id) on delete restrict,
  add column cash_income_total numeric(14,2) not null default 0,
  add column cash_expense_total numeric(14,2) not null default 0;

create or replace function public.get_operator_cash_day(
  p_location_id uuid,
  p_business_date date default null
) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_timezone text; v_date date; v_day public.operator_days%rowtype;
  v_closed boolean; v_income numeric(14,2); v_expense numeric(14,2); v_movements jsonb;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  select timezone into v_timezone from public.locations where id=p_location_id;
  if not found then raise exception 'location not found'; end if;
  v_date := coalesce(p_business_date,(now() at time zone v_timezone)::date);
  select * into v_day from public.operator_days where location_id=p_location_id and business_date=v_date;
  select exists(select 1 from public.daily_reconciliations
    where location_id=p_location_id and business_date=v_date and closed_at is not null) into v_closed;
  select coalesce(sum(amount) filter (where kind='income'),0),
    coalesce(sum(amount) filter (where kind='expense'),0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'kind',kind,'amount',amount,'reason',reason,'occurred_at',occurred_at,
      'created_by',created_by,'request_id',request_id) order by occurred_at desc,id desc),'[]'::jsonb)
  into v_income,v_expense,v_movements from public.operator_cash_movements
  where location_id=p_location_id and business_date=v_date;
  return jsonb_build_object('business_date',v_date,'timezone',v_timezone,
    'day_id',v_day.id,'opening_cash',v_day.opening_cash,'opened_at',v_day.opened_at,
    'opened_by',v_day.opened_by,'is_open',v_day.id is not null and not v_closed,'is_closed',v_closed,
    'income_total',v_income,'expense_total',v_expense,'movements',v_movements);
end $$;

create or replace function public.begin_operator_day(
  p_location_id uuid,
  p_business_date date,
  p_opening_cash numeric
) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare v_timezone text; v_active boolean; v_day public.operator_days%rowtype;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  if p_opening_cash is null or p_opening_cash::text in ('NaN','Infinity','-Infinity')
    or p_opening_cash < 0 or p_opening_cash > 999999999999.99
    or p_opening_cash <> round(p_opening_cash,2) then raise exception 'invalid opening cash'; end if;
  -- All opening, movement, and closing writes take the same cart lock.
  select timezone,is_active into v_timezone,v_active from public.locations where id=p_location_id for update;
  if not found or not v_active then raise exception 'location is not active'; end if;
  if exists(select 1 from public.daily_reconciliations
    where location_id=p_location_id and business_date=p_business_date and closed_at is not null) then
    raise exception 'this business date is already closed';
  end if;
  select * into v_day from public.operator_days where location_id=p_location_id and business_date=p_business_date;
  if found then
    if v_day.opening_cash <> p_opening_cash then raise exception 'opening cash is already recorded and cannot be changed'; end if;
    return public.get_operator_cash_day(p_location_id,p_business_date);
  end if;
  if p_business_date is null or p_business_date <> (clock_timestamp() at time zone v_timezone)::date then
    raise exception 'opening cash must be recorded for the current local business date';
  end if;
  insert into public.operator_days(location_id,business_date,opening_cash,opened_by)
    values(p_location_id,p_business_date,p_opening_cash,auth.uid());
  return public.get_operator_cash_day(p_location_id,p_business_date);
end $$;

create or replace function public.record_cash_movement(
  p_location_id uuid,
  p_business_date date,
  p_kind text,
  p_amount numeric,
  p_reason text,
  p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare v_timezone text; v_active boolean; v_existing public.operator_cash_movements%rowtype;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  if p_kind is null or p_kind not in ('income','expense') then raise exception 'invalid cash movement kind'; end if;
  if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity')
    or p_amount <= 0 or p_amount > 999999999999.99 or p_amount <> round(p_amount,2) then
    raise exception 'cash movement amount must be positive with at most two decimals';
  end if;
  if p_request_id is null or p_business_date is null or p_reason is null or length(trim(p_reason)) not between 1 and 500 then
    raise exception 'request id, business date, and a reason are required';
  end if;
  select timezone,is_active into v_timezone,v_active from public.locations where id=p_location_id for update;
  if not found or not v_active then raise exception 'location is not active'; end if;
  select * into v_existing from public.operator_cash_movements where location_id=p_location_id and request_id=p_request_id;
  if found then
    if v_existing.business_date <> p_business_date or v_existing.kind <> p_kind
      or v_existing.amount <> p_amount or v_existing.reason <> trim(p_reason) then
      raise exception 'request id was already used with different cash movement details';
    end if;
    -- A retry of an already committed action remains safe after day close or
    -- midnight. No second movement is created and no past data is changed.
    return public.get_operator_cash_day(p_location_id,p_business_date);
  end if;
  if p_business_date <> (clock_timestamp() at time zone v_timezone)::date then
    raise exception 'cash movements must use the current local business date';
  end if;
  if exists(select 1 from public.daily_reconciliations
    where location_id=p_location_id and business_date=p_business_date and closed_at is not null) then
    raise exception 'this business date is already closed';
  end if;
  if not exists(select 1 from public.operator_days where location_id=p_location_id and business_date=p_business_date) then
    raise exception 'record opening cash before cash movements';
  end if;
  insert into public.operator_cash_movements(location_id,business_date,kind,amount,reason,request_id,created_by)
    values(p_location_id,p_business_date,p_kind,p_amount,trim(p_reason),p_request_id,auth.uid());
  return public.get_operator_cash_day(p_location_id,p_business_date);
end $$;

-- Preserve the existing caller signature and physical-refund handling. The
-- refund_resolutions table classifies product/stock outcomes, not cash refunds;
-- it is deliberately not subtracted a second time here.
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
  v_timezone text; v_active boolean; v_day public.operator_days%rowtype; v_has_day boolean;
  v_opening numeric(14,2); v_income numeric(14,2) := 0; v_expense numeric(14,2) := 0;
  v_cash_sales numeric(14,2); v_expected_cash numeric(14,2); v_expected_qris numeric(14,2);
  v_sales_total numeric(14,2); v_result public.daily_reconciliations%rowtype; v_amount numeric;
begin
  if auth.uid() is null or not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  select timezone,is_active into v_timezone,v_active from public.locations where id=p_location_id for update;
  if not found or not v_active then raise exception 'location is not active'; end if;
  if p_business_date is null or p_business_date > (clock_timestamp() at time zone v_timezone)::date then
    raise exception 'cannot close a future or missing business date';
  end if;
  if p_opening_cash is null or p_other_cash_in is null or p_cash_refund is null then
    raise exception 'opening cash, other cash in, and cash refund are required';
  end if;
  foreach v_amount in array array[p_opening_cash,p_actual_cash,p_actual_qris,p_other_cash_in,p_cash_refund] loop
    if v_amount is not null and (v_amount::text in ('NaN','Infinity','-Infinity')
      or v_amount < 0 or v_amount > 999999999999.99 or v_amount <> round(v_amount,2)) then
      raise exception 'invalid reconciliation amount';
    end if;
  end loop;
  if exists(select 1 from public.daily_reconciliations
    where location_id=p_location_id and business_date=p_business_date and closed_at is not null) then
    raise exception 'this business date is already closed';
  end if;
  select * into v_day from public.operator_days where location_id=p_location_id and business_date=p_business_date;
  v_has_day := found;
  if v_has_day then
    if p_opening_cash <> v_day.opening_cash then raise exception 'opening cash does not match the saved opening'; end if;
    if p_other_cash_in <> 0 then raise exception 'record other cash in as a cash movement before closing'; end if;
    if p_actual_cash is null or p_actual_qris is null then raise exception 'actual cash and QRIS counts are required'; end if;
    v_opening := v_day.opening_cash;
    select coalesce(sum(amount) filter (where kind='income'),0), coalesce(sum(amount) filter (where kind='expense'),0)
      into v_income,v_expense from public.operator_cash_movements where location_id=p_location_id and business_date=p_business_date;
  else
    if p_business_date = (clock_timestamp() at time zone v_timezone)::date then raise exception 'record opening cash before closing'; end if;
    -- Past days without a durable opening retain the legacy formula. Existing
    -- closed rows are never changed and no legacy balances are manufactured.
    v_opening := p_opening_cash;
  end if;
  select coalesce(sum(total) filter (where payment_method='cash'),0),
    coalesce(sum(total) filter (where payment_method in ('qris_static','qris_provider')),0),coalesce(sum(total),0)
    into v_cash_sales,v_expected_qris,v_sales_total from public.sales
    where location_id=p_location_id and (occurred_at at time zone v_timezone)::date=p_business_date;
  v_expected_cash := v_opening + v_cash_sales + v_income - v_expense + p_other_cash_in - p_cash_refund;
  insert into public.daily_reconciliations(
    location_id,business_date,opening_cash,actual_cash,actual_qris,other_cash_in,cash_refund,note,closed_by,closed_at,
    expected_cash,expected_qris,sales_total,cash_variance,qris_variance,cash_day_id,cash_income_total,cash_expense_total
  ) values (
    p_location_id,p_business_date,v_opening,p_actual_cash,p_actual_qris,p_other_cash_in,p_cash_refund,p_note,auth.uid(),clock_timestamp(),
    v_expected_cash,v_expected_qris,v_sales_total,
    case when p_actual_cash is null then null else p_actual_cash-v_expected_cash end,
    case when p_actual_qris is null then null else p_actual_qris-v_expected_qris end,v_day.id,v_income,v_expense
  ) returning * into v_result;
  return v_result;
end $$;

-- A POS insert and day close must use the same cart lock. Otherwise a receipt
-- inserted between SUM(sales) and the close INSERT can escape invalidation.
create or replace function public.invalidate_reconciliation_for_late_sale()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_timezone text; v_business_date date;
begin
  select timezone into v_timezone from public.locations where id=new.location_id for update;
  v_business_date := (new.occurred_at at time zone v_timezone)::date;
  update public.daily_reconciliations
    set invalidated_at=now(),invalidation_reason='Ada penjualan POS yang masuk setelah hari ditutup.'
    where location_id=new.location_id and business_date=v_business_date and closed_at is not null;
  return new;
end $$;

revoke all on function public.get_operator_cash_day(uuid,date) from public, anon;
revoke all on function public.begin_operator_day(uuid,date,numeric) from public, anon;
revoke all on function public.record_cash_movement(uuid,date,text,numeric,text,uuid) from public, anon;
revoke all on function public.close_daily_reconciliation(uuid,date,numeric,numeric,numeric,numeric,numeric,text) from public, anon;
revoke all on function public.invalidate_reconciliation_for_late_sale() from public, anon, authenticated;
grant execute on function public.get_operator_cash_day(uuid,date) to authenticated;
grant execute on function public.begin_operator_day(uuid,date,numeric) to authenticated;
grant execute on function public.record_cash_movement(uuid,date,text,numeric,text,uuid) to authenticated;
grant execute on function public.close_daily_reconciliation(uuid,date,numeric,numeric,numeric,numeric,numeric,text) to authenticated;
