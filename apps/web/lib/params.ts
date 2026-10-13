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
