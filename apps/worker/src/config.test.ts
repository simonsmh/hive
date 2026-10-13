import { describe, expect, it } from "vitest";
import { DEFAULT_SYMBOLS } from "@hive/core";
import { loadWorkerConfig, sslOptionsFor } from "./config.js";

describe("loadWorkerConfig", () => {
  it("requires SUPABASE_DB_URL", () => {
    expect(() => loadWorkerConfig({})).toThrow(/SUPABASE_DB_URL/);
  });

  it("applies defaults for symbols and poll interval", () => {
    const config = loadWorkerConfig({ SUPABASE_DB_URL: "postgresql://u:p@localhost:5432/postgres" });
    expect(config.symbols).toEqual([...DEFAULT_SYMBOLS]);
    expect(config.pollIntervalMs).toBe(15_000);
  });

  it("validates the poll interval range", () => {
    const base = { SUPABASE_DB_URL: "postgresql://u:p@localhost:5432/postgres" };
    expect(() => loadWorkerConfig({ ...base, HIVE_POLL_INTERVAL_SECONDS: "2" })).toThrow(/between 5 and 300/);
    expect(() => loadWorkerConfig({ ...base, HIVE_POLL_INTERVAL_SECONDS: "abc" })).toThrow(/between 5 and 300/);
    expect(loadWorkerConfig({ ...base, HIVE_POLL_INTERVAL_SECONDS: "20" }).pollIntervalMs).toBe(20_000);
  });
});

describe("sslOptionsFor", () => {
  it("disables TLS for local databases", () => {
    expect(sslOptionsFor("postgresql://postgres:postgres@localhost:54329/postgres", undefined)).toBe(false);
  });

  it("pins the CA when provided", () => {
    expect(sslOptionsFor("postgresql://u:p@db.example.com:5432/postgres", "PEM")).toEqual({
      ca: "PEM",
      rejectUnauthorized: true,
    });
  });
});
