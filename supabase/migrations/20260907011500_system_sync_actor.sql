-- POS imports run under the server service role and do not impersonate a human.
-- A null created_by therefore means "Kawansela system"; human actions still
-- carry auth.uid() through the member-scoped RPCs.
alter table public.inventory_movements alter column created_by drop not null;

create index if not exists audit_logs_actor_id_idx on public.audit_logs(actor_id);
create index if not exists audit_logs_location_created_idx on public.audit_logs(location_id,created_at desc);
create index if not exists batch_waste_events_batch_id_idx on public.batch_waste_events(batch_id);
create index if not exists inventory_items_supplier_id_idx on public.inventory_items(supplier_id);
create index if not exists sale_batch_allocations_batch_id_idx on public.sale_batch_allocations(batch_id);
create index if not exists sales_product_recipe_id_idx on public.sales(product_recipe_id);
create index if not exists stock_counts_location_counted_idx on public.stock_counts(location_id,counted_at desc);
