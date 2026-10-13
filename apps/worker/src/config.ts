import { DEFAULT_OKX_BASE_URL, parseSymbolList } from "@hive/core";

export interface WorkerConfig {
  databaseUrl: string;
  /** PEM CA certificate for the Supabase Postgres endpoint; when absent TLS is accepted without CA pinning. */
  databaseCaCert: string | undefined;
  symbols: string[];
  pollIntervalMs: number;
  requestIntervalMs: number;
  okxBaseUrl: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const databaseUrl = env.SUPABASE_DB_URL;
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");

  const pollSeconds = Number(env.HIVE_POLL_INTERVAL_SECONDS ?? "15");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 5 || pollSeconds > 300) {
    throw new Error("HIVE_POLL_INTERVAL_SECONDS must be between 5 and 300");
  }

  return {
    databaseUrl,
    databaseCaCert: env.SUPABASE_DB_CA_CERT ? env.SUPABASE_DB_CA_CERT.replace(/\\n/g, "\n") : undefined,
    symbols: parseSymbolList(env.HIVE_SYMBOLS),
    pollIntervalMs: pollSeconds * 1000,
    requestIntervalMs: 120,
    okxBaseUrl: env.OKX_BASE_URL ?? DEFAULT_OKX_BASE_URL,
  };
}

export function sslOptionsFor(databaseUrl: string, caCert: string | undefined): false | { ca: string; rejectUnauthorized: true } | { rejectUnauthorized: false } {
  const host = new URL(databaseUrl).hostname;
  if (LOCAL_HOSTS.has(host)) return false;
  if (caCert) return { ca: caCert, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}
