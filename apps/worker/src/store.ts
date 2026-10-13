import type pg from "pg";
import type { Candle, Interval, Source } from "@hive/core";

export interface QuoteRow {
  symbol: string;
  price: number;
  ts: number;
}

export interface Store {
  upsertSymbolMap(symbol: string, okxInstId: string): Promise<void>;
  upsertQuote(symbol: string, source: Source, quote: QuoteRow): Promise<void>;
  upsertCandles(symbol: string, source: Source, interval: Interval, candles: readonly Candle[]): Promise<number>;
  recordSourceSuccess(source: Source): Promise<void>;
  recordSourceFailure(source: Source, error: string): Promise<void>;
}

export function createStore(db: Pick<pg.Pool, "query">): Store {
  return {
    async upsertSymbolMap(symbol, okxInstId) {
      await db.query(
        `insert into symbol_map (symbol, okx_inst_id, updated_at)
         values ($1, $2, now())
         on conflict (symbol) do update set okx_inst_id = excluded.okx_inst_id, updated_at = now()`,
        [symbol, okxInstId],
      );
    },

    async upsertQuote(symbol, source, quote) {
      await db.query(
        `insert into quotes_latest (symbol, source, price, ts, updated_at)
         values ($1, $2, $3, to_timestamp($4::double precision / 1000), now())
         on conflict (symbol, source) do update
           set price = excluded.price, ts = excluded.ts, updated_at = now()
           where excluded.ts >= quotes_latest.ts`,
        [symbol, source, quote.price, quote.ts],
      );
    },

    async upsertCandles(symbol, source, interval, candles) {
      if (candles.length === 0) return 0;
      await db.query(
        `insert into candles (symbol, source, interval, ts, open, high, low, close, volume, vol_ccy, confirmed, updated_at)
         select $1, $2, $3, to_timestamp(t.ts_ms::double precision / 1000), t.open, t.high, t.low, t.close, t.volume, t.vol_ccy, t.confirmed, now()
         from unnest($4::bigint[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::boolean[])
           as t(ts_ms, open, high, low, close, volume, vol_ccy, confirmed)
         on conflict (symbol, source, interval, ts) do update
           set open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
               volume = excluded.volume, vol_ccy = excluded.vol_ccy, confirmed = excluded.confirmed,
               updated_at = now()`,
        [
          symbol,
          source,
          interval,
          candles.map((c) => c.ts),
          candles.map((c) => c.open),
          candles.map((c) => c.high),
          candles.map((c) => c.low),
          candles.map((c) => c.close),
          candles.map((c) => c.volume),
          candles.map((c) => c.volCcy),
          candles.map((c) => c.confirmed),
        ],
      );
      return candles.length;
    },

    async recordSourceSuccess(source) {
      await db.query(
        `insert into source_health (source, last_success_at, consecutive_failures, last_error, updated_at)
         values ($1, now(), 0, null, now())
         on conflict (source) do update
           set last_success_at = now(), consecutive_failures = 0, last_error = null, updated_at = now()`,
        [source],
      );
    },

    async recordSourceFailure(source, error) {
      await db.query(
        `insert into source_health (source, consecutive_failures, last_error, updated_at)
         values ($1, 1, $2, now())
         on conflict (source) do update
           set consecutive_failures = source_health.consecutive_failures + 1, last_error = excluded.last_error, updated_at = now()`,
        [source, error.slice(0, 500)],
      );
    },
  };
}
