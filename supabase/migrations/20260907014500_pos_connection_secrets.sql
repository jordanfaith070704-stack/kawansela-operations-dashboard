-- Provider credentials are encrypted by the application before persistence.
-- There are deliberately no browser-facing RLS policies on this table.
create table if not exists public.pos_connection_secrets (
  pos_connection_id uuid primary key references public.pos_connections(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now()
);
alter table public.pos_connection_secrets enable row level security;
revoke all on public.pos_connection_secrets from public, anon, authenticated;
