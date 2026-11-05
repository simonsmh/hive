/**
 * Telegram delivery for Hive alerts.
 *
 * This module is pure: it formats an alert payload into a readable Chinese
 * Telegram message (optionally with a chart image) and posts it through the
 * Bot API. It never sees, logs, or embeds a bot token or chat id in the
 * message itself; the dispatcher supplies those per delivery from
 * Vault-decrypted claim rows and keeps them in memory only.
 */

export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

export const TELEGRAM_MAX_DELIVERY_ATTEMPTS = 6;
export const TELEGRAM_MAX_BACKOFF_SECONDS = 3600;
const TELEGRAM_BASE_BACKOFF_SECONDS = 30;

/** Delay before the next attempt, after `attempt` failed attempts (1-based): 30s, 60s, 120s,... capped at 1h. Mirrors the webhook dispatcher. */
export function computeTelegramBackoffSeconds(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt, 32) - 1);
  return Math.min(TELEGRAM_MAX_BACKOFF_SECONDS, TELEGRAM_BASE_BACKOFF_SECONDS * 2 ** exponent);
}

export const TELEGRAM_KIND_LABELS: Record<string, string> = {
  volume_spike: "放量",
  pct_move: "异动",
  price_cross: "破位",
  candle_close_break: "收盘破位",
  long_wick: "长影线",
  pullback: "回踩",
  retracement: "拐点",
  strategy_execution: "策略执行",
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Beijing time as "MM-DD HH:MM" (or "HH:MM" when the date part is unavailable). */
export function formatBeijingTime(value: unknown): string | null {
  const ms = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Date.parse(value)
    : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  if (!month || !day || !hour || !minute) return null;
  return `${month}-${day} ${hour}:${minute}`;
}

/** A-share-style volume rendering: 亿份 / 万份 / 份. */
export function formatVolume(volume: number): string {
  if (volume >= 100_000_000) return `${(volume / 100_000_000).toFixed(2)}亿份`;
  if (volume >= 10_000) return `${(volume / 10_000).toFixed(1)}万份`;
  return `${volume}份`;
}

function formatPrice(price: number): string {
  return Number.isInteger(price) ? String(price) : String(Math.round(price * 10000) / 10000);
}

/** Signed percentage, at most four decimals: "+0.821%", "-0.6807%", "0%". */
function formatPct(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}${Math.abs(rounded)}%`;
}

/**
 * Price as a chart payload number: at most two decimals, four for sub-1000 prices. Two decimals is under one
 * pixel on a 440px-tall phone chart, and it keeps a six-digit instrument inside the URL budget.
 */
function roundPrice(value: number): number {
  const scale = Math.abs(value) >= 1000 ? 100 : 10000;
  return Math.round(value * scale) / scale;
}

/** Multiple as "2" / "2.35", never "2.00". */
function formatMultiple(value: number): string {
  return String(Math.round(value * 100) / 100);
}

interface AlertView {
  kind: string;
  symbol: string;
  details: JsonRecord;
  barTs: unknown;
  triggeredAt: unknown;
}

function readAlertView(deliveryPayload: unknown): AlertView {
  const payload = asRecord(deliveryPayload) ?? {};
  const inner = asRecord(payload.payload) ?? {};
  // alert-evaluator buildAlert writes the rule's numbers flat into payload (payload.last_price, ...), while
  // webhook-era rows and tests wrap them in payload.details. Both shapes are rendered; details wins if both
  // are present.
  return {
    kind: asString(payload.kind) ?? "alert",
    symbol: asString(payload.symbol) ?? "未知标的",
    details: { ...inner, ...(asRecord(inner.details) ?? {}) },
    // alert-evaluator writes bar_ts (ISO); barTs is the older numeric spelling still found in stored rows.
    barTs: inner.bar_ts ?? inner.barTs ?? null,
    triggeredAt: payload.triggered_at ?? null,
  };
}

/**
 * Render one fanout delivery payload into a short, readable Chinese message.
 *
 * The fanout payload shape is { kind, symbol, severity, triggered_at,
 * payload: { bar_ts, interval, details } } (see hive_fanout_alert and the evaluator's buildAlert). Alerts are
 * read-only
 * notifications: the message never contains trading advice wording.
 *
 * volume_spike carries two distinct numbers and they are never conflated:
 * `details.observed_multiple` is the measured ratio (latest volume over the
 * average of the preceding bars), `details.multiple` is the rule threshold.
 * When the evaluator did not report an observed ratio the message says so
 * instead of substituting the threshold.
 */
export function formatTelegramAlertMessage(deliveryPayload: unknown): string {
  const { kind, symbol, details, barTs, triggeredAt } = readAlertView(deliveryPayload);
  const kindLabel = TELEGRAM_KIND_LABELS[kind] ?? kind;
  const lastPrice = asNumber(details.last_price);
  const triggeredTime = formatBeijingTime(triggeredAt);

  const lines: string[] = [];

  if (kind === "retracement") {
    const isTop = asNumber(details.is_top);
    const anchor = asNumber(details.anchor_price);
    const retracePct = asNumber(details.retrace_pct);
    const lookback = asNumber(details.lookback);
    const side = isTop === 1 ? "疑似顶部" : isTop === 0 ? "疑似底部" : "拐点";

    lines.push(`${side} · ${symbol}`);
    if (lastPrice !== null) lines.push(`现价 ${formatPrice(lastPrice)}`);
    if (anchor !== null) {
      lines.push(`${isTop === 1 ? "高点锚" : isTop === 0 ? "低点锚" : "锚"} ${formatPrice(anchor)}`);
    }
    if (retracePct !== null) {
      // Sign follows the direction: a top gives back from the high (-), a bottom rebounds off the low (+).
      lines.push(`偏离 ${formatPct(isTop === 1 ? -retracePct : retracePct)}`);
    }
    const reading = describeRetracement(isTop, retracePct, lookback);
    if (reading !== null) lines.push(reading);
  } else if (kind === "volume_spike") {
    const observed = asNumber(details.observed_multiple);
    const threshold = asNumber(details.multiple);
    const lookback = asNumber(details.lookback);
    const volume = asNumber(details.last_volume);

    lines.push(`放量 · ${symbol}`);
    if (lastPrice !== null) lines.push(`现价 ${formatPrice(lastPrice)}`);
    if (observed !== null) lines.push(`实测 ${formatMultiple(observed)} 倍`);
    else lines.push("实测倍数未记录");
    if (threshold !== null) lines.push(`阈值 ${formatMultiple(threshold)} 倍`);
    if (lookback !== null) lines.push(`窗口 前 ${lookback} 根均量`);
    if (volume !== null) lines.push(`成交量 ${formatVolume(volume)}`);
    const reading = describeVolumeSpike(observed, threshold, lookback);
    if (reading !== null) lines.push(reading);
  } else {
    const message = formatOtherKind(kind, kindLabel, symbol, lastPrice, details);
    lines.push(message.headline);
    lines.push(...message.extra);
  }

  const barTime = formatBeijingTime(barTs);
  if (barTime !== null) lines.push(`bar 时间 ${barTime}（北京时间）`);
  if (triggeredTime !== null) lines.push(`触发时间 ${triggeredTime}（北京时间）`);

  return lines.join("\n");
}

/** One plain-language sentence: where the close sits relative to the anchor. */
function describeRetracement(isTop: number | null, pct: number | null, lookback: number | null): string | null {
  if (pct === null) return null;
  const span = lookback !== null ? `近 ${lookback} 根` : "近期";
  const magnitude = Math.abs(pct);
  if (isTop === 1) return `价格从${span}高点回落 ${magnitude}%，上涨动能减弱`;
  if (isTop === 0) return `价格从${span}低点回升 ${magnitude}%，下跌动能减弱`;
  return `价格偏离${span}高低点 ${magnitude}%`;
}

/** One plain-language sentence built from the measured ratio, not the threshold. */
function describeVolumeSpike(observed: number | null, threshold: number | null, lookback: number | null): string | null {
  if (observed === null) return "放量触发，成交量明显高于近期均量";
  const baseline = lookback !== null ? `前 ${lookback} 根均量` : "近期均量";
  const tail = threshold !== null ? `，已达 ${formatMultiple(threshold)} 倍阈值` : "";
  return `成交量为${baseline}的 ${formatMultiple(observed)} 倍${tail}`;
}

interface OtherKindMessage {
  headline: string;
  extra: string[];
}

/** Kinds other than retracement and volume_spike keep their existing one-line rendering. */
function formatOtherKind(kind: string, kindLabel: string, symbol: string, lastPrice: number | null, details: JsonRecord): OtherKindMessage {
  if (kind === "pct_move") {
    const earlier = asNumber(details.earlier_price);
    const pct = asNumber(details.pct);
    const suffix = pct !== null ? `（${pct > 0 ? "+" : ""}${pct}%）` : "";
    let body: string;
    if (earlier !== null && lastPrice !== null) body = `价格 ${formatPrice(earlier)} → ${formatPrice(lastPrice)}${suffix}`;
    else if (lastPrice !== null) body = `价格 ${formatPrice(lastPrice)}${suffix}`;
    else body = "异动触发";
    return { headline: `${kindLabel} · ${symbol}`, extra: [body] };
  }
  if (kind === "price_cross" || kind === "candle_close_break") {
    const level = asNumber(details.level);
    let body: string;
    if (lastPrice !== null && level !== null) body = `价格 ${formatPrice(lastPrice)}，触发位 ${formatPrice(level)}`;
    else if (lastPrice !== null) body = `价格 ${formatPrice(lastPrice)}`;
    else body = "破位触发";
    return { headline: `${kindLabel} · ${symbol}`, extra: [body] };
  }
  if (kind === "pullback") {
    const minDrop = asNumber(details.min_drop_pct);
    return {
      headline: `${kindLabel} · ${symbol}`,
      extra: [lastPrice !== null ? `收盘价 ${formatPrice(lastPrice)}${minDrop !== null ? `，回踩阈值 ${minDrop}%` : ""}` : "回踩触发"],
    };
  }
  if (kind === "long_wick") {
    return { headline: `${kindLabel} · ${symbol}`, extra: [lastPrice !== null ? `收盘价 ${formatPrice(lastPrice)}` : "长影线触发"] };
  }
  if (kind === "strategy_execution") {
    const action = asString(details.action) ?? "";
    const instId = asString(details.inst_id) ?? symbol;
    const sz = asString(details.sz) ?? "";
    const execStatus = asString(details.status) ?? "";
    const ordId = asString(details.ord_id) ?? asString(details.algo_id) ?? "";
    const extra = [`${action} ${instId} ${sz} → ${execStatus}${ordId ? `（${ordId}）` : ""}`.trim()];
    const execReason = asString(details.reason);
    if (execReason !== null) extra.push(execReason);
    return { headline: `${kindLabel} · ${symbol}`, extra };
  }
  return { headline: `${kindLabel} · ${symbol}`, extra: [lastPrice !== null ? `价格 ${formatPrice(lastPrice)}` : "触发"] };
}

export interface TelegramChartCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TelegramChartInput {
  /** Ascending, oldest first; at most TELEGRAM_CHART_MAX_BARS are drawn (the most recent ones). */
  candles: readonly TelegramChartCandle[];
  /** Horizontal anchor level (retracement high/low). */
  anchorPrice?: number | null;
  /** Label for the anchor line, e.g. "高点锚". */
  anchorLabel?: string;
  /** Price of the triggering bar, marked with a dot. */
  triggerPrice?: number | null;
  /** Threshold multiple line for volume spikes, drawn on the price panel only when it is a price level. */
  title?: string;
}

export const TELEGRAM_CHART_MAX_BARS = 30;
export const TELEGRAM_CHART_BASE_URL = "https://quickchart.io/chart";
/**
 * Telegram fetches the photo URL itself and rejects very long ones. A 30-bar shorthand chart encodes to
 * roughly 1.6-2.2 KB depending on price magnitude, so anything past this means the payload is wrong: the
 * alert goes out as text instead of a broken photo.
 */
export const TELEGRAM_CHART_MAX_URL_LENGTH = 2500;

/**
 * Chart.js config for a compact 15-minute price chart: candles, an optional
 * anchor line and an optional trigger marker. No volume sub-plot, high-contrast
 * colours, sized for a phone. Returned as JSON so tests can assert on structure.
 */
export function buildTelegramChartConfig(input: TelegramChartInput): JsonRecord {
  const bars = input.candles.slice(-TELEGRAM_CHART_MAX_BARS);
  const lastIndex = bars.length - 1;
  // Numeric x on a linear axis is the only form QuickChart's candlestick plugin renders one candle per slot
  // (a category axis collapses them into a single bar). Indices keep the payload short.
  const datasets: JsonRecord[] = [
    {
      type: "candlestick",
      label: "K线",
      data: bars.map((bar, index) => ({
        x: index,
        o: roundPrice(bar.open),
        h: roundPrice(bar.high),
        l: roundPrice(bar.low),
        c: roundPrice(bar.close),
      })),
    },
  ];
  const anchor = asNumber(input.anchorPrice);
  if (anchor !== null) {
    datasets.push({
      type: "line",
      label: `${input.anchorLabel ?? "锚"} ${formatPrice(anchor)}`,
      data: [{ x: 0, y: roundPrice(anchor) }, { x: lastIndex, y: roundPrice(anchor) }],
      borderColor: "#f59e0b",
      borderWidth: 2,
      borderDash: [8, 5],
      pointRadius: 0,
    });
  }
  const trigger = asNumber(input.triggerPrice);
  if (trigger !== null) {
    datasets.push({
      type: "scatter",
      label: `触发 ${formatPrice(trigger)}`,
      data: [{ x: lastIndex, y: roundPrice(trigger) }],
      backgroundColor: "#2563eb",
      pointRadius: 7,
    });
  }
  return {
    type: "candlestick",
    data: { datasets },
    options: {
      plugins: { legend: { labels: { boxWidth: 12 } } },
      scales: {
        x: { type: "linear", min: -1, max: lastIndex + 1, grid: { display: false }, ticks: { stepSize: 10 } },
        y: { type: "linear" },
      },
    },
  };
}

/**
 * QuickChart's shorthand chart syntax: a Chart.js config with unquoted keys and single-quoted strings.
 * A 30-bar payload is a third of the size of the equivalent JSON once percent-encoded, which is what keeps the
 * photo URL comfortably inside Telegram's limit instead of right at the edge.
 */
function encodeChartConfig(config: JsonRecord): string {
  let out = "";
  const key = (value: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : `'${value.replace(/'/g, "\\'")}'`);
  const quoted = (value: string) => `'${value.replace(/'/g, "\\'")}'`;
  const write = (value: unknown) => {
    if (value === null || value === undefined) {
      out += "null";
      return;
    }
    if (typeof value === "number") {
      out += String(value);
      return;
    }
    if (typeof value === "boolean") {
      out += value ? "true" : "false";
      return;
    }
    if (typeof value === "string") {
      out += quoted(value);
      return;
    }
    if (Array.isArray(value)) {
      out += "[";
      value.forEach((item, index) => {
        if (index > 0) out += ",";
        write(item);
      });
      out += "]";
      return;
    }
    out += "{";
    let first = true;
    for (const [name, item] of Object.entries(value as JsonRecord)) {
      if (item === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += `${key(name)}:`;
      write(item);
    }
    out += "}";
  };
  write(config);
  return out;
}

/**
 * Build the QuickChart URL for `input`. Returns null when there is nothing to
 * draw or the encoded URL would exceed `TELEGRAM_CHART_MAX_URL_LENGTH`, so the
 * caller degrades to a text-only message instead of sending a broken photo.
 */
export function buildTelegramChartUrl(input: TelegramChartInput): string | null {
  const bars = input.candles.filter(
    (bar) => Number.isFinite(bar.ts) && Number.isFinite(bar.open) && Number.isFinite(bar.high)
      && Number.isFinite(bar.low) && Number.isFinite(bar.close)
      // A dropped candle must not silently shorten the series into a misleading chart.
      && bar.high >= bar.low,
  );
  if (bars.length !== input.candles.length) {
    // Reject the whole series rather than draw a chart with holes.
    return null;
  }
  if (bars.length < 2) return null;
  const config = buildTelegramChartConfig({ ...input, candles: bars });
  const encoded = encodeURIComponent(encodeChartConfig(config)).replace(
    /%(?:7B|7D|5B|5D|3A|2C|3B|27)/gi,
    (match) => decodeURIComponent(match),
  );
  const url = `${TELEGRAM_CHART_BASE_URL}?v=3&w=720&h=440&bkg=%23ffffff&c=${encoded}`;
  return url.length <= TELEGRAM_CHART_MAX_URL_LENGTH ? url : null;
}

export interface TelegramSendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** Seconds Telegram asked to wait (429 retry_after), if any. */
  retryAfterSeconds: number | null;
}

interface TelegramApiErrorBody {
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

function parseTelegramResponse(response: Response, body: TelegramApiErrorBody): TelegramSendResult {
  if (response.status >= 200 && response.status < 300 && body && (body as { ok?: unknown }).ok !== false) {
    return { ok: true, status: response.status, error: null, retryAfterSeconds: null };
  }
  const retryAfter = body.parameters && typeof body.parameters.retry_after === "number"
    ? body.parameters.retry_after
    : null;
  const description = typeof body.description === "string" ? body.description : `HTTP ${response.status}`;
  return {
    ok: false,
    status: response.status,
    error: description.slice(0, 300),
    retryAfterSeconds: retryAfter,
  };
}

async function readJsonBody(response: Response): Promise<TelegramApiErrorBody> {
  try {
    return (await response.json()) as TelegramApiErrorBody;
  } catch {
    return {};
  }
}

/**
 * Post one message through the Bot API. The token travels only in the
 * request URL path (Bot API convention) and is never logged by this
 * module; callers must not log the URL either.
 */
export async function sendTelegramMessage(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  botToken: string,
  chatId: string,
  text: string,
  timeoutMs = 8000,
): Promise<TelegramSendResult> {
  const base = apiBaseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/bot${botToken}/sendMessage`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: `request failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      retryAfterSeconds: null,
    };
  }
  return parseTelegramResponse(response, await readJsonBody(response));
}

/**
 * Post a photo with the alert text as its caption (one message). Telegram caps
 * captions at 1024 characters, so a longer text is sent as a separate message
 * after the photo; callers normally keep alert text far shorter.
 */
export async function sendTelegramPhoto(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  botToken: string,
  chatId: string,
  photoUrl: string,
  caption: string,
  timeoutMs = 8000,
): Promise<TelegramSendResult> {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const body: Record<string, unknown> = { chat_id: chatId, photo: photoUrl };
  if (caption.length > 0) {
    body.caption = caption.slice(0, TELEGRAM_CAPTION_MAX_LENGTH);
  }
  let response: Response;
  try {
    response = await fetchImpl(`${base}/bot${botToken}/sendPhoto`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: `request failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      retryAfterSeconds: null,
    };
  }
  return parseTelegramResponse(response, await readJsonBody(response));
}

export const TELEGRAM_CAPTION_MAX_LENGTH = 1024;

export interface TelegramDeliveryResult extends TelegramSendResult {
  /** True when the alert was delivered as a photo with caption; false for the text fallback. */
  withPhoto: boolean;
  /** Why the photo path was skipped or failed; null on the happy path. */
  photoError: string | null;
}

/**
 * Deliver one alert: photo-with-caption when a chart URL is available, plain
 * text otherwise. A photo that fails is retried once as text, so an image
 * problem never loses the alert. `chart` may be null (no candles available).
 */
export async function deliverTelegramAlert(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  botToken: string,
  chatId: string,
  text: string,
  chart: TelegramChartInput | null,
  timeoutMs = 8000,
): Promise<TelegramDeliveryResult> {
  let photoError: string | null = null;
  const photoUrl = chart === null ? null : buildTelegramChartUrl(chart);
  if (photoUrl !== null) {
    const photo = await sendTelegramPhoto(fetchImpl, apiBaseUrl, botToken, chatId, photoUrl, text, timeoutMs);
    if (photo.ok) return { ...photo, withPhoto: true, photoError: null };
    photoError = photo.error;
    // A 429 applies to the chat, not to this method: retrying as text would be rate-limited too.
    if (photo.status === 429) return { ...photo, withPhoto: false, photoError };
  }
  const textResult = await sendTelegramMessage(fetchImpl, apiBaseUrl, botToken, chatId, text, timeoutMs);
  return { ...textResult, withPhoto: false, photoError };
}
