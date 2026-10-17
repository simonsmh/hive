import "server-only";
import { OkxClient, rankUniverse, type UniverseEntry } from "@hive/core";
import { loadSymbolByInstId } from "./query";

export const UNIVERSE_LIMIT = 100;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; entries: UniverseEntry[] } | null = null;

/**
 * OKX perpetuals ranked by 24h turnover, annotated with which ones are
 * already tracked. Cached for a minute: the ranking moves slowly and the
 * page may poll it, while OKX rate limits are shared with the collectors.
 */
export async function loadUniverse(): Promise<UniverseEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
  const [tickers, symbolByInstId] = await Promise.all([new OkxClient().getSwapTickers(), loadSymbolByInstId()]);
  const entries = rankUniverse(tickers, symbolByInstId, UNIVERSE_LIMIT);
  cache = { at: Date.now(), entries };
  return entries;
}
