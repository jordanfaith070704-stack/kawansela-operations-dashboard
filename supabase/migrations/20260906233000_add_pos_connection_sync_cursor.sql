-- Per-connection operational state only. Credentials remain behind secret_reference.
alter table public.pos_connections
  add column if not exists sync_cursor jsonb not null default '{}'::jsonb,
  add column if not exists last_processed_receipt_at timestamptz;

create index if not exists pos_connections_active_sync_idx
  on public.pos_connections(provider, status, last_successful_sync_at)
  where is_active;
