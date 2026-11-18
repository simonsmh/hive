# Reusing a Hive webhook destination

Use this when a working Hive subscription (for example `grokbot-news`) should feed a second agent without asking anyone to paste the URL, HMAC secret, or bearer token again, and without reading those values out of the database or the browser.

## What this is for

- One destination (a Cursor / Grok Bot inbound webhook that already returns HTTP 200) can back more than one Hive subscription, each with its own `event_types` and `filters`.
- Credentials stay inside Postgres + Vault. The clone RPC is `security definer`, granted only to `service_role`. It returns the new subscription id only.
- The source row is not updated. Deleting or later rotating one subscription does not delete the other's Vault copies (secrets are duplicated at clone time, not shared by id).

## Do not

- `SELECT` `url`, `secret_id`, `auth_token_secret_id`, or `vault.decrypted_secrets` into a chat, log, or markdown file.
- Call `hive_upsert_webhook_subscription` to create the new agent by pasting the source secret.
- Change an existing working news subscription to also accept every alert. Add a dedicated alert subscription with tight filters instead.
- Replay old `alerts` or old failed `webhook_deliveries` to "test" a new subscription. Only new inserts fan out.
- Point a new subscription at a destination that is already returning HTTP 401 (for example the historical `grok` and `news` agents). Fix or retire those separately.

## Clone

After migration `20261118024102_ashare_index_alerts_and_webhook_clone` is applied:

```sql
select public.hive_clone_webhook_destination(
  'grokbot-news',          -- existing working source agent_name
  'grokbot-market',        -- new agent_name
  array['alert']::text[],
  '{
     "alert_kinds": ["volume_spike","pct_move","ma_cross","retracement"],
     "symbols": ["SH000688","SZ399006","SH000300","SH513310","SZ159915"]
   }'::jsonb,
  true
) as id;

-- Confirm without reading credentials:
select agent_name, event_types, filters, enabled, created_at
  from public.webhook_subscriptions
 where agent_name in ('grokbot-news','grokbot-market');
```

If the source agent is missing, or the new name already exists, the function raises and writes nothing.

## Filters the receiver should expect

`hive_fanout_alert` ignores the `sources` filter (that list is for news outlets). For alerts, useful filters are `alert_kinds`, `symbols`, and `severities`. Keywords still match against `kind || payload`.

Market volume and turning-point alerts are currently `bulk` in `hive_delivery_policy` (up to about two minutes until `webhook-dispatcher` runs, stale after 300s, expire after 15 minutes). They are not a trading trigger.

## A-share 5m volume rules this work added

| symbol   | meaning    | rule |
| -------- | ---------- | ---- |
| SH000688 | STAR 50 index | sina 5m `volume_spike`, 2× vs prior 20 bars, 0.3% min body, skip 09:30 open bar, 30 min cooldown |
| SZ399006 | ChiNext index | same |
| SH000300 | CSI 300 index | same |

Sina index `volume` is constituent share volume (verified 2026-11-18: every 5m bar nonzero, varies with turnover, not cumulative across lunch). These are the indices themselves, not ETF proxies. The 09:30 Asia/Shanghai bar is skipped because it is routinely several times the previous afternoon average. A volume alert is a coarse wake, not a trend signal.

Existing `SH513310` / `SZ159915` / `HTGD` rules were not changed. The `grokbot-market` filters include the two ETFs plus the three indices, and the four rule kinds above, so those existing alerts can also wake the market routine.

Intraday 5m collection is the sina-intraday-collector whitelist (hard-coded). Adding a symbol to `symbol_map` alone is not enough.

## End-to-end test fixture

To prove the new subscription without inventing a natural market event, insert one clearly marked test alert (no orders, no rule_id, unique `dedup_key`). The receiver must treat `payload.test = true` as a fixture:

```sql
insert into public.alerts (dedup_key, symbol, kind, severity, payload)
values (
  'test:grokbot-market:' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDDHH24MISS'),
  'SH000688',
  'volume_spike',
  'warning',
  jsonb_build_object(
    'test', true,
    'fixture', true,
    'source', 'test',
    'symbol', 'SH000688',
    'rule_name', 'TEST fixture — not a market signal',
    'note', 'End-to-end webhook test. Ignore for trading.'
  )
)
returning id;
```

Then, using `created_at` (indexed), check `webhook_deliveries` for that `event_key` and the `grokbot-market` agent: expect `status = delivered` and `response_status = 200`. Leave `grokbot-news` news traffic already-green; it should not receive this alert (`event_types` is news-only).

## Deploy baseline note

Production already ran sina-intraday-collector and a retracement/ma_cross-capable alert-evaluator ahead of `origin/main`. Further function deploys for this feature must start from the live function source, change only the whitelist / `skipSessionOpenBars` behaviour, and must not redeploy those functions from an older `main` tree.
