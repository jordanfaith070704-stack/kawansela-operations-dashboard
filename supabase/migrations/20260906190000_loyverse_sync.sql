create table public.loyverse_connections (
  id uuid primary key default gen_random_uuid(),
  label text not null unique, status text not null default 'not_connected' check(status in ('not_connected','healthy','warning','error')),
  last_successful_sync_at timestamptz, last_attempt_at timestamptz, last_error text, cursor text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.loyverse_store_mappings (
  loyverse_store_id text primary key, location_id uuid not null unique references public.locations(id) on delete cascade, connection_id uuid not null references public.loyverse_connections(id) on delete cascade, is_active boolean not null default true
);
create table public.loyverse_item_mappings (
  loyverse_item_id text primary key, recipe_id uuid not null references public.recipes(id) on delete restrict, connection_id uuid not null references public.loyverse_connections(id) on delete cascade, is_active boolean not null default true
);
create table public.loyverse_receipt_events (
  id uuid primary key default gen_random_uuid(), connection_id uuid not null references public.loyverse_connections(id), loyverse_receipt_id text not null, event_kind text not null check(event_kind in ('sale','refund','void')), payload jsonb not null, received_at timestamptz not null default now(), processed_at timestamptz, processing_error text, kawansela_sale_id uuid references public.sales(id), unique(connection_id,loyverse_receipt_id,event_kind)
);
create table public.refund_resolutions (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null references public.sales(id), outcome text not null check(outcome in ('not_prepared_restore','prepared_discarded_waste','other')), reason text, resolved_by uuid references auth.users(id), resolved_at timestamptz not null default now()
);
alter table public.loyverse_connections enable row level security; alter table public.loyverse_store_mappings enable row level security; alter table public.loyverse_item_mappings enable row level security; alter table public.loyverse_receipt_events enable row level security; alter table public.refund_resolutions enable row level security;
create policy "master sees loyverse connection" on public.loyverse_connections for select to authenticated using((select app.is_master()));
create policy "master manages loyverse connection" on public.loyverse_connections for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "master sees store map" on public.loyverse_store_mappings for select to authenticated using((select app.is_master()));
create policy "master manages store map" on public.loyverse_store_mappings for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "master sees item map" on public.loyverse_item_mappings for select to authenticated using((select app.is_master()));
create policy "master manages item map" on public.loyverse_item_mappings for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "events scoped" on public.loyverse_receipt_events for select to authenticated using((select app.is_master()) or exists(select 1 from public.sales s where s.id=kawansela_sale_id and app.is_location_member(s.location_id)));
create policy "refund resolution scoped" on public.refund_resolutions for select to authenticated using((select app.is_master()) or exists(select 1 from public.sales s where s.id=sale_id and app.is_location_member(s.location_id)));
