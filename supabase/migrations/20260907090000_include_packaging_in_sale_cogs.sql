-- Every paid cup consumes packaging as well as prepared-batch volume.
-- Record packaging cost in the sale COGS while preserving FIFO batch COGS.
create or replace function public.record_sale(
  p_location_id uuid,
  p_recipe_id uuid,
  p_quantity integer,
  p_total numeric,
  p_payment public.payment_method,
  p_occurred_at timestamptz,
  p_external_id text default null
) returns uuid
language plpgsql security definer set search_path = public, auth as $function$
declare
  v_sale uuid;
  v_left integer := p_quantity * 150;
  v_take integer;
  v_batch record;
  v_cogs numeric := 0;
  v_pack record;
  v_packaging_cogs numeric := 0;
begin
  if p_quantity <= 0 or not (app.is_location_member(p_location_id) or auth.role() = 'service_role') then
    raise exception 'not authorized or invalid quantity';
  end if;
  if p_external_id is not null and exists(select 1 from public.sales where location_id=p_location_id and external_id=p_external_id) then
    return (select id from public.sales where location_id=p_location_id and external_id=p_external_id);
  end if;
  insert into public.sales(location_id,external_id,product_recipe_id,quantity,total,cogs,payment_method,occurred_at,source)
    values(p_location_id,p_external_id,p_recipe_id,p_quantity,p_total,0,p_payment,p_occurred_at,case when p_external_id is null then 'manual' else 'loyverse' end)
    returning id into v_sale;
  for v_batch in
    select b.* from public.production_batches b join public.recipe_versions rv on rv.id=b.recipe_version_id
    where b.location_id=p_location_id
      and rv.recipe_id=p_recipe_id
      and b.status='open'
      and b.produced_at<=p_occurred_at
      and b.use_by>=p_occurred_at
    order by b.produced_at for update
  loop
    exit when v_left=0;
    v_take := least(v_left,v_batch.remaining_ml);
    update public.production_batches set remaining_ml=remaining_ml-v_take,status=case when remaining_ml-v_take=0 then 'consumed' else 'open' end where id=v_batch.id;
    insert into public.sale_batch_allocations(sale_id,batch_id,ml_used,cogs) values(v_sale,v_batch.id,v_take,(v_take::numeric/v_batch.initial_ml)*v_batch.batch_cost);
    v_cogs := v_cogs+(v_take::numeric/v_batch.initial_ml)*v_batch.batch_cost;
    v_left := v_left-v_take;
  end loop;
  if v_left>0 then raise exception 'insufficient FIFO batch volume'; end if;
  for v_pack in
    select li.item_id, i.standard_unit_cost from public.location_inventory li join public.inventory_items i on i.id=li.item_id
    where li.location_id=p_location_id and i.sku in ('CUP-12OZ','LID-12OZ') for update
  loop
    update public.location_inventory set quantity=quantity-p_quantity,updated_at=now() where location_id=p_location_id and item_id=v_pack.item_id and quantity>=p_quantity;
    if not found then raise exception 'insufficient packaging'; end if;
    insert into public.inventory_movements(location_id,item_id,quantity,movement_type,source_type,note,created_by)
      values(p_location_id,v_pack.item_id,-p_quantity,'sale_packaging','sale','POS sale',auth.uid());
    v_packaging_cogs := v_packaging_cogs + (v_pack.standard_unit_cost * p_quantity);
  end loop;
  update public.sales set cogs=v_cogs + v_packaging_cogs where id=v_sale;
  return v_sale;
end $function$;

revoke all on function public.record_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) from public, anon, authenticated;
grant execute on function public.record_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) to service_role;
