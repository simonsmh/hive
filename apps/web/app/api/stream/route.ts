import { authorize, handle } from "../../../lib/api";
import { loadRecentAlerts } from "../../../src/modules/alerts/query";
import { loadSourceHealth } from "../../../src/modules/health/query";
import { digestHealth, digestNewest, digestQuotes } from "../../../src/modules/live/digest";
import { loadRecentNews } from "../../../src/modules/news/query";
import { buildQuoteBoard } from "../../../src/modules/quotes/mapper";
import { loadEnabledSymbols, loadLatestQuotes } from "../../../src/modules/quotes/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUOTES_TICK_MS = 5_000;
const SLOW_TICK_MS = 15_000;
const HEARTBEAT_MS = 15_000;
/** Close before platform function limits do; EventSource reconnects on its own. */
const MAX_CONNECTION_MS = 55_000;

/**
 * Server-Sent Events feed for the dashboard's live views. Each tick recomputes cheap
 * content digests and only emits when something actually changed:
 * - `quotes` carries the full quote board (small) and fires on any price move;
 * - `news` / `alerts` / `health` carry a lightweight change signal, and the client
 *   refetches through the REST API or refreshes the server-rendered panel.
 * A loader failure skips that tick instead of killing the stream.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const encoder = new TextEncoder();
    let closed = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const timers: ReturnType<typeof setInterval>[] = [];

    const stop = () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      try {
        controllerRef?.close();
      } catch {
        // The client already went away.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            stop();
          }
        };

        let lastQuotes = "";
        const tickQuotes = async () => {
          try {
            const symbols = await loadEnabledSymbols();
            const rows = await loadLatestQuotes(symbols);
            const digest = digestQuotes(rows);
            if (digest !== lastQuotes) {
              lastQuotes = digest;
              send("quotes", { quotes: buildQuoteBoard(symbols, rows) });
            }
          } catch {
            // Skip this tick; the next one retries.
          }
        };

        let lastNews = "";
        let lastAlerts = "";
        let lastHealth = "";
        const tickSlow = async () => {
          try {
            const { events, items } = await loadRecentNews();
            const digest = digestNewest(
              [String(events[0]?.id ?? ""), String(items[0]?.id ?? "")],
              events.length + items.length,
            );
            if (digest !== lastNews) {
              lastNews = digest;
              send("news", { at: new Date().toISOString(), events: events.length, newestId: String(events[0]?.id ?? "") });
            }
          } catch {
            // Skip this tick.
          }
          try {
            const alerts = await loadRecentAlerts();
            const digest = digestNewest(
              alerts.slice(0, 10).map((alert) => `${alert.id}:${alert.resolved_at ?? ""}`),
              alerts.length,
            );
            if (digest !== lastAlerts) {
              lastAlerts = digest;
              const newest = alerts[0];
              send("alerts", {
                at: new Date().toISOString(),
                alerts: alerts.length,
                newest: newest ? `${newest.id}:${newest.resolved_at ?? ""}` : "",
              });
            }
          } catch {
            // Skip this tick.
          }
          try {
            const rows = await loadSourceHealth();
            const digest = digestHealth(rows);
            if (digest !== lastHealth) {
              lastHealth = digest;
              send("health", { at: new Date().toISOString(), digest });
            }
          } catch {
            // Skip this tick.
          }
        };

        send("ready", { at: new Date().toISOString() });
        void tickQuotes();
        void tickSlow();
        timers.push(setInterval(() => void tickQuotes(), QUOTES_TICK_MS));
        timers.push(setInterval(() => void tickSlow(), SLOW_TICK_MS));
        timers.push(
          setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`: hb\n\n`));
            } catch {
              stop();
            }
          }, HEARTBEAT_MS),
        );
        setTimeout(stop, MAX_CONNECTION_MS);
        request.signal.addEventListener("abort", stop);
      },
      cancel() {
        stop();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  });
}
