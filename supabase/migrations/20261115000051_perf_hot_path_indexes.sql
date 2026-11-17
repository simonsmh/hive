-- Behavior-preserving indexes only.
-- Naming follows the main-line convention YYYYMMDD + a monotonically increasing
-- suffix (last main migration is 20261105000050), then a snake_case summary.
--
-- Necessity and write-cost review:
-- 1) news_events(first_published_at desc)
--    The news API and news prune order/filter by first_published_at; the table
--    currently has only a primary key. news_events is far smaller and less
--    write-heavy than candles, so the extra index cost is modest.
-- 2) news_events(earliest_item_id)
--    Covers the unindexed FK news_events_earliest_item_fk and the prune
--    subquery on earliest_item_id. Same low-write table. Not a duplicate of (1).
-- 3) cron.job_run_details(end_time)
--    Daily hive_run_retention deletes by end_time, but the table has only a
--    primary key (~59 MB in the 2026-11-15 snapshot). This has real write
--    amplification: pg_cron inserts/updates a row on every job tick. Still
--    the right index for that delete. Creating it requires a role that can
--    write in the cron schema; PGlite tests cannot prove that permission.
--
-- Do not drop unused-index advisor findings here: several of those tables are
-- recent or infrequently used, and unused flags can reset with stats.

create index if not exists news_events_first_published_at_idx
  on public.news_events (first_published_at desc);

create index if not exists news_events_earliest_item_id_idx
  on public.news_events (earliest_item_id);

-- Requires a role that can create objects in the cron schema.
-- CI and some roles are not the owner of cron.job_run_details; skip in that case
-- so the news_events indexes can still be applied.
do $$
begin
  execute 'create index if not exists job_run_details_end_time_idx on cron.job_run_details (end_time)';
exception
  when insufficient_privilege then
    raise notice 'skip job_run_details_end_time_idx: current role cannot index cron.job_run_details';
end
$$;
