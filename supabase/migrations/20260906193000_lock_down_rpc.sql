revoke all on function public.create_production_batch(uuid,uuid,timestamptz) from anon, authenticated, public;
revoke all on function public.record_sale(uuid,uuid,integer,numeric,public.payment_method,timestamptz,text) from anon, authenticated, public;
revoke all on function public.write_audit() from anon, authenticated, public;
