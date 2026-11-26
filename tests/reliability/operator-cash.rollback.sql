-- Run after the migration in a transaction-capable PostgreSQL client.
-- All users, carts, sales, counts, and cash entries below are disposable and
-- unconditionally rolled back. Never remove BEGIN/ROLLBACK from this test.
begin;

do $$
declare
  v_user uuid := gen_random_uuid(); v_location uuid := gen_random_uuid(); v_other_location uuid := gen_random_uuid();
  v_income_request uuid := gen_random_uuid(); v_expense_request uuid := gen_random_uuid();
  v_today date; v_past date; v_day jsonb; v_again jsonb; v_count integer;
  v_close public.daily_reconciliations%rowtype; v_before jsonb;
begin
  insert into auth.users(id,email,aud,role,created_at,updated_at)
    values(v_user,'cash-test-'||v_user::text||'@example.invalid','authenticated','authenticated',now(),now());
  insert into public.locations(id,code,name,city,timezone)
    values(v_location,'CASH-TEST-'||v_location::text,'Disposable cash test','Test','Asia/Jakarta'),
      (v_other_location,'CASH-TEST-'||v_other_location::text,'Disposable other cart','Test','Asia/Jakarta');
  insert into public.memberships(user_id,location_id,role,display_name)
    values(v_user,v_location,'operator','Disposable cash tester');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_user::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  v_today := (clock_timestamp() at time zone 'Asia/Jakarta')::date;
  v_past := v_today - 1;

  v_day := public.get_operator_cash_day(v_location,null);
  if v_day->>'business_date' <> v_today::text or v_day->>'timezone' <> 'Asia/Jakarta'
    or (v_day->>'is_open')::boolean or v_day->>'day_id' is not null then
    raise exception 'FAILED: unopened day or local date read';
  end if;
  begin
    perform public.get_operator_cash_day(v_other_location,null);
    raise exception 'FAILED: expected cart access denial';
  exception when others then if sqlerrm not like '%not authorized%' then raise; end if; end;
  begin
    perform public.record_cash_movement(v_location,v_today,'income',1000,'Before opening',gen_random_uuid());
    raise exception 'FAILED: expected opening prerequisite';
  exception when others then if sqlerrm not like '%record opening cash%' then raise; end if; end;
  begin
    perform public.begin_operator_day(v_location,v_today+1,100000);
    raise exception 'FAILED: expected local date guard';
  exception when others then if sqlerrm not like '%current local business date%' then raise; end if; end;
  begin
    perform public.begin_operator_day(v_location,v_today,-1);
    raise exception 'FAILED: expected negative opening rejection';
  exception when others then if sqlerrm not like '%invalid opening cash%' then raise; end if; end;

  v_day := public.begin_operator_day(v_location,v_today,100000);
  v_again := public.begin_operator_day(v_location,v_today,100000);
  select count(*) into v_count from public.operator_days where location_id=v_location and business_date=v_today;
  if v_count<>1 or v_day->>'day_id' is null or v_day->>'day_id'<>v_again->>'day_id'
    or not (v_day->>'is_open')::boolean then raise exception 'FAILED: opening natural idempotency'; end if;
  begin
    perform public.begin_operator_day(v_location,v_today,200000);
    raise exception 'FAILED: expected immutable opening';
  exception when others then if sqlerrm not like '%cannot be changed%' then raise; end if; end;

  v_day := public.record_cash_movement(v_location,v_today,'income',20000,'Additional float',v_income_request);
  v_again := public.record_cash_movement(v_location,v_today,'income',20000,'  Additional float  ',v_income_request);
  if (v_again->>'income_total')::numeric <> 20000 or jsonb_array_length(v_again->'movements')<>1 then
    raise exception 'FAILED: movement retry counted twice';
  end if;
  begin
    perform public.record_cash_movement(v_location,v_today,'income',20001,'Additional float',v_income_request);
    raise exception 'FAILED: expected idempotency payload conflict';
  exception when others then if sqlerrm not like '%different cash movement details%' then raise; end if; end;
  begin
    perform public.record_cash_movement(v_location,v_today,'expense',0,'Invalid zero',gen_random_uuid());
    raise exception 'FAILED: expected positive amount';
  exception when others then if sqlerrm not like '%amount must be positive%' then raise; end if; end;
  begin
    perform public.record_cash_movement(v_location,v_today,'expense','NaN'::numeric,'Invalid number',gen_random_uuid());
    raise exception 'FAILED: expected finite amount';
  exception when others then if sqlerrm not like '%amount must be positive%' then raise; end if; end;
  begin
    perform public.record_cash_movement(v_location,v_today,'expense',1.001,'Invalid precision',gen_random_uuid());
    raise exception 'FAILED: expected currency precision';
  exception when others then if sqlerrm not like '%amount must be positive%' then raise; end if; end;
  begin
    perform public.record_cash_movement(v_location,v_today,'expense',1000,'  ',gen_random_uuid());
    raise exception 'FAILED: expected movement reason';
  exception when others then if sqlerrm not like '%a reason are required%' then raise; end if; end;
  begin
    perform public.record_cash_movement(v_location,v_today-1,'expense',1000,'Past expense',gen_random_uuid());
    raise exception 'FAILED: expected movement local date guard';
  exception when others then if sqlerrm not like '%current local business date%' then raise; end if; end;
  v_day := public.record_cash_movement(v_location,v_today,'expense',5000,'Ice purchase',v_expense_request);
  if (v_day->>'income_total')::numeric<>20000 or (v_day->>'expense_total')::numeric<>5000
    or jsonb_array_length(v_day->'movements')<>2 then raise exception 'FAILED: income/expense totals'; end if;

  insert into public.sales(location_id,quantity,total,cogs,payment_method,occurred_at,source)
    values(v_location,1,150000,0,'cash',clock_timestamp(),'manual'),
      (v_location,1,40000,0,'qris_static',clock_timestamp(),'manual');
  begin
    perform public.close_daily_reconciliation(v_location,v_today,100000,258000,40000,0,7000,'Test close');
    raise exception 'FAILED: expected stock opname prerequisite';
  exception when others then if sqlerrm not like '%stock opname wajib%' then raise; end if; end;
  insert into public.stock_counts(location_id,mode,counted_at,created_by)
    values(v_location,'daily',clock_timestamp(),v_user);
  begin
    perform public.close_daily_reconciliation(v_location,v_today,99999,258000,40000,0,7000,'Wrong opening');
    raise exception 'FAILED: expected saved opening match';
  exception when others then if sqlerrm not like '%does not match the saved opening%' then raise; end if; end;
  begin
    perform public.close_daily_reconciliation(v_location,v_today,100000,258000,40000,20000,7000,'Duplicate income');
    raise exception 'FAILED: expected duplicate-income prevention';
  exception when others then if sqlerrm not like '%record other cash in as a cash movement%' then raise; end if; end;
  v_close := public.close_daily_reconciliation(v_location,v_today,100000,258000,40000,0,7000,'Test close');
  if v_close.expected_cash<>258000 or v_close.expected_qris<>40000 or v_close.cash_variance<>0
    or v_close.qris_variance<>0 or v_close.cash_income_total<>20000 or v_close.cash_expense_total<>5000
    or v_close.opening_cash<>100000 or v_close.other_cash_in<>0 or v_close.cash_day_id is null then
    raise exception 'FAILED: closing formula or saved movement snapshot';
  end if;
  v_before := to_jsonb(v_close);
  begin
    perform public.record_cash_movement(v_location,v_today,'expense',1000,'After close',gen_random_uuid());
    raise exception 'FAILED: expected closed movement rejection';
  exception when others then if sqlerrm not like '%already closed%' then raise; end if; end;
  begin
    perform public.begin_operator_day(v_location,v_today,100000);
    raise exception 'FAILED: expected closed opening rejection';
  exception when others then if sqlerrm not like '%already closed%' then raise; end if; end;
  begin
    perform public.close_daily_reconciliation(v_location,v_today,100000,258000,40000,0,7000,'Duplicate close');
    raise exception 'FAILED: expected duplicate close rejection';
  exception when others then if sqlerrm not like '%already closed%' then raise; end if; end;
  v_day := public.record_cash_movement(v_location,v_today,'income',20000,'Additional float',v_income_request);
  if not (v_day->>'is_closed')::boolean or (v_day->>'is_open')::boolean
    or jsonb_array_length(v_day->'movements')<>2 then raise exception 'FAILED: committed retry after close'; end if;
  select * into v_close from public.daily_reconciliations where location_id=v_location and business_date=v_today;
  if v_before<>to_jsonb(v_close) then raise exception 'FAILED: closing history changed after duplicate request'; end if;

  -- Legacy dates retain their explicit opening/other/refund calculation.
  insert into public.stock_counts(location_id,mode,counted_at,created_by)
    values(v_location,'daily',(v_past+time '12:00') at time zone 'Asia/Jakarta',v_user);
  insert into public.sales(location_id,quantity,total,cogs,payment_method,occurred_at,source)
    values(v_location,1,20000,0,'cash',(v_past+time '12:00') at time zone 'Asia/Jakarta','manual');
  v_close := public.close_daily_reconciliation(v_location,v_past,5000,24000,0,1000,2000,'Legacy close');
  if v_close.expected_cash<>24000 or v_close.cash_day_id is not null
    or v_close.cash_income_total<>0 or v_close.cash_expense_total<>0 or v_close.other_cash_in<>1000 then
    raise exception 'FAILED: legacy closing compatibility';
  end if;
  select count(*) into v_count from public.operator_days where location_id=v_location;
  if v_count<>1 then raise exception 'FAILED: legacy day was backfilled'; end if;

  -- Later imported cash keeps the original snapshot and flags it for review.
  insert into public.sales(location_id,quantity,total,cogs,payment_method,occurred_at,source)
    values(v_location,1,1000,0,'cash',clock_timestamp(),'manual');
  select * into v_close from public.daily_reconciliations where location_id=v_location and business_date=v_today;
  if v_close.invalidated_at is null or v_close.expected_cash<>258000 or v_close.cash_expense_total<>5000 then
    raise exception 'FAILED: late sale invalidation or immutable snapshot';
  end if;

  -- Read business-date defaults from the location, never session/UTC timezone.
  update public.locations set timezone='Pacific/Kiritimati' where id=v_location;
  v_day := public.get_operator_cash_day(v_location,null);
  if v_day->>'business_date' <> ((now() at time zone 'Pacific/Kiritimati')::date)::text
    or v_day->>'timezone'<>'Pacific/Kiritimati' then raise exception 'FAILED: location timezone'; end if;

  if has_table_privilege('authenticated','public.operator_days','INSERT')
    or has_table_privilege('authenticated','public.operator_cash_movements','INSERT')
    or has_table_privilege('authenticated','public.operator_cash_movements','UPDATE')
    or has_table_privilege('authenticated','public.operator_cash_movements','DELETE') then
    raise exception 'FAILED: direct operator cash mutation privilege';
  end if;
  if has_function_privilege('anon','public.begin_operator_day(uuid,date,numeric)','EXECUTE')
    or not has_function_privilege('authenticated','public.record_cash_movement(uuid,date,text,numeric,text,uuid)','EXECUTE') then
    raise exception 'FAILED: cash RPC execution privileges';
  end if;
  raise notice 'Operator cash tests passed; all disposable fixtures will be rolled back.';
end $$;

rollback;
