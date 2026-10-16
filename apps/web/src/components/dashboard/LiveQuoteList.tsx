"use client";

import { useEffect, useRef, useState } from "react";
import { formatBeijingTime, formatPrice } from "@/src/modules/format";
import { useStreamStatus, useTopic } from "@/src/modules/live/stream-client";
import type { QuoteView } from "@/src/modules/quotes/mapper";

const POLL_FALLBACK_MS = 20_000;

interface QuoteApiResponse {
  quotes?: { symbol: string; price: number; ts: string }[];
}

/**
 * The quote board, live: prices merge in from the SSE stream and flash on movement.
 * If the stream drops, the list falls back to polling /api/quote so the board never
 * silently goes stale; the stream status indicator in the shell shows which mode
 * the page is in.
 */
export function LiveQuoteList({ initial }: { initial: QuoteView[] }) {
  const [quotes, setQuotes] = useState<readonly QuoteView[]>(initial);
  const [flash, setFlash] = useState<ReadonlyMap<string, "up" | "down">>(new Map());
  const status = useStreamStatus();
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const merge = (incoming: readonly QuoteView[]) => {
    const current = new Map(quotesRef.current.map((quote) => [quote.symbol, quote]));
    const nextFlash = new Map<string, "up" | "down">();
    for (const quote of incoming) {
      const previous = current.get(quote.symbol);
      if (previous && previous.price !== null && quote.price !== null && previous.price !== quote.price) {
        nextFlash.set(quote.symbol, quote.price > previous.price ? "up" : "down");
      }
      current.set(quote.symbol, quote);
    }
    setQuotes(quotesRef.current.map((quote) => current.get(quote.symbol) ?? quote));
    if (nextFlash.size > 0) {
      setFlash((previous) => new Map([...previous, ...nextFlash]));
      for (const symbol of nextFlash.keys()) {
        const existing = flashTimers.current.get(symbol);
        if (existing) clearTimeout(existing);
        flashTimers.current.set(
          symbol,
          setTimeout(() => {
            setFlash((previous) => {
              const next = new Map(previous);
              next.delete(symbol);
              return next;
            });
          }, 900),
        );
      }
    }
  };

  useTopic("quotes", (data) => {
    const incoming = (data as { quotes?: QuoteView[] } | null)?.quotes;
    if (Array.isArray(incoming)) merge(incoming);
  });

  useEffect(() => {
    if (status !== "down") return;
    const symbols = quotesRef.current.map((quote) => quote.symbol);
    if (symbols.length === 0) return;
    const timer = setInterval(() => {
      const params = new URLSearchParams({ symbols: symbols.join(","), source: "okx" });
      fetch(`/api/quote?${params.toString()}`)
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as QuoteApiResponse;
          if (Array.isArray(body.quotes)) {
            merge(body.quotes.map((row) => ({ symbol: row.symbol, price: row.price, ts: row.ts })));
          }
        })
        .catch(() => undefined);
    }, POLL_FALLBACK_MS);
    return () => clearInterval(timer);
    // The fallback loop only depends on the stream status; symbols come from the initial board.
  }, [status]);

  useEffect(
    () => () => {
      for (const timer of flashTimers.current.values()) clearTimeout(timer);
    },
    [],
  );

  return (
    <ul className="list">
      {quotes.map((quote) => (
        <li key={quote.symbol} className="quote-row">
          <strong>{quote.symbol}</strong>
          {quote.price === null ? (
            <span className="muted">暂无报价</span>
          ) : (
            <span className={`price flash-${flash.get(quote.symbol) ?? "none"}`}>{formatPrice(quote.price)}</span>
          )}
          {quote.ts ? <span className="muted quote-ts">{formatBeijingTime(quote.ts)}</span> : null}
        </li>
      ))}
    </ul>
  );
}
