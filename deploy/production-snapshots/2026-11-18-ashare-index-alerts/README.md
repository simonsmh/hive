# Production snapshot: 2026-11-18 A-share index volume alerts

This directory is the exact Edge Function source that was deployed to Supabase project `ifupefthwtdutjzsqsnw` on 2026-11-18 (Asia/Shanghai), plus the local tests that pin this patch. It exists so the live baseline is in git, not only on a VM disk.

It is **not** a merge of unpublished collector/evaluator WIP into `supabase/functions` on `main`. `origin/main` is still behind the production alert-evaluator (ma_cross / retracement / `minMovePct`) and has no `sina-intraday-collector`. Copying those trees over `supabase/functions` on this branch would mix unrelated WIP into the next merge. Use this snapshot when you need to reproduce or re-deploy *these two* functions.

Do not redeploy from an older `origin/main` tree. Do not force-push. This document does not authorize a new production deploy by itself.

## What was live

Times are Asia/Shanghai.

| Function | Version | Deployed at | `verify_jwt` | `ezbr_sha256` |
| --- | --- | --- | --- | --- |
| `alert-evaluator` | v16 | 2026-11-18 11:02:35 | false | `d6471b94912b9db624000c0ecb15b1344d63fe2bf62818ddb5f3c8362bf0cdef` |
| `alert-evaluator` (prior baseline) | v15 | 2026-11-18 10:43:46 | false | `3096d31d8e1520db9dba74bdc4cfed9cde955f883eae1cd5767f69ce44c3dc44` |
| `sina-intraday-collector` | v5 | 2026-11-18 10:44:46 | false | `55f621a5dbc8212ab573d900bfccb7cc07c60c42a0ff63d5fa8bc34cf5277b9c` |

This patch, on top of the then-live production baselines (evaluator v14, collector v4):

- `alert-evaluator/core/alerts.ts` (v16): adds `price_run` (4 confirmed 5m bars, 0.8% net, HH/HL, skip open/lunch, max bar share 0.7) on top of v15.
- `alert-evaluator/core/alerts.ts` (v15): `volume_spike` gains `skipSessionOpenBars` (0–6). The first N bars from 09:30 Asia/Shanghai in the rule interval are ignored. 1D rules and a skip of 0 never skip. Lunch 13:00 is not skipped.
- `sina-intraday-collector/handler.ts`: `INTRADAY_WHITELIST` is SH513310, HTGD, SZ159915, SH000300, SH000688, SZ399006. The last three are the indices themselves (Sina constituent volume), not ETF proxies.
- `sina-intraday-collector/core/types.ts` is included because the deployed store/handler type-import it. It matches the evaluator types file and is type-only at runtime.

File digests are in `MANIFEST.json`. They must stay identical to the copies under `/workspace/hive-prod-fns` that were uploaded.

Related database work (already applied, already on this branch) lives in `supabase/migrations/20261118024102_ashare_index_alerts_and_webhook_clone.sql`: `hive_clone_webhook_destination`, symbol_map rows, and the three conservative index rules (5m, 2× over 20 bars, 0.3% body, skip the 09:30 bar, 30-minute cooldown).

## Re-deploy (only if a later change requires it)

Do not deploy just because you are reading this. If you must restore *these two* functions and nothing else:

1. Cheap health read first: `select public.hive_ops_snapshot();`
2. Deploy only `alert-evaluator` and/or `sina-intraday-collector` from **this snapshot**, `entrypoint_path=index.ts`, `verify_jwt=false`.
3. Use the sanctioned Supabase `deploy_edge_function` connector (or the official CLI with a pre-authorized token). Never paste secrets into the repo or a chat.
4. Do not deploy other functions. Do not roll production back to `origin/main` for these two slugs.
5. Confirm versions and a post-cron `source_health` / candle last-bar time before considering it done.

## Local tests

From this directory, after a normal workspace `pnpm install`:

```bash
./run-tests.sh
```

The script runs the repo's vitest (`packages/core`) with `vitest.config.cjs` and `--root` set here, so this folder does not need its own `node_modules`.

- `tests/skip-session-open-and-whitelist.test.ts` covers `skipSessionOpenBars` parsing, the 09:30 skip, lunch 13:00 not skipped, the 2× / 0.3% conjunction, and the six-symbol whitelist including Sina code mapping.
- `tests/sh000688-2026-11-18-replay.test.ts` is an offline, no-lookahead replay of the production SH000688 rule on confirmed sina 5m bars already in the database. The fixture is labelled as a read-only export, not a live test event. It does not insert production alerts and must not be used to replay failed deliveries.

### Offline result for 2026-11-18 (do not change thresholds)

Bar-open times, Asia/Shanghai, confirmed 5m only, lookback is the prior 20 bars (11-17 afternoon plus earlier 11-18 bars). Production was not yet running this rule at these ticks.

| Bar | Volume / 20-bar avg | Body % | Result |
| --- | --- | --- | --- |
| 09:30 | ~5.30× | ~0.83 | **Skipped** (would have fired without the open skip) |
| 09:35 | ~2.35× | ~0.91 | **Would have fired** (outside the 09:40–10:00 window; not live then) |
| 09:40 | ~1.51× | ~0.26 | No (volume and body both short) |
| 09:45 | ~1.35× | ~0.50 | No (volume short) |
| 09:50 | ~1.53× | ~0.70 | No (volume short) |
| 09:55 | ~1.84× | ~0.44 | No (volume short) |
| 10:00 | ~1.20× | ~0.32 | No (volume short) |

From the 09:40 open (1216.757) to the 10:00 close (1244.152) the index rose about 2.25%. That is a steady lift the volume coarse screen missed: none of those five bars reached 2× the trailing average (the open bar inflates the average). A volume_spike wake is not a trend detector and can miss a smooth rally with no volume burst.

## Webhook test (already done; do not repeat)

A clearly marked TEST fixture (alert 1460, delivery 13358, HTTP 200 at 10:42:02 Asia/Shanghai) already proved `grokbot-market`. Do not insert another test alert. See `docs/webhook-destination-reuse.md`.
