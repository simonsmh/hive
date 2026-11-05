import { describe, expect, it } from "vitest";
import {
  buildTelegramChartConfig,
  buildTelegramChartUrl,
  computeTelegramBackoffSeconds,
  deliverTelegramAlert,
  formatBeijingTime,
  formatTelegramAlertMessage,
  formatVolume,
  sendTelegramMessage,
  sendTelegramPhoto,
  TELEGRAM_CHART_MAX_URL_LENGTH,
} from "./telegram.js";

// barTs 2026-11-02 13:30 Beijing = 05:30 UTC.
const BAR_TS = Date.UTC(2026, 10, 2, 5, 30, 0);

const ADVICE = /买入|卖出|做多|做空|建仓|加仓|减仓|止损|止盈|抄底|跑路|清仓/;

function volumeSpikePayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "alert",
    id: 428,
    kind: "volume_spike",
    severity: "warning",
    symbol: "SH513310",
    source: "sina",
    triggered_at: "2026-11-02T05:36:10.244421+00:00",
    // Flat shape written by alert-evaluator buildAlert: the numbers sit directly on payload.
    payload: {
      bar_ts: new Date(BAR_TS).toISOString(),
      interval: "15m",
      last_price: 3.883,
      last_volume: 208_300_000,
      observed_multiple: 2.35,
      multiple: 2,
      lookback: 6,
    },
    ...overrides,
  };
}

function retracementPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "alert",
    id: 500,
    kind: "retracement",
    severity: "warning",
    symbol: "XAU",
    source: "yahoo",
    triggered_at: "2026-11-03T13:45:00.000Z",
    payload: {
      bar_ts: new Date(Date.UTC(2026, 10, 3, 13, 30, 0)).toISOString(),
      interval: "15m",
      is_top: 1,
      last_price: 4012.5,
      anchor_price: 4040,
      retrace_pct: 0.6807,
      lookback: 20,
      min_retrace_pct: 0.3,
    },
    ...overrides,
  };
}

/** 30 ascending 15-minute candles with a clear high to anchor against. */
function candles(count = 30) {
  const start = Date.UTC(2026, 10, 3, 5, 30, 0);
  return Array.from({ length: count }, (_, i) => {
    const base = 4000 + i * 1.5;
    return {
      ts: start + i * 900_000,
      open: base,
      high: base + 6,
      low: base - 6,
      close: i === count - 1 ? base - 4 : base + 1,
    };
  });
}

describe("formatBeijingTime", () => {
  it("renders epoch ms in Asia/Shanghai", () => {
    expect(formatBeijingTime(BAR_TS)).toBe("11-02 13:30");
  });

  it("renders ISO strings and rejects garbage", () => {
    expect(formatBeijingTime("2026-11-02T05:36:10.244421+00:00")).toBe("11-02 13:36");
    expect(formatBeijingTime("not a date")).toBeNull();
    expect(formatBeijingTime(null)).toBeNull();
  });
});

describe("formatVolume", () => {
  it("uses 亿份 / 万份 / 份", () => {
    expect(formatVolume(208_300_000)).toBe("2.08亿份");
    expect(formatVolume(50_000)).toBe("5.0万份");
    expect(formatVolume(900)).toBe("900份");
  });
});

describe("formatTelegramAlertMessage: retracement", () => {
  it("reads as structured lines with a plain-language interpretation", () => {
    const lines = formatTelegramAlertMessage(retracementPayload()).split("\n");
    expect(lines[0]).toBe("疑似顶部 · XAU");
    expect(lines[1]).toBe("现价 4012.5");
    expect(lines[2]).toBe("高点锚 4040");
    expect(lines[3]).toBe("偏离 -0.6807%");
    expect(lines[4]).toContain("回落 0.6807%");
    // One fact per line, not a comma-joined number dump.
    expect(lines.some((line) => line.includes("，触发价") || line.includes("，锚"))).toBe(false);
  });

  it("describes a suspected bottom as a rebound off the low", () => {
    const message = formatTelegramAlertMessage(
      retracementPayload({
        symbol: "CL",
        payload: {
          bar_ts: new Date(Date.UTC(2026, 10, 3, 13, 30, 0)).toISOString(),
          interval: "15m",
          is_top: 0,
          last_price: 61.4,
          anchor_price: 60.9,
          retrace_pct: 0.821,
          lookback: 20,
          min_retrace_pct: 0.3,
        },
      }),
    );
    expect(message).toContain("疑似底部 · CL");
    expect(message).toContain("低点锚 60.9");
    expect(message).toContain("偏离 +0.821%");
    expect(message).toContain("回升 0.821%");
  });

  it("renders the bar time from the evaluator's bar_ts field", () => {
    // Regression: the alert payload carries bar_ts, not barTs; reading the wrong key dropped this line.
    const message = formatTelegramAlertMessage(retracementPayload());
    expect(message).toContain("bar 时间 11-03 21:30（北京时间）");
    expect(message).toContain("触发时间 11-03 21:45（北京时间）");
  });

  it("never contains trading advice wording", () => {
    expect(formatTelegramAlertMessage(retracementPayload())).not.toMatch(ADVICE);
  });
});

describe("formatTelegramAlertMessage: volume spike", () => {
  it("reports the measured multiple from observed_multiple and the threshold separately", () => {
    const message = formatTelegramAlertMessage(volumeSpikePayload());
    const lines = message.split("\n");
    expect(lines[0]).toBe("放量 · SH513310");
    expect(lines[1]).toBe("现价 3.883");
    expect(lines[2]).toBe("实测 2.35 倍");
    expect(lines[3]).toBe("阈值 2 倍");
    expect(lines[4]).toBe("窗口 前 6 根均量");
    expect(lines[5]).toBe("成交量 2.08亿份");
    expect(message).toContain("成交量为前 6 根均量的 2.35 倍，已达 2 倍阈值");
    expect(message).not.toMatch(ADVICE);
  });

  it("mentions the threshold as the threshold, never as the measured ratio", () => {
    const message = formatTelegramAlertMessage(
      volumeSpikePayload({
        payload: {
          bar_ts: new Date(BAR_TS).toISOString(),
          interval: "15m",
          // Just over the line: an observed ratio near the threshold is still the observed one.
          last_price: 3.883,
          last_volume: 1_000_000,
          observed_multiple: 2.01,
          multiple: 2,
          lookback: 6,
        },
      }),
    );
    expect(message).toContain("实测 2.01 倍");
    expect(message).toContain("阈值 2 倍");
    expect(message).not.toContain("达到 2 倍触发线");
  });

  it("does not fabricate a multiple when the payload has none", () => {
    const message = formatTelegramAlertMessage({
      kind: "volume_spike",
      symbol: "SH513310",
      payload: { bar_ts: new Date(BAR_TS).toISOString(), last_price: 3.883, multiple: 2 },
    });
    expect(message).toContain("实测倍数未记录");
    expect(message).toContain("阈值 2 倍");
  });

  it("falls back gracefully on a bare payload", () => {
    const message = formatTelegramAlertMessage({ kind: "volume_spike", symbol: "SH513310" });
    expect(message).toContain("放量 · SH513310");
    expect(message).toContain("实测倍数未记录");
  });
});

describe("formatTelegramAlertMessage: other kinds", () => {
  it("formats a pct move with direction and prices", () => {
    const message = formatTelegramAlertMessage({
      kind: "pct_move",
      symbol: "SNDK",
      triggered_at: "2026-11-02T02:11:20.16979+00:00",
      payload: {
        bar_ts: new Date(Date.UTC(2026, 10, 2, 2, 10, 0)).toISOString(),
        details: { last_price: 101, earlier_price: 100, pct: 1.0426 },
      },
    });
    expect(message).toContain("异动 · SNDK");
    expect(message).toContain("100 → 101（+1.0426%）");
  });

  it("formats a strategy execution receipt without inventing fields", () => {
    const message = formatTelegramAlertMessage({
      kind: "strategy_execution",
      symbol: "SOXL",
      triggered_at: "2026-11-03T00:00:10.000Z",
      payload: {
        bar_ts: new Date(Date.UTC(2026, 10, 3, 0, 0, 0)).toISOString(),
        binding_name: "soxl-close",
        details: { action: "close", inst_id: "SOXL-USDT-SWAP", sz: "0.03", status: "acked", ord_id: "123", reason: null },
      },
    });
    expect(message).toContain("策略执行 · SOXL");
    expect(message).toContain("close SOXL-USDT-SWAP 0.03 → acked（123）");
  });

  it("never embeds credentials", () => {
    const message = formatTelegramAlertMessage(volumeSpikePayload());
    expect(message).not.toMatch(/bot[0-9]+:/i);
    expect(message).not.toContain("FAKE");
  });
});

describe("buildTelegramChartUrl", () => {
  function params(url: string): URLSearchParams {
    return new URL(url).searchParams;
  }

  it("builds a quickchart URL with candles, an anchor line and a trigger marker", () => {
    const url = buildTelegramChartUrl({
      candles: candles(),
      anchorPrice: 4040,
      anchorLabel: "高点锚",
      triggerPrice: 4039,
    });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin + parsed.pathname).toBe("https://quickchart.io/chart");
    expect(parsed.searchParams.get("v")).toBe("3");
    // Phone-sized, white background: readable at a glance.
    expect(parsed.searchParams.get("w")).toBe("720");
    expect(parsed.searchParams.get("h")).toBe("440");
    expect(url!.length).toBeLessThanOrEqual(TELEGRAM_CHART_MAX_URL_LENGTH);

    // QuickChart shorthand: unquoted keys, single-quoted strings.
    const c = params(url!).get("c")!;
    expect(c.startsWith("{type:'candlestick',data:{datasets:[")).toBe(true);
    expect(c).toContain("{type:'candlestick',label:'K线',data:[");
    expect(c).toContain("{type:'line',label:'高点锚 4040'");
    expect(c).toContain("{type:'scatter',label:'触发 4039'");
    // No volume sub-plot: two axes, price only.
    expect(c).toContain("scales:{x:{type:'linear'");
    expect(c).not.toMatch(/volume/i);
  });

  it("keeps the URL short enough for the Bot API at the 30-bar cap", () => {
    const url = buildTelegramChartUrl({
      candles: candles(60),
      anchorPrice: 123_456.7891,
      anchorLabel: "高点锚",
      triggerPrice: 123_450.1234,
    });
    expect(url).not.toBeNull();
    // Six-digit prices are the worst case; the URL must still fit well under Telegram's limit.
    expect(url!.length).toBeLessThanOrEqual(TELEGRAM_CHART_MAX_URL_LENGTH);
    const candleData = params(url!).get("c")!.split("{type:'line'")[0]!;
    expect(candleData.match(/\{x:\d+,o:/g)).toHaveLength(30);
  });

  it("returns null when there is nothing to draw", () => {
    expect(buildTelegramChartUrl({ candles: [] })).toBeNull();
    expect(buildTelegramChartUrl({ candles: candles(1) })).toBeNull();
  });

  it("rejects a series with a non-finite candle instead of drawing a chart with holes", () => {
    const broken = [...candles(5), { ts: 0, open: Number.NaN, high: 1, low: 0, close: 1 }];
    expect(buildTelegramChartUrl({ candles: broken })).toBeNull();
    // A bar whose range is inverted is corrupt data too.
    const inverted = [...candles(5), { ts: 0, open: 1, high: 1, low: 2, close: 1 }];
    expect(buildTelegramChartUrl({ candles: inverted })).toBeNull();
  });

  it("builds a config without anchor or marker for a plain price chart", () => {
    const config = buildTelegramChartConfig({ candles: candles(4) }) as {
      data: { datasets: { type: string; data: { x: number }[] }[] };
    };
    expect(config.data.datasets).toHaveLength(1);
    expect(config.data.datasets[0]!.data.map((point) => point.x)).toEqual([0, 1, 2, 3]);
  });

  it("uses the most recent 30 bars and indices as x", () => {
    const config = buildTelegramChartConfig({ candles: candles(40) }) as {
      data: { datasets: { data: { x: number; c: number }[] }[] };
    };
    const data = config.data.datasets[0]!.data;
    expect(data).toHaveLength(30);
    expect(data[0]!.x).toBe(0);
    expect(data[29]!.x).toBe(29);
    // Last drawn candle is the newest input candle.
    expect(data[29]!.c).toBe(candles(40)[39]!.close);
  });
});

describe("deliverTelegramAlert", () => {
  function jsonResponse(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function recorder(handlers: Record<string, () => Response | Promise<Response>>) {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const impl = (async (url: string, init: { body?: string }) => {
      const method = String(url).split("/").pop()!;
      calls.push({ method, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected call to ${method}`);
      return handler();
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const chart = { candles: candles(), anchorPrice: 4040, anchorLabel: "高点锚", triggerPrice: 4039 };

  it("sends one photo message with the alert text as caption", async () => {
    const { impl, calls } = recorder({ sendPhoto: () => jsonResponse(200, { ok: true }) });
    const result = await deliverTelegramAlert(impl, "https://api.telegram.org", "FAKE_TOKEN", "123", "拐点文案", chart);
    expect(result.ok).toBe(true);
    expect(result.withPhoto).toBe(true);
    expect(result.photoError).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(calls[0]!.body.caption).toBe("拐点文案");
    expect(String(calls[0]!.body.photo)).toContain("quickchart.io/chart");
  });

  it("degrades to text when the photo call fails, so the alert is never lost", async () => {
    const { impl, calls } = recorder({
      sendPhoto: () => jsonResponse(400, { ok: false, description: "Bad Request: failed to get HTTP URL content" }),
      sendMessage: () => jsonResponse(200, { ok: true }),
    });
    const result = await deliverTelegramAlert(impl, "https://api.telegram.org", "FAKE_TOKEN", "123", "拐点文案", chart);
    expect(result.ok).toBe(true);
    expect(result.withPhoto).toBe(false);
    expect(result.photoError).toContain("failed to get HTTP URL content");
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(calls[1]!.body.text).toBe("拐点文案");
  });

  it("degrades to text when the photo request throws", async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      const method = String(url).split("/").pop()!;
      calls.push(method);
      if (method === "sendPhoto") throw new Error("socket hang up");
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    const result = await deliverTelegramAlert(impl, "https://api.telegram.org", "FAKE_TOKEN", "123", "文案", chart);
    expect(result.ok).toBe(true);
    expect(result.withPhoto).toBe(false);
    expect(result.photoError).toContain("socket hang up");
    expect(calls).toEqual(["sendPhoto", "sendMessage"]);
  });

  it("sends text only when no chart is available", async () => {
    const { impl, calls } = recorder({ sendMessage: () => jsonResponse(200, { ok: true }) });
    const result = await deliverTelegramAlert(impl, "https://api.telegram.org", "FAKE_TOKEN", "123", "文案", null);
    expect(result.withPhoto).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
  });

  it("sends text only when the chart is too sparse to plot", async () => {
    const { impl, calls } = recorder({ sendMessage: () => jsonResponse(200, { ok: true }) });
    const result = await deliverTelegramAlert(impl, "https://api.telegram.org", "FAKE_TOKEN", "123", "文案", {
      candles: candles(1),
    });
    expect(result.withPhoto).toBe(false);
    expect(result.photoError).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
  });

  it("reports failure when both the photo and the text fallback fail", async () => {
    const { impl } = recorder({
      sendPhoto: () => jsonResponse(500, { ok: false, description: "photo boom" }),
      sendMessage: () => jsonResponse(500, { ok: false, description: "text boom" }),
    });
    const result = await deliverTelegramAlert(impl, "https://api.telegram.org", "FAKE_TOKEN", "123", "文案", chart);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("text boom");
    expect(result.status).toBe(500);
  });

  it("does not retry as text on 429: the rate limit applies to the chat", async () => {
    const { impl, calls } = recorder({
      sendPhoto: () => jsonResponse(429, { ok: false, description: "Too Many Requests", parameters: { retry_after: 30 } }),
    });
    const result = await deliverTelegramAlert(impl, "https://api.telegram.org", "FAKE_TOKEN", "123", "文案", chart);
    expect(result.ok).toBe(false);
    expect(result.retryAfterSeconds).toBe(30);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
  });
});

describe("computeTelegramBackoffSeconds", () => {
  it("doubles from 30s and caps at 1h", () => {
    expect(computeTelegramBackoffSeconds(1)).toBe(30);
    expect(computeTelegramBackoffSeconds(2)).toBe(60);
    expect(computeTelegramBackoffSeconds(3)).toBe(120);
    expect(computeTelegramBackoffSeconds(99)).toBe(3600);
  });
});

describe("sendTelegramMessage", () => {
  function jsonResponse(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("posts to the Bot API path with chat_id and text", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: { body?: string }) => {
      seen.push({ url, body: JSON.parse(init.body ?? "{}") });
      return jsonResponse(200, { ok: true, result: { message_id: 1 } });
    }) as unknown as typeof fetch;
    const result = await sendTelegramMessage(fetchImpl, "https://api.telegram.org", "FAKE_TOKEN", "123456789", "hello");
    expect(result).toEqual({ ok: true, status: 200, error: null, retryAfterSeconds: null });
    expect(seen).toHaveLength(1);
    const first = seen[0];
    expect(first).toBeDefined();
    expect(first?.url).toBe("https://api.telegram.org/botFAKE_TOKEN/sendMessage");
    expect(first?.body).toEqual({ chat_id: "123456789", text: "hello", disable_web_page_preview: true });
  });

  it("surfaces Telegram 429 with retry_after", async () => {
    const fetchImpl = (async () =>
      jsonResponse(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 42 } })) as unknown as typeof fetch;
    const result = await sendTelegramMessage(fetchImpl, "https://api.telegram.org", "FAKE_TOKEN", "123456789", "hello");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it("reports a failed request without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await sendTelegramMessage(fetchImpl, "https://api.telegram.org", "FAKE_TOKEN", "123456789", "hello");
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain("network down");
  });
});

describe("sendTelegramPhoto", () => {
  it("posts chat_id, photo and caption to the sendPhoto path", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (input: string, init: { body?: string }) => {
      url = input;
      body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendTelegramPhoto(fetchImpl, "https://api.telegram.org/", "FAKE_TOKEN", "123", "https://img/x.png", "caption");
    expect(result.ok).toBe(true);
    expect(url).toBe("https://api.telegram.org/botFAKE_TOKEN/sendPhoto");
    expect(body).toEqual({ chat_id: "123", photo: "https://img/x.png", caption: "caption" });
  });
});
