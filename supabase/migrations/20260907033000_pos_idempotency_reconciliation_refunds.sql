-- POS identity is connection-scoped. Receipt IDs are only unique inside the
-- provider account/connection, not across a cart's connection history.
alter table public.sales add column if not exists pos_connection_id uuid
  references public.pos_connections(id) on delete restrict;
alter table public.sales drop constraint if exists sales_location_id_external_id_key;
create unique index if not exists sales_pos_connection_external_id_key
  on public.sales(pos_connection_id, external_id)
  where pos_connection_id is not null and external_id is not null;
create unique index if not exists sales_non_pos_location_external_id_key
  on public.sales(location_id, external_id)
  where pos_connection_id is null and external_id is not null;
create index if not exists sales_pos_connection_occurred_at_idx
  on public.sales(pos_connection_id, occurred_at desc)
  where pos_connection_id is not null;

-- POS import entry point. Human operator transactions remain separate from
-- provider imports, and only the server service-role may call this function.
create or replace function public.record_pos_sale(
  p_pos_connection_id uuid,
  p_recipe_id uuid,
  p_quantity integer,
  p_total numeric,
  p_payment public.payment_method,
  p_occurred_at timestamptz,
  p_external_id text
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare
  v_location_id uuid; v_sale uuid; v_left integer := p_quantity*150; v_take integer;
  v_batch record; v_cogs numeric(14,2) := 0; v_pack record; v_pack_count integer := 0;
begin
  if not app.is_service_role() then raise exception 'not authorized'; end if;
  if p_quantity <= 0 or p_total < 0 or coalesce(trim(p_external_id),'')='' then raise exception 'invalid sale'; end if;
  select location_id into v_location_id from public.pos_connections
    where id=p_pos_connection_id and provider='loyverse' and is_active for share;
  if not found then raise exception 'POS connection is not active'; end if;
  if exists(select 1 from public.sales where pos_connection_id=p_pos_connection_id and external_id=p_external_id) then
    return (select id from public.sales where pos_connection_id=p_pos_connection_id and external_id=p_external_id);
  end if;
  for v_pack in select li.item_id,li.quantity,i.standard_unit_cost from public.location_inventory li
    join public.inventory_items i on i.id=li.item_id
    where li.location_id=v_location_id and i.sku in ('CUP-12OZ','LID-12OZ') for update loop
    v_pack_count := v_pack_count+1;
    if v_pack.quantity < p_quantity then raise exception 'insufficient packaging'; end if;
    v_cogs := v_cogs + p_quantity*v_pack.standard_unit_cost;
  end loop;
  if v_pack_count <> 2 then raise exception 'required cup and lid inventory is not configured'; end if;
  insert into public.sales(location_id,pos_connection_id,external_id,product_recipe_id,quantity,total,cogs,payment_method,occurred_at,source)
    values(v_location_id,p_pos_connection_id,p_external_id,p_recipe_id,p_quantity,p_total,0,p_payment,p_occurred_at,'loyverse')
    returning id into v_sale;
  for v_batch in select b.* from public.production_batches b
    join public.recipe_versions rv on rv.id=b.recipe_version_id
    where b.location_id=v_location_id and rv.recipe_id=p_recipe_id and b.status='open'
      and b.produced_at<=p_occurred_at and b.use_by>=p_occurred_at
    order by b.produced_at,b.id for update loop
    exit when v_left=0;
    v_take:=least(v_left,v_batch.remaining_ml);
    update public.production_batches set remaining_ml=remaining_ml-v_take,
      status=case when remaining_ml-v_take=0 then 'consumed' else 'open' end where id=v_batch.id;
    insert into public.sale_batch_allocations(sale_id,batch_id,ml_used,cogs)
      values(v_sale,v_batch.id,v_take,(v_take::numeric/v_batch.initial_ml)*v_batch.batch_cost);
    v_cogs:=v_cogs+(v_take::numeric/v_batch.initial_ml)*v_batch.batch_cost;
    v_left:=v_left-v_take;
  end loop;
  if v_left>0 then raise exception 'insufficient FIFO batch volume'; end if;
  for v_pack in select li.item_id from public.location_inventory li
    join public.inventory_items i on i.id=li.item_id
    where li.location_id=v_location_id and i.sku in ('CUP-12OZ','LID-12OZ') for update loop
    update public.location_inventory set quantity=quantity-p_quantity,updated_at=now()
      where location_id=v_location_id and item_id=v_pack.item_id;
    insert into public.inventory_movements(location_id,item_id,quantity,movement_type,source_type,source_id,note,created_by)
      values(v_location_id,v_pack.item_id,-p_quantity,'sale_packaging','sale',v_sale,'POS sale',null);
  end loop;
  update public.sales set cogs=v_cogs where id=v_sale;
  return v_sale;
end $$;
revoke all on function public.record_pos_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) from public, anon, authenticated;
grant execute on function public.record_pos_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) to service_role;

-- A receipt imported after its operating day was closed cannot silently leave
-- that reconciliation looking final. The operator must review/reclose it.
alter table public.daily_reconciliations
  add column if not exists invalidated_at timestamptz,
  add column if not exists invalidation_reason text;
create or replace function public.invalidate_reconciliation_for_late_sale()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_timezone text; v_business_date date;
begin
  select timezone into v_timezone from public.locations where id=new.location_id;
  v_business_date := (new.occurred_at at time zone v_timezone)::date;
  update public.daily_reconciliations
    set invalidated_at=now(),
        invalidation_reason='Ada penjualan POS yang masuk setelah hari ditutup.'
    where location_id=new.location_id and business_date=v_business_date and closed_at is not null;
  return new;
end $$;
revoke all on function public.invalidate_reconciliation_for_late_sale() from public, anon, authenticated;
drop trigger if exists invalidate_reconciliation_for_late_sale on public.sales;
create trigger invalidate_reconciliation_for_late_sale after insert on public.sales
  for each row execute function public.invalidate_reconciliation_for_late_sale();

-- Refund classification records the physical result. Restoring a sale puts its
-- prepared volume and cup/lid back only when the product was not prepared.
alter table public.refund_resolutions
  add column if not exists quantity integer not null default 1,
  add column if not exists inventory_effect text not null default 'pending',
  add column if not exists cogs numeric(14,2) not null default 0;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='refund_resolutions_quantity_positive') then
    alter table public.refund_resolutions add constraint refund_resolutions_quantity_positive check (quantity > 0);
  end if;
end $$;
create table if not exists public.refund_batch_restorations (
  id uuid primary key default gen_random_uuid(),
  refund_resolution_id uuid not null references public.refund_resolutions(id) on delete cascade,
  batch_id uuid not null references public.production_batches(id) on delete restrict,
  ml_restored integer not null check(ml_restored > 0),
  cogs numeric(14,2) not null check(cogs >= 0),
  unique(refund_resolution_id,batch_id)
);
alter table public.refund_batch_restorations enable row level security;
create policy "refund restoration read scoped" on public.refund_batch_restorations for select to authenticated using (
  exists(select 1 from public.refund_resolutions rr join public.sales s on s.id=rr.sale_id
    where rr.id=refund_resolution_id and app.is_location_member(s.location_id))
);
create trigger audit_refund_resolutions after insert or update or delete on public.refund_resolutions
  for each row execute function public.write_audit();

create or replace function public.resolve_sale_refund(
  p_sale_id uuid,
  p_quantity integer,
  p_outcome text,
  p_reason text default null
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare
  v_sale public.sales%rowtype; v_resolution uuid; v_remaining integer := p_quantity*150;
  v_allocation record; v_take integer; v_cogs numeric(14,2) := 0; v_existing integer;
  v_pack_count integer := 0; v_pack record;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if p_quantity<=0 or p_outcome not in ('not_prepared_restore','prepared_discarded_waste','other') then raise exception 'invalid refund outcome'; end if;
  if p_outcome='other' and coalesce(trim(p_reason),'')='' then raise exception 'a reason is required for other'; end if;
  select * into v_sale from public.sales where id=p_sale_id for update;
  if not found or not app.is_location_member(v_sale.location_id) then raise exception 'not authorized'; end if;
  select coalesce(sum(quantity),0) into v_existing from public.refund_resolutions where sale_id=p_sale_id;
  if v_existing+p_quantity>v_sale.quantity then raise exception 'refund quantity exceeds the original sale'; end if;
  v_cogs := (v_sale.cogs*p_quantity::numeric)/v_sale.quantity;
  insert into public.refund_resolutions(sale_id,outcome,reason,resolved_by,quantity,inventory_effect,cogs)
    values(p_sale_id,p_outcome,nullif(trim(p_reason),''),auth.uid(),p_quantity,
      case when p_outcome='not_prepared_restore' then 'restored' when p_outcome='prepared_discarded_waste' then 'waste_recorded' else 'none' end,v_cogs)
    returning id into v_resolution;
  if p_outcome='not_prepared_restore' then
    for v_allocation in
      select a.batch_id,a.ml_used,a.cogs,b.remaining_ml,b.initial_ml,b.status,b.batch_cost,
        coalesce((select sum(rbr.ml_restored) from public.refund_batch_restorations rbr
          join public.refund_resolutions rr on rr.id=rbr.refund_resolution_id
          where rr.sale_id=p_sale_id and rbr.batch_id=a.batch_id),0) as restored_ml
      from public.sale_batch_allocations a join public.production_batches b on b.id=a.batch_id
      where a.sale_id=p_sale_id order by b.produced_at,b.id for update of b
    loop
      exit when v_remaining=0;
      v_take:=least(v_remaining,v_allocation.ml_used-v_allocation.restored_ml);
      if v_take<=0 then continue; end if;
      if v_allocation.status not in ('open','consumed') or v_allocation.remaining_ml+v_take>v_allocation.initial_ml then
        raise exception 'prepared batch can no longer be restored automatically';
      end if;
      update public.production_batches set remaining_ml=remaining_ml+v_take,status='open' where id=v_allocation.batch_id;
      insert into public.refund_batch_restorations(refund_resolution_id,batch_id,ml_restored,cogs)
        values(v_resolution,v_allocation.batch_id,v_take,(v_take::numeric/v_allocation.initial_ml)*v_allocation.batch_cost);
      v_remaining:=v_remaining-v_take;
    end loop;
    if v_remaining>0 then raise exception 'refund has no restorable prepared-batch allocation'; end if;
    for v_pack in select li.item_id from public.location_inventory li join public.inventory_items i on i.id=li.item_id
      where li.location_id=v_sale.location_id and i.sku in ('CUP-12OZ','LID-12OZ') for update loop
      v_pack_count:=v_pack_count+1;
      update public.location_inventory set quantity=quantity+p_quantity,updated_at=now()
        where location_id=v_sale.location_id and item_id=v_pack.item_id;
      insert into public.inventory_movements(location_id,item_id,quantity,movement_type,source_type,source_id,note,created_by)
        values(v_sale.location_id,v_pack.item_id,p_quantity,'return','sale_refund',v_resolution,'Produk tidak dibuat',auth.uid());
    end loop;
    if v_pack_count<>2 then raise exception 'cup and lid inventory must be configured for restoration'; end if;
  end if;
  insert into public.audit_logs(location_id,actor_id,action,entity_type,entity_id,after_data)
    values(v_sale.location_id,auth.uid(),'RESOLVE_REFUND','refund_resolution',v_resolution,
      jsonb_build_object('sale_id',p_sale_id,'quantity',p_quantity,'outcome',p_outcome,'inventory_effect',
        case when p_outcome='not_prepared_restore' then 'restored' when p_outcome='prepared_discarded_waste' then 'waste_recorded' else 'none' end));
  return v_resolution;
end $$;
revoke all on function public.resolve_sale_refund(uuid,integer,text,text) from public, anon;
grant execute on function public.resolve_sale_refund(uuid,integer,text,text) to authenticated;
create index if not exists refund_resolutions_sale_id_idx on public.refund_resolutions(sale_id);
