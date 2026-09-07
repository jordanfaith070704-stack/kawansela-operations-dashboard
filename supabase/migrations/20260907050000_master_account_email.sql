create or replace function public.bootstrap_kawansela_master()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if lower(new.email) = 'master@kawansela.com'
    and not exists(select 1 from public.memberships where role = 'master') then
    insert into public.memberships(user_id, role, display_name)
    values(new.id, 'master', 'Jordan Nathaniel')
    on conflict(user_id) do update
      set role = 'master', display_name = 'Jordan Nathaniel';
  end if;
  return new;
end;
$$;

revoke all on function public.bootstrap_kawansela_master() from anon, authenticated, public;
