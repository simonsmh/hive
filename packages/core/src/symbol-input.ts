import { SYMBOL_PATTERN } from "./symbols.js";

/** Validation failure for symbol-management writes; the web layer maps it to a 400 with the problem list. */
export class SymbolInputError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "SymbolInputError";
    this.problems = problems;
  }
}

export interface SymbolAddItem {
  symbol: string;
  /** OKX swap instId to store verbatim; null lets the collector resolve it on its next run. */
  okx_inst_id: string | null;
  yahoo_symbol: string | null;
  ths_code: string | null;
  ths_kind: string | null;
}

const THS_CODE_PATTERN = /^\d{6}\.(SH|SZ|BJ)$/;
const OKX_INST_ID_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+-SWAP$/;
const MAX_BATCH = 100;

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  problems: string[],
  context: string,
): string | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    problems.push(`${context}.${key} must be a string or null`);
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Parses the POST /api/symbols body: `{ symbols: [{ symbol, okx_inst_id?, yahoo_symbol?, ths_code?, ths_kind? }] }`.
 * A bare `{ symbol: "SOL" }` object is accepted as a one-item batch for scripting convenience.
 * Symbols are uppercased and must match the symbol_map primary-key pattern; duplicates inside
 * one batch are a client error so the response never silently drops an entry.
 */
export function parseSymbolAddInput(raw: unknown): SymbolAddItem[] {
  const problems: string[] = [];
  const record = asRecord(raw);
  if (!record) throw new SymbolInputError(["body must be a JSON object"]);

  let entries: unknown[];
  if (Array.isArray(record.symbols)) {
    entries = record.symbols;
  } else if (typeof record.symbol === "string") {
    entries = [record];
  } else {
    throw new SymbolInputError(["body must carry a symbols array (or a single symbol)"]);
  }
  if (entries.length === 0) throw new SymbolInputError(["symbols must not be empty"]);
  if (entries.length > MAX_BATCH) throw new SymbolInputError([`symbols is capped at ${MAX_BATCH} entries per request`]);

  const items: SymbolAddItem[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const context = `symbols[${index}]`;
    const item = asRecord(entry);
    if (!item) {
      problems.push(`${context} must be an object`);
      return;
    }
    const rawSymbol = item.symbol;
    if (typeof rawSymbol !== "string" || !SYMBOL_PATTERN.test(rawSymbol.trim().toUpperCase())) {
      problems.push(`${context}.symbol must match ${SYMBOL_PATTERN.source}`);
      return;
    }
    const symbol = rawSymbol.trim().toUpperCase();
    if (seen.has(symbol)) {
      problems.push(`${context}.symbol duplicates ${symbol} in this batch`);
      return;
    }
    seen.add(symbol);

    const okxInstId = optionalString(item, "okx_inst_id", problems, context);
    if (okxInstId && !OKX_INST_ID_PATTERN.test(okxInstId)) {
      problems.push(`${context}.okx_inst_id must look like BTC-USDT-SWAP`);
    }
    const yahooSymbol = optionalString(item, "yahoo_symbol", problems, context);
    const thsCode = optionalString(item, "ths_code", problems, context);
    if (thsCode && !THS_CODE_PATTERN.test(thsCode)) {
      problems.push(`${context}.ths_code must look like 600519.SH`);
    }
    const thsKind = optionalString(item, "ths_kind", problems, context);
    if (thsKind && thsKind !== "stock" && thsKind !== "index") {
      problems.push(`${context}.ths_kind must be "stock" or "index"`);
    }

    items.push({
      symbol,
      okx_inst_id: okxInstId ?? null,
      yahoo_symbol: yahooSymbol ?? null,
      ths_code: thsCode ?? null,
      ths_kind: thsKind ?? (thsCode ? "stock" : null),
    });
  });

  if (problems.length > 0) throw new SymbolInputError(problems);
  return items;
}

/** Parses `{ symbols: ["SOL", ...] }` for the batch remove endpoint. */
export function parseSymbolListInput(raw: unknown): string[] {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.symbols)) {
    throw new SymbolInputError(["body must carry a symbols array"]);
  }
  if (record.symbols.length === 0) throw new SymbolInputError(["symbols must not be empty"]);
  if (record.symbols.length > MAX_BATCH) throw new SymbolInputError([`symbols is capped at ${MAX_BATCH} entries per request`]);
  const problems: string[] = [];
  const symbols: string[] = [];
  record.symbols.forEach((value, index) => {
    if (typeof value !== "string" || !SYMBOL_PATTERN.test(value.trim().toUpperCase())) {
      problems.push(`symbols[${index}] must match ${SYMBOL_PATTERN.source}`);
      return;
    }
    const symbol = value.trim().toUpperCase();
    if (!symbols.includes(symbol)) symbols.push(symbol);
  });
  if (problems.length > 0) throw new SymbolInputError(problems);
  return symbols;
}
