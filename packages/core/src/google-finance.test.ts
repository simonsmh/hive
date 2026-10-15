import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildGuidanceAlerts,
  eventDateOf,
  extractGuidance,
  GLANCE_RPC_ID,
  glanceRequest,
  GoogleFinanceError,
  inCallWindow,
  isConsentPage,
  parseFinhubTokens,
  parseGlanceCards,
  parseTranscriptSegments,
  quoteEarningsUrl,
  segmentHash,
  sessionNeedsRefresh,
  snapshotHash,
  SESSION_REFRESH_MS,
  splitGoogleSymbol,
  transcriptRequest,
} from "./google-finance.js";

const glanceBody = readFileSync(new URL("./fixtures/google-finance/glance-tsm-live.txt", import.meta.url), "utf8");

function body(...entries: unknown[][]): string {
  return `)]}'\n\n${entries.map((entry) => `${JSON.stringify([entry])}\n`).join("")}`;
}

function card(text: string, offset: number | null = null): unknown[] {
  return [null, "", text, null, null, "Wendell Huang", "CFO", "TSMC", offset];
}

const TRANSCRIPT_SEGMENTS = [
  [454.8, 562.02, "Good afternoon, everyone, and welcome to TSMC's third quarter 2026 earnings conference call.", 0],
  [2100.4, 2110.0, "Our fourth quarter revenue to be between 52.3 and 54.3 billion US dollars.", 1],
  [2110.5, 2120.0, "We expect gross margin to be between 65 and 67%.", 1],
  [2120.2, 2130.0, "Operating margin is expected between 56.5 and 58.5%.", 1],
  [2140.0, 2150.0, "Our 2026 capital budget is between 60 and 64 billion US dollars.", 1],
  [2160.0, 2170.0, "Full year 2026 revenue to grow approximately 44% in US dollar terms.", 1],
];

describe("request builders", () => {
  it("splits and validates Google Finance symbols", () => {
    expect(splitGoogleSymbol("TSM:NYSE")).toEqual({ exchangeSymbol: "TSM", exchange: "NYSE" });
    expect(splitGoogleSymbol("2330:TPE")).toEqual({ exchangeSymbol: "2330", exchange: "TPE" });
    expect(() => splitGoogleSymbol("TSM")).toThrow();
    expect(() => splitGoogleSymbol("tsm:nyse")).toThrow();
  });

  it("builds the quote earnings URL", () => {
    expect(quoteEarningsUrl("TSM:NYSE")).toBe("https://www.google.com/finance/quote/TSM:NYSE?tab=earnings&hl=en&gl=us");
  });

  it("encodes the glance RPC the way the HAR does", () => {
    const request = glanceRequest("TSM:NYSE", { bl: "boq_finhub-uiserver_20261013.05_p1", sid: null }, 2);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/finance/_/FinHubUi/data/batchexecute");
    expect(url.searchParams.get("rpcids")).toBe(GLANCE_RPC_ID);
    expect(url.searchParams.get("source-path")).toBe("/finance/quote/TSM:NYSE");
    expect(url.searchParams.get("f.sid")).toBe("-1");
    expect(url.searchParams.get("bl")).toBe("boq_finhub-uiserver_20261013.05_p1");
    const fReq = JSON.parse(new URLSearchParams(request.body).get("f.req") ?? "null");
    expect(fReq).toEqual([[[GLANCE_RPC_ID, JSON.stringify([[null, ["TSM", "NYSE"]]]), null, "generic"]]]);
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded;charset=UTF-8");
    expect(request.headers["x-same-domain"]).toBe("1");
  });

  it("omits bl when no token is known and uses the page session id when present", () => {
    const request = glanceRequest("TSM:NYSE", { bl: null, sid: "-1561769311453352629" }, 3);
    const url = new URL(request.url);
    expect(url.searchParams.has("bl")).toBe(false);
    expect(url.searchParams.get("f.sid")).toBe("-1561769311453352629");
  });

  it("encodes the transcript RPC the way the HAR does", () => {
    const request = transcriptRequest("TSM:NYSE", { bl: null, sid: null }, 1);
    const url = new URL(request.url);
    expect(url.pathname.endsWith("/finance.hub.proto.FinanceHubService/GetEarningsTranscript")).toBe(true);
    expect(JSON.parse(new URLSearchParams(request.body).get("f.req") ?? "null")).toEqual([
      null,
      JSON.stringify([[null, ["TSM", "NYSE"]], 0]),
    ]);
  });
});

describe("page tokens", () => {
  it("reads bl and the session id from the quote page", () => {
    const html = '<script>x("cfb2h":"boq_finhub-uiserver_20261013.05_p1","FdrFJe":"-1561769311453352629")</script>';
    expect(parseFinhubTokens(html)).toEqual({
      bl: "boq_finhub-uiserver_20261013.05_p1",
      sid: "-1561769311453352629",
      consent: false,
    });
  });

  it("returns nulls when the page has no tokens and flags consent interstitials", () => {
    expect(parseFinhubTokens("<html>nothing here</html>")).toEqual({ bl: null, sid: null, consent: false });
    expect(parseFinhubTokens('<a href="https://consent.google.com/m?continue=">')).toMatchObject({ consent: true });
    expect(isConsentPage("Before you continue to Google")).toBe(true);
  });
});

describe("glance cards", () => {
  it("parses the live Xs5i3b response into structured cards", () => {
    const cards = parseGlanceCards(glanceBody);
    expect(cards).toHaveLength(9);
    expect(cards[1]).toMatchObject({
      title: null,
      speaker: "Wendell Huang",
      speakerTitle: "CFO",
      company: "TSMC",
      offsetSec: 693,
    });
    expect(cards[1]?.text).toContain("between $52.3 billion and $54.3 billion");
    expect(cards[3]?.text).toContain("$60 billion to $64 billion");
    expect(cards.find((c) => c.title === "High NA EUV Planned for 2030")?.offsetSec).toBe(2688);
  });

  it("reports a missing result as rpc_missing, carrying the error code when present", () => {
    const errorBody = `)]}'\n\n102\n[["er",null,null,null,null,400,null,null,null,9],["di",20]]\n25\n[["e",4,null,null,138]]\n`;
    expect(() => parseGlanceCards(errorBody)).toThrowError(GoogleFinanceError);
    try {
      parseGlanceCards(errorBody);
    } catch (error) {
      expect((error as GoogleFinanceError).kind).toBe("rpc_missing");
      expect((error as Error).message).toContain("error 400");
    }
  });

  it("classifies a consent page as blocked and a non-RPC body as format", () => {
    try {
      parseGlanceCards("<!DOCTYPE html><html>consent.google.com</html>");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as GoogleFinanceError).kind).toBe("blocked");
    }
    try {
      parseGlanceCards("<html></html>");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as GoogleFinanceError).kind).toBe("format");
    }
  });

  it("drops duplicate and near-empty cards", () => {
    const cardBody = body(["wrb.fr", GLANCE_RPC_ID, JSON.stringify([["TSM", "NYSE"], [card("A long enough guidance card text."), card("A long enough guidance card text."), card("short")]])]);
    expect(parseGlanceCards(cardBody).map((c) => c.text)).toEqual(["A long enough guidance card text."]);
  });
});

describe("transcript segments", () => {
  it("parses timed segments across several frames in time order", () => {
    const payload = [
      [[null, null, null, null, null, null, null, 0, null, "predicted-pre-call"]],
      TRANSCRIPT_SEGMENTS.slice(1, 3),
      TRANSCRIPT_SEGMENTS.slice(0, 1),
      [TRANSCRIPT_SEGMENTS[5]],
    ];
    const frames = body(["wrb.fr", null, JSON.stringify(payload)], ["wrb.fr", null, JSON.stringify([null, 4839, false])]);
    const segments = parseTranscriptSegments(frames);
    expect(segments.map((s) => s.startSec)).toEqual([454.8, 2100.4, 2110.5, 2160]);
    expect(segments[0]?.text.startsWith("Good afternoon")).toBe(true);
  });

  it("returns no segments for a valid but empty transcript response", () => {
    expect(parseTranscriptSegments(body(["wrb.fr", null, "[null,4839,false]"]))).toEqual([]);
  });
});

describe("guidance extraction", () => {
  it("reads the calibration figures from the live glance cards", () => {
    const cards = parseGlanceCards(glanceBody).map((c) => c.text);
    const findings = extractGuidance(cards);
    expect(findings.revenue_guidance_usd_b?.value).toBe("52.3-54.3");
    expect(findings.gross_margin_guidance_pct?.value).toBe("65-67");
    expect(findings.capex_guidance_usd_b?.value).toBe("60-64");
    expect(findings.fy_revenue_growth_pct?.value).toBe("44");
    expect(findings.revenue_guidance_usd_b?.evidence).toContain("expects revenue between $52.3 billion");
  });

  it("reads the same figures from transcript wording, and the operating margin range", () => {
    const transcript = TRANSCRIPT_SEGMENTS.map((s) => s[2]).join(" ");
    const findings = extractGuidance([transcript]);
    expect(findings.revenue_guidance_usd_b?.value).toBe("52.3-54.3");
    expect(findings.gross_margin_guidance_pct?.value).toBe("65-67");
    expect(findings.operating_margin_guidance_pct?.value).toBe("56.5-58.5");
    expect(findings.capex_guidance_usd_b?.value).toBe("60-64");
    expect(findings.fy_revenue_growth_pct?.value).toBe("44");
  });

  it("does not treat backward-looking actuals as guidance", () => {
    const actuals = [
      "TSMC reported revenue of $46.7 billion, up 16.2% sequentially, beating guidance.",
      "Gross margin was 66.4%, diluted by the 2nm ramp.",
      "Capital expenditures from 2026 to 2028 are expected to be significantly higher than the past three years.",
    ];
    const findings = extractGuidance(actuals);
    expect(findings.gross_margin_guidance_pct).toBeUndefined();
    expect(findings.capex_guidance_usd_b).toBeUndefined();
    expect(findings.revenue_guidance_usd_b).toBeUndefined();
  });

  it("returns an empty object when there is nothing to find", () => {
    expect(extractGuidance([])).toEqual({});
    expect(extractGuidance(["Good afternoon, everyone."])).toEqual({});
  });
});

describe("alerts, hashes and windows", () => {
  const findings = extractGuidance(parseGlanceCards(glanceBody).map((c) => c.text));

  it("builds one critical guidance alert per finding with a value-keyed dedup key", () => {
    const alerts = buildGuidanceAlerts({
      symbol: "TSM",
      googleSymbol: "TSM:NYSE",
      eventDate: "2026-10-15",
      fetchedAt: "2026-10-15T06:00:00.000Z",
      findings,
    });
    expect(alerts.map((a) => a.dedupKey)).toEqual([
      "earnings:TSM:2026-10-15:revenue_guidance_usd_b:52.3-54.3",
      "earnings:TSM:2026-10-15:gross_margin_guidance_pct:65-67",
      "earnings:TSM:2026-10-15:capex_guidance_usd_b:60-64",
      "earnings:TSM:2026-10-15:fy_revenue_growth_pct:44",
    ]);
    expect(alerts.every((a) => a.kind === "earnings_guidance" && a.severity === "critical")).toBe(true);
    expect(alerts[0]?.payload).toMatchObject({ source: "google-finance-earnings", google_symbol: "TSM:NYSE", event_ts: "2026-10-15T06:00:00.000Z" });
  });

  it("changes the dedup key when the value changes and emits nothing without findings", () => {
    const changed = buildGuidanceAlerts({
      symbol: "TSM",
      googleSymbol: "TSM:NYSE",
      eventDate: "2026-10-15",
      fetchedAt: "t",
      findings: { revenue_guidance_usd_b: { value: "53-55", evidence: "x" } },
    });
    expect(changed[0]?.dedupKey).toBe("earnings:TSM:2026-10-15:revenue_guidance_usd_b:53-55");
    expect(buildGuidanceAlerts({ symbol: "TSM", googleSymbol: "TSM:NYSE", eventDate: "d", fetchedAt: "t", findings: {} })).toEqual([]);
  });

  it("gates alerts on the call window with pre and post minutes", () => {
    const call = Date.parse("2026-10-15T06:00:00Z");
    expect(inCallWindow(call, call - 30 * 60_000, 30, 180)).toBe(true);
    expect(inCallWindow(call, call - 31 * 60_000, 30, 180)).toBe(false);
    expect(inCallWindow(call, call + 180 * 60_000, 30, 180)).toBe(true);
    expect(inCallWindow(call, call + 181 * 60_000, 30, 180)).toBe(false);
    expect(inCallWindow(null, call, 30, 180)).toBe(false);
  });

  it("refreshes the page session after the TTL, not before", () => {
    const now = Date.parse("2026-10-15T06:00:00Z");
    expect(sessionNeedsRefresh(null, now)).toBe(true);
    expect(sessionNeedsRefresh(now - SESSION_REFRESH_MS + 1, now)).toBe(false);
    expect(sessionNeedsRefresh(now - SESSION_REFRESH_MS, now)).toBe(true);
    expect(sessionNeedsRefresh(now + 60_000, now)).toBe(true);
  });

  it("produces stable hashes and an event date", () => {
    const cards = parseGlanceCards(glanceBody).map((c) => c.text);
    expect(snapshotHash(cards, findings)).toBe(snapshotHash([...cards], { ...findings }));
    expect(snapshotHash(cards, findings)).not.toBe(snapshotHash(cards.slice(1), findings));
    expect(snapshotHash(cards, findings)).toHaveLength(64);
    expect(segmentHash("TSM", { startSec: 2100.4, endSec: 2110, text: "x" })).toHaveLength(64);
    expect(segmentHash("TSM", { startSec: 2100.4, endSec: 2110, text: "x" })).not.toBe(segmentHash("2330", { startSec: 2100.4, endSec: 2110, text: "x" }));
    expect(eventDateOf(Date.parse("2026-10-15T06:00:00Z"))).toBe("2026-10-15");
    expect(eventDateOf(null)).toBe("unscheduled");
  });
});
