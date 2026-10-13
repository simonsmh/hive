-- Jin10 flash ingest. The jin10-poller Edge Function calls hive_news_ingest with each poll. Items are
-- deduplicated on dedup_hash ("<source>:<external_id>"), each new item gets its own news_events row so the
-- news panel can show it, and every call refreshes source_health (heartbeat), even when nothing is new.

alter table public.news_items add column if not exists author text;

insert into public.source_health (source, enabled, max_staleness_minutes) values
  ('jin10', true, 5)
on conflict (source) do nothing;

create or replace function public.hive_news_ingest(p_source text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_item record;
  v_item_id bigint;
  v_event_id uuid;
  v_hash text;
  v_published timestamptz;
  v_inserted integer := 0;
  v_duplicates integer := 0;
begin
  if p_source is distinct from 'jin10' then
    raise exception 'unsupported news source %', p_source;
  end if;

  for v_item in
    select c.external_id, c.title, c.body, c.url, c.author, c.published_at, c.score
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb))
        as c(external_id text, title text, body text, url text, author text, published_at timestamptz, score numeric)
  loop
    if v_item.external_id is null or btrim(v_item.external_id) = '' then continue; end if;

    v_hash := p_source || ':' || v_item.external_id;
    if exists (select 1 from public.news_items where dedup_hash = v_hash) then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;

    v_published := coalesce(v_item.published_at, now());
    insert into public.news_events (title, first_published_at)
    values (left(coalesce(nullif(btrim(v_item.title), ''), v_item.body, ''), 120), v_published)
    returning id into v_event_id;

    insert into public.news_items (source, title, url, body, author, published_at, dedup_hash, event_id, score)
    values (p_source, nullif(btrim(v_item.title), ''), coalesce(v_item.url, ''), v_item.body, v_item.author,
            v_published, v_hash, v_event_id, coalesce(v_item.score, 0))
    on conflict (dedup_hash) do nothing
    returning id into v_item_id;

    if v_item_id is null then
      delete from public.news_events where id = v_event_id;
      v_duplicates := v_duplicates + 1;
    else
      update public.news_events set earliest_item_id = v_item_id where id = v_event_id;
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  insert into public.source_health (source, last_success_at, consecutive_failures, last_error, updated_at)
  values (p_source::public.market_source, now(), 0, null, now())
  on conflict (source) do update
    set last_success_at = now(), consecutive_failures = 0, last_error = null, updated_at = now();

  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_duplicates);
end
$$;

revoke execute on function public.hive_news_ingest(text, jsonb) from public, anon, authenticated;
grant execute on function public.hive_news_ingest(text, jsonb) to service_role;
