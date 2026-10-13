import pg from "pg";
import { OkxClient, pickSwapInstId, runPollCycle, type PollTarget } from "@hive/core";
import { loadWorkerConfig, sslOptionsFor } from "./config.js";
import { createStore } from "./store.js";

/** Session-level advisory lock key. Only the session holding it polls OKX. */
const WORKER_LOCK_KEY = 7310001;
const LEADER_RETRY_MS = 10_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const MIN_RATE_LIMIT_BACKOFF_MS = 30_000;

const log = (message: string) => console.info(`[worker ${new Date().toISOString()}] ${message}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function acquireLeadership(lock: pg.Client): Promise<void> {
  for (;;) {
    const { rows } = await lock.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [WORKER_LOCK_KEY]);
    if (rows[0]?.locked) {
      log("leadership acquired; this instance will poll OKX");
      return;
    }
    log("another worker holds the advisory lock; standing by");
    await sleep(LEADER_RETRY_MS);
  }
}

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const ssl = sslOptionsFor(config.databaseUrl, config.databaseCaCert);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 4 });
  const lock = new pg.Client({ connectionString: config.databaseUrl, ssl });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    await lock.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  lock.on("error", (error) => {
    log(`lock connection lost: ${error.message}`);
    process.exit(1);
  });

  await lock.connect();
  await acquireLeadership(lock);

  const okx = new OkxClient({ baseUrl: config.okxBaseUrl, minIntervalMs: config.requestIntervalMs });
  const store = createStore(pool);

  const instruments = await okx.getInstruments("SWAP");
  const targets: PollTarget[] = [];
  for (const symbol of config.symbols) {
    const instId = pickSwapInstId(symbol, instruments);
    if (!instId) {
      log(`no live OKX perpetual found for ${symbol}; skipping`);
      continue;
    }
    await store.upsertSymbolMap(symbol, instId);
    targets.push({ symbol, instId });
  }
  if (targets.length === 0) throw new Error("no OKX instruments resolved; check HIVE_SYMBOLS");
  log(`polling ${targets.map((t) => `${t.symbol}=${t.instId}`).join(", ")} every ${config.pollIntervalMs / 1000}s`);

  let rateLimitBackoffMs = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      const result = await runPollCycle({ client: okx, store, targets, log });
      log(`cycle ok=${result.successes} failed=${result.failures} dbErrors=${result.writeErrors}`);
      rateLimitBackoffMs = result.rateLimited
        ? Math.min(Math.max(rateLimitBackoffMs * 2, MIN_RATE_LIMIT_BACKOFF_MS), MAX_RATE_LIMIT_BACKOFF_MS)
        : 0;
    } catch (error) {
      log(`cycle error: ${(error as Error).message}`);
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(config.pollIntervalMs - elapsed, rateLimitBackoffMs));
  }
}

main().catch((error: unknown) => {
  console.error(`[worker] fatal: ${(error as Error).stack ?? String(error)}`);
  process.exit(1);
});
