create table public.pos_connections (
  id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id) on delete cascade,
  provider text not null default 'loyverse', connection_name text not null, secret_reference text not null,
  external_account_id text, external_store_id text, status text not null default 'not_connected' check(status in ('not_connected','healthy','warning','error','inactive')),
  last_successful_sync_at timestamptz, last_attempt_at timestamptz, last_error text,
  effective_from timestamptz not null default now(), effective_until timestamptz,
  is_active boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint pos_connection_valid_period check(effective_until is null or effective_until > effective_from)
);
create unique index one_active_pos_connection_per_provider_location on public.pos_connections(location_id,provider) where is_active;
create table public.pos_product_mappings (
  id uuid primary key default gen_random_uuid(), pos_connection_id uuid not null references public.pos_connections(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete restrict, external_item_id text not null, is_required boolean not null default true, is_active boolean not null default true, created_at timestamptz not null default now(), unique(pos_connection_id,recipe_id), unique(pos_connection_id,external_item_id)
);
create table public.pos_sync_runs (
  id uuid primary key default gen_random_uuid(), pos_connection_id uuid not null references public.pos_connections(id) on delete cascade,
  status text not null check(status in ('started','succeeded','warning','failed')), started_at timestamptz not null default now(), completed_at timestamptz,
  imported_count integer not null default 0, duplicate_count integer not null default 0, error_summary text
);
create table public.pos_receipt_events (
  id uuid primary key default gen_random_uuid(), pos_connection_id uuid not null references public.pos_connections(id) on delete cascade,
  external_receipt_id text not null, event_kind text not null check(event_kind in ('sale','refund','void')), payload jsonb not null,
  received_at timestamptz not null default now(), processed_at timestamptz, processing_error text, kawansela_sale_id uuid references public.sales(id),
  unique(pos_connection_id,external_receipt_id,event_kind)
);
alter table public.pos_connections enable row level security; alter table public.pos_product_mappings enable row level security; alter table public.pos_sync_runs enable row level security; alter table public.pos_receipt_events enable row level security;
create policy "master configures pos connections" on public.pos_connections for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "master configures product maps" on public.pos_product_mappings for all to authenticated using((select app.is_master())) with check((select app.is_master()));
create policy "pos sync visible to location" on public.pos_sync_runs for select to authenticated using((select app.is_master()) or exists(select 1 from public.pos_connections c where c.id=pos_connection_id and app.is_location_member(c.location_id)));
create policy "pos events visible to location" on public.pos_receipt_events for select to authenticated using((select app.is_master()) or exists(select 1 from public.pos_connections c where c.id=pos_connection_id and app.is_location_member(c.location_id)));
