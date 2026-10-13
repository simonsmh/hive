-- Clients (anon / authenticated) get no direct table access. Reads go through the
-- Vercel API, which uses the service role key; service_role is the only writer.

alter table public.symbol_map enable row level security;
alter table public.candles enable row level security;
alter table public.quotes_latest enable row level security;
alter table public.daily_snapshot enable row level security;
alter table public.source_health enable row level security;
alter table public.news_events enable row level security;
alter table public.news_items enable row level security;
alter table public.fills enable row level security;
alter table public.webhooks enable row level security;
alter table public.alert_rules enable row level security;
alter table public.alerts enable row level security;
alter table public.deliveries enable row level security;

create policy service_role_all on public.symbol_map for all to service_role using (true) with check (true);
create policy service_role_all on public.candles for all to service_role using (true) with check (true);
create policy service_role_all on public.quotes_latest for all to service_role using (true) with check (true);
create policy service_role_all on public.daily_snapshot for all to service_role using (true) with check (true);
create policy service_role_all on public.source_health for all to service_role using (true) with check (true);
create policy service_role_all on public.news_events for all to service_role using (true) with check (true);
create policy service_role_all on public.news_items for all to service_role using (true) with check (true);
create policy service_role_all on public.fills for all to service_role using (true) with check (true);
create policy service_role_all on public.webhooks for all to service_role using (true) with check (true);
create policy service_role_all on public.alert_rules for all to service_role using (true) with check (true);
create policy service_role_all on public.alerts for all to service_role using (true) with check (true);
create policy service_role_all on public.deliveries for all to service_role using (true) with check (true);

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant select on public.v_spread to service_role;
grant execute on function public.hive_upsert_webhook(text, text, text) to service_role;
grant execute on function public.hive_get_webhook_secret(uuid) to service_role;
grant execute on function public.hive_enqueue_alert(text, text, text, uuid, jsonb) to service_role;
grant execute on function public.hive_run_health_check() to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
