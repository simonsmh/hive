-- Offline/local check for 20261115000051_perf_hot_path_indexes.sql.
-- Do not point DATABASE_URL at production. Expects the migration to have been
-- applied on the target database.

\set ON_ERROR_STOP 1

do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'news_events'
       and indexname = 'news_events_first_published_at_idx'
  ) then
    raise exception 'missing news_events_first_published_at_idx';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'news_events'
       and indexname = 'news_events_earliest_item_id_idx'
  ) then
    raise exception 'missing news_events_earliest_item_id_idx';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'cron'
       and tablename = 'job_run_details'
       and indexname = 'job_run_details_end_time_idx'
  ) then
    raise exception 'missing job_run_details_end_time_idx';
  end if;
  raise notice 'perf_hot_path_indexes: all three indexes present';
end
$$;
