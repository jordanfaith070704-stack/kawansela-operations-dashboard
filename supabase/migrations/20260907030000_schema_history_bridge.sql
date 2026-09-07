-- Bridge for production functions that existed in the live project before the
-- source migration history was recovered.  It is deliberately idempotent so a
-- new project created from this repository receives the same recipe contract.

create or replace function app.is_service_role()
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
$$;
revoke all on function app.is_service_role() from public, anon, authenticated;

create or replace function public.publish_recipe_version(
  p_recipe_id uuid,
  p_name text,
  p_selling_price numeric,
  p_carry_days integer,
  p_note text,
  p_lines jsonb
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare
  v_recipe_id uuid;
  v_version integer;
  v_version_id uuid;
  v_line jsonb;
begin
  if auth.uid() is null or not app.is_master() then raise exception 'not authorized'; end if;
  if trim(p_name)='' or p_selling_price<0 or p_carry_days<0 or p_carry_days>7 then raise exception 'invalid recipe'; end if;
  if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines,'[]'::jsonb))=0 then
    raise exception 'recipe requires ingredients';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_lines) line
    group by line->>'item_id' having count(*) > 1
  ) then raise exception 'recipe contains duplicate ingredients'; end if;

  if p_recipe_id is null then
    insert into public.recipes(name,selling_price,active_version)
      values(trim(p_name),p_selling_price,1) returning id into v_recipe_id;
    v_version:=1;
  else
    select id into v_recipe_id from public.recipes where id=p_recipe_id for update;
    if not found then raise exception 'recipe not found'; end if;
    select coalesce(max(version),0)+1 into v_version from public.recipe_versions where recipe_id=v_recipe_id;
    update public.recipes set name=trim(p_name),selling_price=p_selling_price,active_version=v_version where id=v_recipe_id;
  end if;
  insert into public.recipe_versions(recipe_id,version,batch_ml,serving_ml,carry_days,note,published_by)
    values(v_recipe_id,v_version,900,150,p_carry_days,trim(p_note),auth.uid()) returning id into v_version_id;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if not exists(select 1 from public.inventory_items where id=(v_line->>'item_id')::uuid) then
      raise exception 'recipe item not found';
    end if;
    insert into public.recipe_version_lines(recipe_version_id,item_id,quantity)
      values(v_version_id,(v_line->>'item_id')::uuid,(v_line->>'quantity')::numeric);
  end loop;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,after_data)
    values(auth.uid(),'PUBLISH','recipe_version',v_version_id,jsonb_build_object('recipe_id',v_recipe_id,'version',v_version));
  return v_recipe_id;
end $$;
revoke all on function public.publish_recipe_version(uuid,text,numeric,integer,text,jsonb) from public, anon;
grant execute on function public.publish_recipe_version(uuid,text,numeric,integer,text,jsonb) to authenticated;

-- Compatibility entry point for non-POS sales. POS imports use
-- record_pos_sale from the following migration so their idempotency is
-- connection-scoped.
create or replace function public.record_sale(
  p_location_id uuid, p_recipe_id uuid, p_quantity integer, p_total numeric,
  p_payment public.payment_method, p_occurred_at timestamptz, p_external_id text default null
) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare
  v_sale uuid; v_left integer:=p_quantity*150; v_take integer; v_batch record;
  v_cogs numeric(14,2):=0; v_pack record; v_pack_count integer:=0;
begin
  if p_quantity<=0 or p_total<0 or not (app.is_location_member(p_location_id) or app.is_service_role()) then
    raise exception 'not authorized or invalid quantity';
  end if;
  if p_external_id is not null and exists(select 1 from public.sales where location_id=p_location_id and external_id=p_external_id) then
    return (select id from public.sales where location_id=p_location_id and external_id=p_external_id);
  end if;
  for v_pack in select li.item_id,li.quantity,i.standard_unit_cost from public.location_inventory li
    join public.inventory_items i on i.id=li.item_id
    where li.location_id=p_location_id and i.sku in ('CUP-12OZ','LID-12OZ') for update loop
    v_pack_count:=v_pack_count+1;
    if v_pack.quantity<p_quantity then raise exception 'insufficient packaging'; end if;
    v_cogs:=v_cogs+p_quantity*v_pack.standard_unit_cost;
  end loop;
  if v_pack_count<>2 then raise exception 'required cup and lid inventory is not configured'; end if;
  insert into public.sales(location_id,external_id,product_recipe_id,quantity,total,cogs,payment_method,occurred_at,source)
    values(p_location_id,p_external_id,p_recipe_id,p_quantity,p_total,0,p_payment,p_occurred_at,
      case when p_external_id is null then 'manual' else 'external' end) returning id into v_sale;
  for v_batch in select b.* from public.production_batches b join public.recipe_versions rv on rv.id=b.recipe_version_id
    where b.location_id=p_location_id and rv.recipe_id=p_recipe_id and b.status='open'
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
  for v_pack in select li.item_id from public.location_inventory li join public.inventory_items i on i.id=li.item_id
    where li.location_id=p_location_id and i.sku in ('CUP-12OZ','LID-12OZ') for update loop
    update public.location_inventory set quantity=quantity-p_quantity,updated_at=now()
      where location_id=p_location_id and item_id=v_pack.item_id;
    insert into public.inventory_movements(location_id,item_id,quantity,movement_type,source_type,source_id,note,created_by)
      values(p_location_id,v_pack.item_id,-p_quantity,'sale_packaging','sale',v_sale,'Sale',auth.uid());
  end loop;
  update public.sales set cogs=v_cogs where id=v_sale;
  return v_sale;
end $$;
revoke all on function public.record_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) from public, anon, authenticated;
grant execute on function public.record_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) to service_role;
