import { ParamError } from "./api";

/**
 * Tonghuashun (JQKA) public quote source.
 *
 * This is deliberately NOT "ths": the existing ths-collector reads the paid
 * HiThink API (fuyao.aicubes.cn) and only stores last_price for
 * ths_kind=stock/index, so it does not cover ETFs and must not be confused
 * with this source. "jqka" here means only the public d.10jqka.com.cn
 * endpoints below, which need no key and add no third-party dependency.
 *
 * Verified field map (2026-10-29, 513310, realhead payload):
 *   10 = last price, 6 = previous close, 7 = open, 8 = high, 9 = low,
 *   13 = volume (shares), 19 = turnover (yuan), time = Beijing time,
 *   name = security name.
 *
 * NOT returned on purpose: the five-level book. Candidate fields 24/25
 * (bid1 price/volume) and 30/31 (ask1 price/volume) could not be matched
 * against a simultaneous Sina five-level snapshot (the JQKA time field
 * lagged the fetch by ~2 minutes), and the level 2-5 fields in the payload
 * were empty strings. Guessing a book mapping would be worse than no book,
 * so v1 returns empty bid/ask arrays. A later change may fill them only
 * after a same-second Sina cross-check.
 *
 * Minute series (time/last.js): data rows are "HHMM,price,field3,field4,
 * field5;...". Only time, price and field5 are returned. Field5 sums to
 * roughly the day's total volume, so it is exposed as minute volume
 * (shares); field3/field4 (amount/average semantics) were not verified
 * and are intentionally dropped. No trend calculation lives here: the
 * minute array is raw material for a future trend feature.
 */

export const JQKA_SOURCE = "jqka";
export const MAX_DEPTH_SYMBOLS = 50;

const ASHARE_CODE_PATTERN = /^\d{6}$/;
const JQKA_BASE = "https://d.10jqka.com.cn/v2";

export class JqkaUpstreamError extends Error {
  constructor(message = "upstream unavailable") {
    super(message);
    this.name = "JqkaUpstreamError";
  }
}

export interface JqkaMinutePoint {
  /** "HH:MM" in the upstream trading day. */
  time: string;
  price: number;
  /** Minute volume in shares (field5), or null when the row omits it. */
  volume: number | null;
}

export interface JqkaDepthQuote {
  symbol: string;
  name: string;
  last: number;
  prev_close: number;
  open: number;
  high: number;
  low: number;
  /** Percent change vs previous close; denominator is always prev_close. */
  change_pct: number;
  /** Day volume in shares. */
  volume: number;
  /** Day turnover in yuan. */
  turnover: number;
  /** Upstream Beijing time string, e.g. "2026-10-29 14:18:29 北京时间". */
  ts: string;
  /** Empty in v1: five-level book fields are unverified (see module doc). */
  bid: never[];
  ask: never[];
  /** Only present when minute data was requested and fetched. */
  minute?: JqkaMinutePoint[];
  /** Upstream trading date (YYYYMMDD) for the minute series, when present. */
  minute_date?: string;
}

export function parseAshareCodes(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") {
    throw new ParamError("symbols is required (comma-separated 6-digit A-share codes)");
  }
  const codes: string[] = [];
  for (const part of raw.split(",")) {
    const code = part.trim();
    if (code === "") continue;
    if (!ASHARE_CODE_PATTERN.test(code)) {
      throw new ParamError(`invalid A-share code "${code}" (expected 6 digits)`);
    }
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length === 0) {
    throw new ParamError("symbols is required (comma-separated 6-digit A-share codes)");
  }
  if (codes.length > MAX_DEPTH_SYMBOLS) {
    throw new ParamError(`at most ${MAX_DEPTH_SYMBOLS} symbols per request`);
  }
  return codes;
}

export function toJqkaSymbol(code: string): string {
  return `hs_${code}`;
}

/** Strips a `name({...})` JSONP wrapper; rejects anything that is not JSON. */
export function parseJsonp(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") throw new JqkaUpstreamError();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new JqkaUpstreamError();
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    throw new JqkaUpstreamError();
  }
}

function toNumber(value: unknown, field: string): number {
  // Reject empty/whitespace strings first: Number("") and Number(" ") are 0,
  // which would silently turn a missing upstream field into a price of 0.
  if (typeof value === "string" && value.trim() === "") throw new JqkaUpstreamError(`upstream field ${field} is not numeric`);
  const num = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(num)) throw new JqkaUpstreamError(`upstream field ${field} is not numeric`);
  return num;
}

function toNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new JqkaUpstreamError(`upstream field ${field} is missing`);
  }
  return value;
}

export function parseRealhead(code: string, payload: unknown): JqkaDepthQuote {
  if (typeof payload !== "object" || payload === null) throw new JqkaUpstreamError();
  const items = (payload as { items?: unknown }).items;
  if (typeof items !== "object" || items === null) throw new JqkaUpstreamError();
  const f = items as Record<string, unknown>;
  const prevClose = toNumber(f["6"], "6 (prev_close)");
  const last = toNumber(f["10"], "10 (last)");
  const quote: JqkaDepthQuote = {
    symbol: code,
    name: toNonEmptyString(f["name"], "name"),
    last,
    prev_close: prevClose,
    open: toNumber(f["7"], "7 (open)"),
    high: toNumber(f["8"], "8 (high)"),
    low: toNumber(f["9"], "9 (low)"),
    change_pct: prevClose === 0 ? 0 : ((last - prevClose) / prevClose) * 100,
    volume: toNumber(f["13"], "13 (volume)"),
    turnover: toNumber(f["19"], "19 (turnover)"),
    ts: toNonEmptyString(f["time"], "time"),
    bid: [],
    ask: [],
  };
  return quote;
}

export function parseMinute(code: string, payload: unknown): { date: string; points: JqkaMinutePoint[] } {
  if (typeof payload !== "object" || payload === null) throw new JqkaUpstreamError();
  const entry = (payload as Record<string, unknown>)[toJqkaSymbol(code)];
  if (typeof entry !== "object" || entry === null) throw new JqkaUpstreamError();
  const e = entry as Record<string, unknown>;
  const date = toNonEmptyString(e["date"], "date");
  const data = toNonEmptyString(e["data"], "data");
  const points: JqkaMinutePoint[] = [];
  for (const row of data.split(";")) {
    if (row.trim() === "") continue;
    const parts = row.split(",");
    if (parts.length < 2) continue;
    const hhmm = parts[0] ?? "";
    if (!/^\d{4}$/.test(hhmm)) continue;
    if (parts[1] === undefined || parts[1].trim() === "") continue;
    const price = Number(parts[1]);
    if (!Number.isFinite(price)) continue;
    let volume: number | null = null;
    if (parts.length >= 5 && parts[4] !== "") {
      const v = Number(parts[4]);
      volume = Number.isFinite(v) ? v : null;
    }
    points.push({ time: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`, price, volume });
  }
  return { date, points };
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchJsonp(fetchFn: FetchFn, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new JqkaUpstreamError();
  }
  if (!response.ok) throw new JqkaUpstreamError();
  // Never echo the upstream body: a 502 page or partial payload must not
  // leak through as an API response; parse failure maps to the same error.
  const text = await response.text();
  return parseJsonp(text);
}

export interface DepthFetchResult {
  quote: JqkaDepthQuote | null;
  error: string | null;
}

export async function fetchDepthQuote(
  code: string,
  options: { includeMinute?: boolean; fetchFn?: FetchFn } = {},
): Promise<DepthFetchResult> {
  const fetchFn: FetchFn = options.fetchFn ?? fetch;
  try {
    const realhead = await fetchJsonp(fetchFn, `${JQKA_BASE}/realhead/${toJqkaSymbol(code)}/last.js`);
    const quote = parseRealhead(code, realhead);
    if (options.includeMinute) {
      const minutePayload = await fetchJsonp(fetchFn, `${JQKA_BASE}/time/${toJqkaSymbol(code)}/last.js`);
      const minute = parseMinute(code, minutePayload);
      quote.minute = minute.points;
      quote.minute_date = minute.date;
    }
    return { quote, error: null };
  } catch (error) {
    if (error instanceof JqkaUpstreamError) return { quote: null, error: "upstream unavailable" };
    return { quote: null, error: "upstream unavailable" };
  }
}
