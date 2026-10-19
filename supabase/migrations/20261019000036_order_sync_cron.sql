-- order-sync cron: every minute, reconcile the orders table with OKX (fill price, filled size,
-- final state) via the order-sync Edge Function. Placements are rare, so most runs are a cheap
-- no-op over an empty pending set; a just-filled order is reflected within about a minute.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-order-sync') then
    perform cron.unschedule('hive-order-sync');
  end if;
end
$$;

select cron.schedule('hive-order-sync', '* * * * *', $$select public.hive_invoke_edge_function('order-sync')$$);
