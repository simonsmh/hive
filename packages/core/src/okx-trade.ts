import type { TdMode } from "./order-intent.js";
import { type OkxCredentials, okxAuthHeaders } from "./okx-signing.js";

export const TRADE_BASE_URL = "https://www.okx.com";

const NOT_FOUND_CODE = "51603";
const CONTRACT_VALUE_TTL_MS = 60 * 60_000;
/** Top-level OKX codes for key, passphrase, signature, timestamp, IP and environment problems. */
const AUTH_CODES = new Set(["50100", "50101", "50102", "50103", "50104", "50105", "50110", "50111", "50112", "50113"]);

/**
 * network: the request may or may not have reached OKX (timeout, reset, unreadable body). Callers must reconcile.
 * api: OKX answered and rejected the call. Nothing was placed.
 * http: OKX answered with a non-2xx status.
 */
export type OkxTradeErrorKind = "network" | "api" | "http";

export class OkxTradeError extends Error {
  constructor(
    message: string,
    readonly kind: OkxTradeErrorKind,
    readonly code?: string,
    readonly sCode?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "OkxTradeError";
  }

  get isAuth(): boolean {
    return this.httpStatus === 401 || (this.code !== undefined && AUTH_CODES.has(this.code));
  }
}

export interface PlacedOrder {
  ordId: string;
  clOrdId: string;
}

export interface PlacedAlgo {
  algoId: string;
  algoClOrdId: string;
}

export interface OrderTrade {
  lastPrice(instId: string): Promise<number>;
  contractValue(instId: string): Promise<number>;
  position(instId: string): Promise<{ avgPx: number } | null>;
  setLeverage(instId: string, lever: number, tdMode: TdMode): Promise<void>;
  placeOrder(body: Record<string, unknown>): Promise<PlacedOrder>;
  placeAlgo(body: Record<string, unknown>): Promise<PlacedAlgo>;
  cancelAlgos(items: { algoId: string; instId: string }[]): Promise<void>;
  findOrderByClOrdId(instId: string, clOrdId: string): Promise<{ ordId: string; state: string } | null>;
}

export interface OkxTradeOptions {
  baseUrl?: string;
  credentials: OkxCredentials;
  /** Demo trading sends x-simulated-trading: 1 on every signed request. */
  demo: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Envelope {
  code: string;
  msg: string;
  data: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : "";
}

function positiveNumber(value: unknown, field: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new OkxTradeError(`OKX ${field} is not a positive number`, "api");
  return n;
}

export class OkxTradeClient implements OrderTrade {
  private readonly baseUrl: string;
  private readonly credentials: OkxCredentials;
  private readonly demo: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly contractValues = new Map<string, { value: number; expiresAt: number }>();

  constructor(options: OkxTradeOptions) {
    this.baseUrl = options.baseUrl ?? TRADE_BASE_URL;
    this.credentials = options.credentials;
    this.demo = options.demo;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async lastPrice(instId: string): Promise<number> {
    const rows = await this.data("GET", "/api/v5/market/ticker", { query: { instId } });
    return positiveNumber(asRecord(rows[0]).last, "last price");
  }

  async contractValue(instId: string): Promise<number> {
    const cached = this.contractValues.get(instId);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const rows = await this.data("GET", "/api/v5/public/instruments", { query: { instType: "SWAP", instId } });
    const value = positiveNumber(asRecord(rows[0]).ctVal, "ctVal");
    this.contractValues.set(instId, { value, expiresAt: this.now() + CONTRACT_VALUE_TTL_MS });
    return value;
  }

  async position(instId: string): Promise<{ avgPx: number } | null> {
    const rows = await this.data("GET", "/api/v5/account/positions", {
      query: { instType: "SWAP", instId },
      signed: true,
    });
    for (const raw of rows) {
      const row = asRecord(raw);
      if (Number(text(row, "pos")) !== 0) return { avgPx: positiveNumber(row.avgPx, "avgPx") };
    }
    return null;
  }

  async setLeverage(instId: string, lever: number, tdMode: TdMode): Promise<void> {
    await this.data("POST", "/api/v5/account/set-leverage", {
      body: { instId, lever: String(lever), mgnMode: tdMode },
      signed: true,
    });
  }

  async placeOrder(body: Record<string, unknown>): Promise<PlacedOrder> {
    const rows = await this.data("POST", "/api/v5/trade/order", { body, signed: true });
    const row = asRecord(rows[0]);
    this.assertRowAccepted(row, "order");
    const ordId = text(row, "ordId");
    if (ordId === "") throw new OkxTradeError("OKX order response has no ordId", "network");
    return { ordId, clOrdId: text(row, "clOrdId") };
  }

  async placeAlgo(body: Record<string, unknown>): Promise<PlacedAlgo> {
    const rows = await this.data("POST", "/api/v5/trade/order-algo", { body, signed: true });
    const row = asRecord(rows[0]);
    this.assertRowAccepted(row, "algo order");
    const algoId = text(row, "algoId");
    if (algoId === "") throw new OkxTradeError("OKX algo response has no algoId", "network");
    return { algoId, algoClOrdId: text(row, "algoClOrdId") };
  }

  async cancelAlgos(items: { algoId: string; instId: string }[]): Promise<void> {
    if (items.length === 0) return;
    const rows = await this.data("POST", "/api/v5/trade/cancel-algos", {
      body: items.map(({ algoId, instId }) => ({ algoId, instId })),
      signed: true,
    });
    for (const raw of rows) this.assertRowAccepted(asRecord(raw), "algo cancel");
  }

  async findOrderByClOrdId(instId: string, clOrdId: string): Promise<{ ordId: string; state: string } | null> {
    const payload = await this.call("GET", "/api/v5/trade/order", { query: { instId, clOrdId }, signed: true });
    if (payload.code === NOT_FOUND_CODE) return null;
    this.assertEnvelope(payload, "/api/v5/trade/order");
    const row = asRecord(Array.isArray(payload.data) ? payload.data[0] : undefined);
    const ordId = text(row, "ordId");
    return ordId === "" ? null : { ordId, state: text(row, "state") };
  }

  private assertRowAccepted(row: Record<string, unknown>, what: string): void {
    const sCode = text(row, "sCode");
    if (sCode === "" || sCode === "0") return;
    throw new OkxTradeError(`OKX ${what} rejected (${sCode}): ${text(row, "sMsg").trim()}`, "api", undefined, sCode);
  }

  private assertEnvelope(payload: Envelope, path: string): void {
    if (payload.code !== "0") {
      throw new OkxTradeError(`OKX ${path} error ${payload.code}: ${payload.msg || "unknown"}`, "api", payload.code);
    }
  }

  private async data(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string>; body?: unknown; signed?: boolean },
  ): Promise<unknown[]> {
    const payload = await this.call(method, path, options);
    this.assertEnvelope(payload, path);
    return Array.isArray(payload.data) ? payload.data : [];
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string>; body?: unknown; signed?: boolean },
  ): Promise<Envelope> {
    const search = options.query ? new URLSearchParams(options.query).toString() : "";
    const requestPath = search === "" ? path : `${path}?${search}`;
    const bodyText = options.body === undefined ? "" : JSON.stringify(options.body);

    const headers: Record<string, string> = { accept: "application/json" };
    if (bodyText !== "") headers["content-type"] = "application/json";
    if (options.signed) {
      Object.assign(
        headers,
        await okxAuthHeaders(this.credentials, method, requestPath, new Date(this.now()).toISOString(), bodyText),
      );
      if (this.demo) headers["x-simulated-trading"] = "1";
    }

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(requestPath, this.baseUrl), {
        method,
        headers,
        body: bodyText === "" ? undefined : bodyText,
      });
    } catch (error) {
      throw new OkxTradeError(`network error calling ${path}: ${(error as Error).message}`, "network");
    }

    const raw = await response.text().catch(() => null);
    if (raw === null) throw new OkxTradeError(`OKX ${path} body could not be read`, "network");
    if (!response.ok) {
      throw new OkxTradeError(`OKX ${path} returned HTTP ${response.status}`, "http", undefined, undefined, response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OkxTradeError(`OKX ${path} returned a non-JSON body`, "network");
    }
    const record = asRecord(parsed);
    return { code: text(record, "code"), msg: text(record, "msg"), data: record.data };
  }
}
