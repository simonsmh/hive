-- order-sync cron: every 3 minutes (like position-manager), reconcile the orders table with OKX
-- (fill price, filled size, final state) via the order-sync Edge Function. Every minute would add
-- ~1,440 invocations/day and push the project over the free monthly Edge quota (see README);
-- at 3 minutes it adds 480/day. Placements are rare, so most runs are a cheap no-op over an
-- empty pending set; a just-filled order is reflected within a few minutes.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hive-order-sync') then
    perform cron.unschedule('hive-order-sync');
  end if;
end
$$;

select cron.schedule('hive-order-sync', '*/3 * * * *', $$select public.hive_invoke_edge_function('order-sync')$$);
