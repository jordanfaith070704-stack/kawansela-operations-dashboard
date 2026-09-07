-- A daily close is only reliable after the operator has recorded physical stock
-- for that location's operational day. This guard applies to every caller,
-- including direct database/RPC access.
create or replace function public.require_stock_opname_before_close()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_timezone text;
begin
  if new.closed_at is null or (tg_op = 'UPDATE' and old.closed_at is not null) then
    return new;
  end if;

  select timezone into v_timezone
  from public.locations
  where id = new.location_id;

  if v_timezone is null then
    raise exception 'location not found';
  end if;

  if not exists (
    select 1
    from public.stock_counts sc
    where sc.location_id = new.location_id
      and (sc.counted_at at time zone v_timezone)::date = new.business_date
  ) then
    raise exception 'stock opname wajib diselesaikan sebelum tutup hari';
  end if;

  return new;
end;
$$;

revoke all on function public.require_stock_opname_before_close() from public, anon, authenticated;

drop trigger if exists require_stock_opname_before_close on public.daily_reconciliations;
create trigger require_stock_opname_before_close
before insert or update of closed_at on public.daily_reconciliations
for each row
execute function public.require_stock_opname_before_close();
