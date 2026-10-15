import { INTERVALS, SOURCES, SYMBOL_PATTERN, type Interval, type Source } from "@hive/core";
import { ParamError } from "./api";

const MAX_SYMBOLS = 50;

export function parseSource(raw: string | null): Source {
  const value = raw ?? "okx";
  if (!(SOURCES as readonly string[]).includes(value)) {
    throw new ParamError(`source must be one of ${SOURCES.join(", ")}`);
  }
  return value as Source;
}

export function parseInterval(raw: string | null): Interval {
  if (raw === null || raw === "") throw new ParamError("interval is required");
  if (!(INTERVALS as readonly string[]).includes(raw)) {
    throw new ParamError(`interval must be one of ${INTERVALS.join(", ")}`);
  }
  return raw as Interval;
}

export function parseSymbol(raw: string | null): string {
  const symbol = (raw ?? "").trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) throw new ParamError("symbol is required and must be alphanumeric");
  return symbol;
}

export function parseSymbols(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") throw new ParamError("symbols is required (comma-separated)");
  const symbols: string[] = [];
  for (const part of raw.split(",")) {
    const symbol = part.trim().toUpperCase();
    if (symbol === "") continue;
    if (!SYMBOL_PATTERN.test(symbol)) throw new ParamError(`invalid symbol "${part.trim()}"`);
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  if (symbols.length === 0) throw new ParamError("symbols is required (comma-separated)");
  if (symbols.length > MAX_SYMBOLS) throw new ParamError(`at most ${MAX_SYMBOLS} symbols per request`);
  return symbols;
}

export function parseInteger(raw: string | null, name: string, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ParamError(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new ParamError(`${name} must be between ${min} and ${max}`);
  return value;
}

/** Accepts epoch milliseconds or any ISO-8601 string; returns ISO-8601 or null when absent. */
export function parseTimestamp(raw: string | null, name: string): string | null {
  if (raw === null || raw === "") return null;
  const value = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  if (Number.isNaN(value.getTime())) throw new ParamError(`${name} must be epoch milliseconds or an ISO-8601 timestamp`);
  return value.toISOString();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(raw: string, name: string): string {
  if (!UUID_PATTERN.test(raw)) throw new ParamError(`${name} must be a UUID`);
  return raw.toLowerCase();
}

export function parseOptionalSymbol(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return parseSymbol(raw);
}

export function parseOneOf<T extends string>(raw: string | null, name: string, allowed: readonly T[]): T | null {
  if (raw === null || raw === "") return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ParamError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return raw as T;
}

export function parseBooleanFlag(raw: string | null, name: string): boolean | null {
  if (raw === null || raw === "") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ParamError(`${name} must be true or false`);
}

export function parseToken(raw: string | null, name: string, pattern: RegExp, description: string): string | null {
  if (raw === null || raw === "") return null;
  if (!pattern.test(raw)) throw new ParamError(`${name} must match ${description}`);
  return raw;
}

const SEARCH_FORBIDDEN_CHARS = /[,()"\\*]/;
const MAX_SEARCH_LENGTH = 100;

/** Free-text search term. Characters that would break PostgREST filter syntax are rejected rather than escaped. */
export function parseSearchTerm(raw: string | null, name: string): string | null {
  const term = (raw ?? "").trim();
  if (term === "") return null;
  if (term.length > MAX_SEARCH_LENGTH) throw new ParamError(`${name} must be at most ${MAX_SEARCH_LENGTH} characters`);
  if (SEARCH_FORBIDDEN_CHARS.test(term)) throw new ParamError(`${name} must not contain , ( ) " \\ or *`);
  return term;
}
