# price_run: 5m structure wake, not a buy signal

`price_run` is an independent Hive alert kind. It is a coarse, reusable screen for a short session-contiguous price run on confirmed 5-minute bars. It does not require volume, it is not a buy/sell instruction, and it is not the dashboard 1-minute MA-deviation gauge. After a wake, trend analysis still belongs to the receiving bot.

## Why this shape, not the two existing alternatives

- **Dashboard `ma-deviation` (1m MA20 W).** That panel fetches live 1-minute closes (including the *forming* bar), computes per-bar `(close - MA20) / MA20 * 100`, then a 5-bar time-weighted W and `W - W_prev`. It is not persisted, is not an alert, and does not write 1-minute bars into the Nano `candles` hot table. `SH000300` is not even on that board. Reusing it as an alert would either write 1m into `candles` (rejected) or add live Sina fetches of unconfirmed bars inside `alert-evaluator`. Even a confirmed-only 1m port would change the meaning of MA20 (20 minutes vs 20 five-minute bars) and would still not match the board, which moves intra-bar every 30 seconds.
- **Existing `pct_move`.** That rule fires when the close-to-close change over `lookback` bars exceeds a threshold. A single pulse plus quiet bars can satisfy it. It has no session-gap check and no higher-high / higher-low structure. Using it with a daily-style threshold would pretend a net change is a trend.

`price_run` therefore reads the **already-collected confirmed sina 5m** series for SH000688, SZ399006 and SH000300 only.

## Detection delay vs the dashboard

A four-bar 5m run covers 20 minutes of *completed* bars. The last bar must close, the sina-intraday collector runs on `*/5` in session, and `alert-evaluator` runs every 2 minutes. Earliest practical wake is therefore: **bar close + up to ~5 minutes of collection + up to ~2 minutes of evaluation**, and webhook dispatch for this kind is **bulk** (normally up to ~2 minutes). This is slower, and confirmed, compared with the dashboard's 30-second refresh on a forming 1-minute W.

## Rule definition (plain language)

On confirmed 5m bars, look only at the most recent 4 bars ending at the latest bar (no lookahead). Fire when all of the following hold:

1. The four bars are exactly 5 minutes apart (a lunch gap or an overnight gap fails).
2. None of the four bars is the 09:30 session-open bar or the 13:00 lunch-resumption bar (open gaps and the first afternoon print are not a run).
3. Closes are strictly monotonic: four higher closes for `up`, four lower closes for `down`.
4. The last bar makes a higher high and a higher low versus the earlier three bars (`up`), or a lower low and a lower high (`down`).
5. The net move `|last.close - first.open| / first.open * 100` is at least **0.8%**.
6. The largest single-bar leg (first bar uses `|close-open|`, later bars `|close-close|`) is at most **70%** of that net move, so a one-bar pulse plus drift does not count.

There is no volume condition. Thresholds were not loosened to catch 09:45.

Each index has **two rules**, `side=up` and `side=down`, each with its own 30-minute cooldown. A same-direction continuation during cooldown is suppressed. A reversal can fire on the opposite rule without waiting for the first cooldown, and is not blocked by a `volume_spike` cooldown on a different rule. Fade without a completed opposite run is not separately alerted (that would need extra state).

Payload numbers: `side` is `1` (up) or `-1` (down), plus `net_move_pct`, `max_bar_share`, `min_move_pct`, `min_bars`, `start_ts` (bar-open epoch ms of the first bar in the window), `last_price`.

## Filters and delivery

`grokbot-market` `alert_kinds` includes `price_run` alongside `volume_spike`, `pct_move`, `ma_cross`, and `retracement`. Symbols are unchanged: the three indices plus SH513310 / SZ159915. `grokbot-news` stays news-only.

`hive_delivery_policy` leaves `price_run` on the default **bulk** path (300s stale, 900s expiry), same as `volume_spike`. The kind is not hidden inside an older kind. The receiving routine must add `price_run` to its handled kinds; until it does, a HTTP 200 only proves the destination accepted the webhook.

## TEST fixtures

To prove fan-out, insert a clearly marked fixture (`payload.test` and `payload.fixture` true, unique `dedup_key` starting `test:`). Do not insert historical market bars and do not replay failed deliveries. The 2026-11-18 fixture was alert `1461`, `dedup_key` `test:grokbot-market:price_run:20261118110247`, delivery `13376` to `grokbot-market`, HTTP 200 at 11:04:02 Asia/Shanghai. Marked `test`/`fixture`; not a market signal. The receiving routine still needs to handle `price_run` before that payload is shown as a first-class event.

## Offline replay sample (limited history)

Confirmed sina 5m for the three indices exists only from 2026-11-13 14:15 through 2026-11-18 morning (four calendar days, 122 bars each; 13 Nov is a partial afternoon; 14–15 Nov were a weekend). This is too short to state a false-positive rate or a win rate.

Under the frozen thresholds, an offline no-lookahead pass found **15** raw window hits (11 on SH000688, 4 on SZ399006, **0** on SH000300). After a 30-minute per-side cooldown, 12 would have been delivered.

Today (2026-11-18) SH000688, bar-open times Asia/Shanghai:

- First theoretical **up** run: window **09:40–09:55**. The completing bar opens 09:55 and **closes 10:00**. It was not live in production at that tick (evaluator v16 shipped 11:02:35). Do not backfill it.
- The 09:45 and 09:50 completions did **not** qualify (09:50 was a four-bar rise with only ~0.52% net, under 0.8%).
- A theoretical **down** run later completed on the 10:15 bar (window 10:00–10:15, bar closes 10:20). Separate down rule, so it would not have been suppressed by the up cooldown.

## Deploy baseline

Use `deploy/production-snapshots/2026-11-18-ashare-index-alerts/alert-evaluator` (v16) and the unchanged sina-intraday-collector v5 snapshot. Do not redeploy these functions from older `origin/main`.
