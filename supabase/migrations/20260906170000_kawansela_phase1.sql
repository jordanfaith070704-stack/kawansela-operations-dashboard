create extension if not exists pgcrypto;
create schema if not exists app;

create type public.kawansela_role as enum ('operator','location_manager','master');
create type public.inventory_movement_type as enum ('receive','production_use','sale_packaging','waste','opname_adjustment','return');
create type public.payment_method as enum ('cash','qris_static','qris_provider','other');

create table public.locations (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null, city text not null,
  timezone text not null default 'Asia/Jakarta', is_active boolean not null default true, created_at timestamptz not null default now()
);
create table public.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade, location_id uuid references public.locations(id) on delete cascade,
  role public.kawansela_role not null, display_name text, created_at timestamptz not null default now(),
  constraint operator_requires_location check (role = 'master' or location_id is not null)
);
create table public.suppliers (id uuid primary key default gen_random_uuid(), name text not null unique, lead_days integer not null default 1 check(lead_days >= 0), is_active boolean not null default true, created_at timestamptz not null default now());
create table public.inventory_items (id uuid primary key default gen_random_uuid(), sku text not null unique, name text not null, unit text not null, category text not null check(category in ('ingredient','packaging')), supplier_id uuid references public.suppliers(id), standard_unit_cost numeric(14,2) not null check(standard_unit_cost >= 0), created_at timestamptz not null default now());
create table public.location_inventory (location_id uuid references public.locations(id) on delete cascade, item_id uuid references public.inventory_items(id) on delete restrict, quantity numeric(14,3) not null default 0 check(quantity >= 0), par_level numeric(14,3) not null default 0, safety_stock numeric(14,3) not null default 0, minimum_order numeric(14,3) not null default 0, updated_at timestamptz not null default now(), primary key(location_id,item_id));
create table public.recipes (id uuid primary key default gen_random_uuid(), name text not null unique, selling_price numeric(14,2) not null check(selling_price >= 0), active_version integer not null default 1, created_at timestamptz not null default now());
create table public.recipe_versions (id uuid primary key default gen_random_uuid(), recipe_id uuid not null references public.recipes(id) on delete cascade, version integer not null, batch_ml integer not null default 900 check(batch_ml = 900), serving_ml integer not null default 150 check(serving_ml = 150), carry_days integer not null default 1 check(carry_days between 0 and 7), note text not null, published_at timestamptz not null default now(), published_by uuid references auth.users(id), unique(recipe_id,version));
create table public.recipe_version_lines (recipe_version_id uuid not null references public.recipe_versions(id) on delete cascade, item_id uuid not null references public.inventory_items(id), quantity numeric(14,3) not null check(quantity > 0), primary key(recipe_version_id,item_id));
create table public.production_batches (id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id), recipe_version_id uuid not null references public.recipe_versions(id), produced_at timestamptz not null default now(), use_by timestamptz not null, initial_ml integer not null default 900 check(initial_ml = 900), remaining_ml integer not null default 900 check(remaining_ml between 0 and 900), batch_cost numeric(14,2) not null check(batch_cost >= 0), status text not null default 'open' check(status in ('open','consumed','expired','wasted')), created_by uuid not null references auth.users(id));
create table public.inventory_movements (id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id), item_id uuid not null references public.inventory_items(id), quantity numeric(14,3) not null, movement_type public.inventory_movement_type not null, source_type text not null, source_id uuid, note text, created_at timestamptz not null default now(), created_by uuid not null references auth.users(id));
create table public.sales (id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id), external_id text, product_recipe_id uuid references public.recipes(id), quantity integer not null check(quantity > 0), total numeric(14,2) not null check(total >= 0), cogs numeric(14,2) not null default 0, payment_method public.payment_method not null, occurred_at timestamptz not null, source text not null default 'manual', unique(location_id,external_id));
create table public.sale_batch_allocations (sale_id uuid not null references public.sales(id) on delete cascade, batch_id uuid not null references public.production_batches(id), ml_used integer not null check(ml_used > 0), cogs numeric(14,2) not null, primary key(sale_id,batch_id));
create table public.stock_counts (id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id), mode text not null check(mode in ('daily','full')), counted_at timestamptz not null default now(), created_by uuid not null references auth.users(id));
create table public.stock_count_lines (stock_count_id uuid not null references public.stock_counts(id) on delete cascade, item_id uuid not null references public.inventory_items(id), system_quantity numeric(14,3) not null, physical_quantity numeric(14,3) not null, primary key(stock_count_id,item_id));
create table public.daily_reconciliations (location_id uuid not null references public.locations(id), business_date date not null, opening_cash numeric(14,2) not null default 0, actual_cash numeric(14,2), actual_qris numeric(14,2), other_cash_in numeric(14,2) not null default 0, cash_refund numeric(14,2) not null default 0, note text, closed_by uuid references auth.users(id), closed_at timestamptz, primary key(location_id,business_date));
create table public.payment_profiles (id uuid primary key default gen_random_uuid(), location_id uuid not null unique references public.locations(id), provider text not null default 'static_qris', static_qris_reference text, provider_config jsonb not null default '{}'::jsonb, is_active boolean not null default true);
create table public.integration_events (id uuid primary key default gen_random_uuid(), provider text not null, external_id text not null, location_id uuid references public.locations(id), payload jsonb not null, processed_at timestamptz, error text, created_at timestamptz not null default now(), unique(provider,external_id));
create table public.audit_logs (id uuid primary key default gen_random_uuid(), location_id uuid references public.locations(id), actor_id uuid references auth.users(id), action text not null, entity_type text not null, entity_id uuid, before_data jsonb, after_data jsonb, created_at timestamptz not null default now());

create or replace function app.is_master() returns boolean language sql stable security definer set search_path = public, auth as $$ select exists(select 1 from public.memberships where user_id = auth.uid() and role = 'master') $$;
create or replace function app.is_location_member(target_location uuid) returns boolean language sql stable security definer set search_path = public, auth as $$ select app.is_master() or exists(select 1 from public.memberships where user_id = auth.uid() and location_id = target_location) $$;
revoke all on function app.is_master() from public; revoke all on function app.is_location_member(uuid) from public;
grant usage on schema app to authenticated; grant execute on function app.is_master() to authenticated; grant execute on function app.is_location_member(uuid) to authenticated;

alter table public.locations enable row level security; alter table public.memberships enable row level security; alter table public.suppliers enable row level security; alter table public.inventory_items enable row level security; alter table public.location_inventory enable row level security; alter table public.recipes enable row level security; alter table public.recipe_versions enable row level security; alter table public.recipe_version_lines enable row level security; alter table public.production_batches enable row level security; alter table public.inventory_movements enable row level security; alter table public.sales enable row level security; alter table public.sale_batch_allocations enable row level security; alter table public.stock_counts enable row level security; alter table public.stock_count_lines enable row level security; alter table public.daily_reconciliations enable row level security; alter table public.payment_profiles enable row level security; alter table public.integration_events enable row level security; alter table public.audit_logs enable row level security;
create policy "members view self" on public.memberships for select to authenticated using(user_id = (select auth.uid()) or (select app.is_master()));
create policy "locations scoped" on public.locations for select to authenticated using((select app.is_master()) or id in (select location_id from public.memberships where user_id=(select auth.uid())));
create policy "master manages locations" on public.locations for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "master manages memberships" on public.memberships for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "authenticated reads master catalog" on public.suppliers for select to authenticated using(true); create policy "master writes suppliers" on public.suppliers for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "authenticated reads items" on public.inventory_items for select to authenticated using(true); create policy "master writes items" on public.inventory_items for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "catalog recipes readable" on public.recipes for select to authenticated using(true); create policy "master recipe edit" on public.recipes for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "versions readable" on public.recipe_versions for select to authenticated using(true); create policy "master versions edit" on public.recipe_versions for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "recipe lines readable" on public.recipe_version_lines for select to authenticated using(true); create policy "master recipe lines edit" on public.recipe_version_lines for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "location inventory scoped" on public.location_inventory for select to authenticated using((select app.is_location_member(location_id))); create policy "location inventory writes scoped" on public.location_inventory for all to authenticated using((select app.is_location_member(location_id))) with check((select app.is_location_member(location_id)));
create policy "batches scoped" on public.production_batches for all to authenticated using((select app.is_location_member(location_id))) with check((select app.is_location_member(location_id)));
create policy "inventory movements scoped" on public.inventory_movements for all to authenticated using((select app.is_location_member(location_id))) with check((select app.is_location_member(location_id)));
create policy "sales scoped" on public.sales for all to authenticated using((select app.is_location_member(location_id))) with check((select app.is_location_member(location_id)));
create policy "sale allocations scoped" on public.sale_batch_allocations for select to authenticated using(exists(select 1 from public.sales s where s.id=sale_id and app.is_location_member(s.location_id)));
create policy "stock count scoped" on public.stock_counts for all to authenticated using((select app.is_location_member(location_id))) with check((select app.is_location_member(location_id)));
create policy "stock count lines scoped" on public.stock_count_lines for select to authenticated using(exists(select 1 from public.stock_counts s where s.id=stock_count_id and app.is_location_member(s.location_id)));
create policy "reconciliation scoped" on public.daily_reconciliations for all to authenticated using((select app.is_location_member(location_id))) with check((select app.is_location_member(location_id)));
create policy "payment profile scoped" on public.payment_profiles for select to authenticated using((select app.is_location_member(location_id))); create policy "master payment profile edit" on public.payment_profiles for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "master integration events" on public.integration_events for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "audit scoped" on public.audit_logs for select to authenticated using(location_id is null and (select app.is_master()) or (select app.is_location_member(location_id)));

create or replace function public.write_audit() returns trigger language plpgsql security definer set search_path = public, auth as $$ declare data jsonb := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end; begin insert into public.audit_logs(location_id,actor_id,action,entity_type,entity_id,before_data,after_data) values(nullif(data->>'location_id','')::uuid,auth.uid(),tg_op,tg_table_name,nullif(data->>'id','')::uuid,case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end); if tg_op='DELETE' then return old; end if; return new; end $$;
revoke all on function public.write_audit() from public;
create trigger audit_production_batches after insert or update or delete on public.production_batches for each row execute function public.write_audit();
create trigger audit_inventory_movements after insert or update or delete on public.inventory_movements for each row execute function public.write_audit();
create trigger audit_sales after insert or update or delete on public.sales for each row execute function public.write_audit();
create trigger audit_recipe_versions after insert or update or delete on public.recipe_versions for each row execute function public.write_audit();

-- Operators do not directly edit quantities: the following transactions preserve the F&B chain.
create or replace function public.create_production_batch(p_location_id uuid, p_recipe_version_id uuid, p_produced_at timestamptz default now()) returns uuid language plpgsql security definer set search_path = public, auth as $$
declare v_batch uuid; v_recipe public.recipe_versions%rowtype; v_cost numeric := 0; v_line record;
begin
  if not app.is_location_member(p_location_id) then raise exception 'not authorized'; end if;
  select * into v_recipe from public.recipe_versions where id=p_recipe_version_id;
  if not found then raise exception 'recipe version not found'; end if;
  for v_line in select l.item_id,l.quantity,i.standard_unit_cost from public.recipe_version_lines l join public.inventory_items i on i.id=l.item_id where l.recipe_version_id=p_recipe_version_id loop
    perform 1 from public.location_inventory where location_id=p_location_id and item_id=v_line.item_id and quantity>=v_line.quantity for update;
    if not found then raise exception 'insufficient inventory for item %',v_line.item_id; end if;
    update public.location_inventory set quantity=quantity-v_line.quantity,updated_at=now() where location_id=p_location_id and item_id=v_line.item_id;
    insert into public.inventory_movements(location_id,item_id,quantity,movement_type,source_type,note,created_by) values(p_location_id,v_line.item_id,-v_line.quantity,'production_use','production_batch','900 ml production',auth.uid());
    v_cost := v_cost + v_line.quantity*v_line.standard_unit_cost;
  end loop;
  insert into public.production_batches(location_id,recipe_version_id,produced_at,use_by,batch_cost,created_by) values(p_location_id,p_recipe_version_id,p_produced_at,p_produced_at + make_interval(days=>v_recipe.carry_days),v_cost,auth.uid()) returning id into v_batch;
  return v_batch;
end $$;
create or replace function public.record_sale(p_location_id uuid,p_recipe_id uuid,p_quantity integer,p_total numeric,p_payment public.payment_method,p_occurred_at timestamptz,p_external_id text default null) returns uuid language plpgsql security definer set search_path = public, auth as $$
declare v_sale uuid; v_left integer := p_quantity*150; v_take integer; v_batch record; v_cogs numeric := 0; v_pack record;
begin
  if p_quantity<=0 or not app.is_location_member(p_location_id) then raise exception 'not authorized or invalid quantity'; end if;
  if p_external_id is not null and exists(select 1 from public.sales where location_id=p_location_id and external_id=p_external_id) then return (select id from public.sales where location_id=p_location_id and external_id=p_external_id); end if;
  insert into public.sales(location_id,external_id,product_recipe_id,quantity,total,cogs,payment_method,occurred_at,source) values(p_location_id,p_external_id,p_recipe_id,p_quantity,p_total,0,p_payment,p_occurred_at,case when p_external_id is null then 'manual' else 'loyverse' end) returning id into v_sale;
  for v_batch in select b.* from public.production_batches b join public.recipe_versions rv on rv.id=b.recipe_version_id where b.location_id=p_location_id and rv.recipe_id=p_recipe_id and b.status='open' and b.use_by>=p_occurred_at order by b.produced_at for update loop
    exit when v_left=0; v_take := least(v_left,v_batch.remaining_ml); update public.production_batches set remaining_ml=remaining_ml-v_take,status=case when remaining_ml-v_take=0 then 'consumed' else 'open' end where id=v_batch.id; insert into public.sale_batch_allocations(sale_id,batch_id,ml_used,cogs) values(v_sale,v_batch.id,v_take,(v_take::numeric/v_batch.initial_ml)*v_batch.batch_cost); v_cogs:=v_cogs+(v_take::numeric/v_batch.initial_ml)*v_batch.batch_cost; v_left:=v_left-v_take;
  end loop;
  if v_left>0 then raise exception 'insufficient FIFO batch volume'; end if;
  for v_pack in select li.item_id from public.location_inventory li join public.inventory_items i on i.id=li.item_id where li.location_id=p_location_id and i.sku in ('CUP-12OZ','LID-12OZ') for update loop
    update public.location_inventory set quantity=quantity-p_quantity,updated_at=now() where location_id=p_location_id and item_id=v_pack.item_id and quantity>=p_quantity;
    if not found then raise exception 'insufficient packaging'; end if;
    insert into public.inventory_movements(location_id,item_id,quantity,movement_type,source_type,note,created_by) values(p_location_id,v_pack.item_id,-p_quantity,'sale_packaging','sale','POS sale',auth.uid());
  end loop;
  update public.sales set cogs=v_cogs where id=v_sale;
  return v_sale;
end $$;
revoke all on function public.create_production_batch(uuid,uuid,timestamptz) from public; revoke all on function public.record_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) from public;
grant execute on function public.create_production_batch(uuid,uuid,timestamptz) to authenticated; grant execute on function public.record_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) to authenticated;
