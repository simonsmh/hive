import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import type { Candle } from "./core/types.ts";
import type { InstrumentSpec, PendingAlgo, PositionRow, PositionSubscription } from "./core/position.ts";
import {
  createPositionManagerHandler,
  type EvalPatch,
  type OrderSubmitter,
  type PositionExchange,
  type PositionManagerDeps,
  type PositionStore,
  type SubmitOutcome,
  SOURCE,
} from "./handler.ts";

const CRON = "cron-secret-test";
const NOW = Date.parse("2026-10-14T06:40:30.000Z");
const HOUR_LAST_CONFIRMED = Date.parse("2026-10-14T05:00:00.000Z");
const FIVE_LAST_CONFIRMED = Date.parse("2026-10-14T06:35:00.000Z");

const BTC_SHORT: PositionSubscription = {
  id: "sub-btc",
  mode: "live",
  instId: "BTC-USDT-SWAP",
  posSide: "net",
  direction: "short",
  tdMode: "isolated",
  entryPx: 81818.5,
  slPx: 82700,
  tpPx: 80400,
  midPx: 82259.25,
  themeStopCapU: 0.1,
  atrLen: 14,
  atrMult: 0.8,
  amendMinAtrFrac: 0.15,
  halfReduceFrac: 0.5,
  dynamicTpEnabled: true,
  halfReduceEnabled: true,
  halfReduceDone: false,
  halfReduceAttempts: 0,
};

const QQQ_LONG: PositionSubscription = {
  id: "sub-qqq",
  mode: "live",
  instId: "QQQ-USDT-SWAP",
  posSide: "net",
  direction: "long",
  tdMode: "isolated",
  entryPx: 731.19,
  slPx: 721,
  tpPx: 741,
  midPx: 726.095,
  themeStopCapU: 0.1,
  atrLen: 14,
  atrMult: 0.8,
  amendMinAtrFrac: 0.15,
  halfReduceFrac: 0.5,
  dynamicTpEnabled: true,
  halfReduceEnabled: true,
  halfReduceDone: false,
  halfReduceAttempts: 0,
};

const SPEC: InstrumentSpec = { ctVal: 0.01, lotSz: 0.01, minSz: 0.01, tickSz: 0.1 };
const QQQ_SPEC: InstrumentSpec = { ctVal: 1, lotSz: 1, minSz: 1, tickSz: 0.01 };

/** Hourly bars with a true range of exactly 10 on every bar, so ATR14 = 10. Ascending, last one confirmed at lastTs. */
function hourly(count: number, lastTs: number = HOUR_LAST_CONFIRMED, price = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: lastTs - (count - 1 - i) * 3_600_000,
    open: price,
    high: price + 5,
    low: price - 5,
    close: price,
    volume: 1,
    volCcy: 1,
    confirmed: true,
  }));
}

function fiveMinute(close: number, lastTs: number = FIVE_LAST_CONFIRMED): Candle[] {
  return [lastTs - 600_000, lastTs - 300_000, lastTs].map((ts) => ({
    ts,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
    volCcy: 1,
    confirmed: true,
  }));
}

function algo(overrides: Partial<PendingAlgo> & { algoId: string }): PendingAlgo {
  return {
    algoClOrdId: `cl-${overrides.algoId}`,
    side: "buy",
    posSide: "net",
    sz: 0.5,
    reduceOnly: true,
    slTriggerPx: "82700",
    slOrdPx: "-1",
    tpTriggerPx: "80400",
    tpOrdPx: "-1",
    ...overrides,
  };
}

interface Scenario {
  subscriptions?: PositionSubscription[];
  killSwitch?: boolean;
  liveEnabled?: boolean;
  dryRun?: boolean;
  leaseFree?: boolean;
  positions?: Record<string, PositionRow[]>;
  algos?: Record<string, PendingAlgo[]>;
  hourlyBars?: Record<string, Candle[]>;
  fiveMinuteClose?: Record<string, number>;
  fiveMinuteBars?: Record<string, Candle[]>;
  submit?: (intent: Record<string, unknown>, harness: Harness) => SubmitOutcome;
  failPositionsFor?: string;
  evalFails?: boolean;
}

const ACKED = (algoId: string | null = null, ordId: string | null = null): SubmitOutcome => ({
  httpStatus: 200,
  status: "acked",
  reason: null,
  ordId,
  algoId,
  detail: null,
});

class Harness {
  readonly submitted: Record<string, unknown>[] = [];
  readonly evals: { id: string; patch: EvalPatch }[] = [];
  readonly claims: string[] = [];
  readonly finishes: { id: string; outcome: { done: boolean; note: string; reduced: boolean } }[] = [];
  readonly cancelled: { algoId: string; instId: string }[] = [];
  readonly listed: string[] = [];
  readonly logs: string[] = [];
  readonly positions: Record<string, PositionRow[]>;
  readonly algos: Record<string, PendingAlgo[]>;

  constructor(private readonly scenario: Scenario) {
    this.positions = scenario.positions ?? {};
    this.algos = scenario.algos ?? {};
  }

  deps(overrides: Partial<PositionManagerDeps> = {}): PositionManagerDeps {
    const scenario = this.scenario;
    const store: PositionStore = {
      killSwitchEngaged: async () => scenario.killSwitch ?? false,
      listEnabledSubscriptions: async (mode) => {
        this.listed.push(mode);
        return scenario.subscriptions ?? [];
      },
      recordEval: async (id, patch) => {
        if (scenario.evalFails) throw new Error("eval write failed");
        this.evals.push({ id, patch });
      },
      claimHalfReduce: async (id) => {
        this.claims.push(id);
        return scenario.leaseFree ?? true;
      },
      finishHalfReduce: async (id, outcome) => {
        this.finishes.push({ id, outcome });
      },
    };
    const exchange: PositionExchange = {
      positions: async (instId) => {
        if (scenario.failPositionsFor === instId) throw new Error("OKX positions timed out");
        return this.positions[instId] ?? [];
      },
      protectionAlgos: async (instId) => this.algos[instId] ?? [],
      instrumentSpec: async (instId) => (instId === "QQQ-USDT-SWAP" ? QQQ_SPEC : SPEC),
      confirmedCandles: async (instId, bar, limit) => {
        if (bar === "1H") return (scenario.hourlyBars ?? {})[instId] ?? hourly(30);
        if (scenario.fiveMinuteBars?.[instId]) return scenario.fiveMinuteBars[instId].slice(-limit);
        const close = scenario.fiveMinuteClose?.[instId] ?? 0;
        return fiveMinute(close).slice(-limit);
      },
      cancelAlgos: async (items) => {
        this.cancelled.push(...items);
      },
    };
    const submitter: OrderSubmitter = {
      submit: async (intent) => {
        this.submitted.push(intent);
        if (scenario.submit) return scenario.submit(intent, this);
        return intent.action === "reduce" ? ACKED(null, "ord-default") : ACKED("algo-default");
      },
    };
    return {
      cronSecret: CRON,
      mode: "live",
      liveEnabled: scenario.liveEnabled ?? true,
      dryRun: scenario.dryRun ?? false,
      store,
      exchange,
      submitter,
      now: () => NOW,
      newIntentId: () => "pm-test",
      log: (message) => this.logs.push(message),
      ...overrides,
    };
  }
}

function post(token: string | null = CRON): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://hive.test/functions/v1/position-manager", { method: "POST", headers, body: "{}" });
}

async function run(scenario: Scenario, overrides: Partial<PositionManagerDeps> = {}) {
  const harness = new Harness(scenario);
  const handler = createPositionManagerHandler(harness.deps(overrides));
  const response = await handler(post());
  const body = (await response.json()) as { status: string; reports?: { id: string; action: string; notes: string[] }[] };
  return { response, body, harness };
}

const BTC_SHORT_POSITION: PositionRow[] = [{ posSide: "net", pos: -0.5, avgPx: 81818.5, markPx: 81900 }];
/** The TP already sits at the dynamic level (entry - 0.8 x ATR10), so only size changes can trigger an amend. */
const BTC_PROTECTION: PendingAlgo[] = [algo({ algoId: "btc-oco", sz: 0.5, tpTriggerPx: "81810.5" })];

Deno.test("rejects requests without the cron bearer token", async () => {
  const harness = new Harness({ subscriptions: [BTC_SHORT] });
  const handler = createPositionManagerHandler(harness.deps());
  const response = await handler(post("wrong"));
  strictEqual(response.status, 401);
  strictEqual(harness.listed.length, 0);
});

Deno.test("rejects non-POST methods", async () => {
  const harness = new Harness({});
  const handler = createPositionManagerHandler(harness.deps());
  const response = await handler(new Request("https://hive.test/", { method: "GET", headers: { authorization: `Bearer ${CRON}` } }));
  strictEqual(response.status, 405);
});

Deno.test("returns disabled for live mode without the live switch and reads nothing", async () => {
  const { response, body, harness } = await run({ subscriptions: [BTC_SHORT], liveEnabled: false });
  strictEqual(response.status, 200);
  strictEqual(body.status, "disabled");
  strictEqual(harness.listed.length, 0);
  strictEqual(harness.submitted.length, 0);
});

Deno.test("skips every subscription when the kill switch is engaged", async () => {
  const { body, harness } = await run({
    subscriptions: [BTC_SHORT],
    killSwitch: true,
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
  });
  strictEqual(body.status, "skipped");
  strictEqual(harness.listed.length, 0);
  strictEqual(harness.submitted.length, 0);
});

Deno.test("records no_position and places nothing for a flat subscription", async () => {
  const { body, harness } = await run({ subscriptions: [BTC_SHORT], positions: {} });
  strictEqual(body.status, "ok");
  strictEqual(harness.submitted.length, 0);
  strictEqual(harness.claims.length, 0);
  deepStrictEqual(
    harness.evals.map((e) => e.patch.lastNote),
    ["no_position"],
  );
});

Deno.test("half-way reduce is placed once, reduce-only on the closing side, and marks the subscription done", async () => {
  const { harness, body } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
    submit: (intent, h) => {
      if (intent.action === "reduce") {
        h.positions["BTC-USDT-SWAP"] = [{ posSide: "net", pos: -0.25, avgPx: 81818.5, markPx: 81900 }];
        return ACKED(null, "ord-1");
      }
      h.algos["BTC-USDT-SWAP"] = [...h.algos["BTC-USDT-SWAP"], algo({ algoId: "btc-new", sz: 0.25 })];
      return ACKED("btc-new");
    },
  });

  strictEqual(body.status, "ok");
  const reduce = harness.submitted[0];
  ok(reduce, "reduce intent submitted");
  strictEqual(reduce.schema, "okx.intent.v1");
  strictEqual(reduce.action, "reduce");
  strictEqual(reduce.side, "buy");
  strictEqual(reduce.posSide, "net");
  strictEqual(reduce.tdMode, "isolated");
  strictEqual(reduce.sz, "0.25");
  strictEqual(reduce.reduceOnly, true);
  strictEqual(reduce.source, SOURCE);
  match(String(reduce.idempotencyKey), /^[0-9a-f]{32}$/);

  strictEqual(harness.finishes.length, 1);
  strictEqual(harness.finishes[0]?.outcome.done, true);
  strictEqual(harness.finishes[0]?.outcome.reduced, true);
  strictEqual(harness.claims.length, 1);

  const amend = harness.submitted[1];
  strictEqual(amend?.action, "amend_tpsl");
  strictEqual(amend?.sz, "0.25");
  strictEqual(amend?.slTriggerPx, "82700");
  strictEqual(harness.submitted.length, 2);
  deepStrictEqual(
    harness.cancelled,
    [{ algoId: "btc-oco", instId: "BTC-USDT-SWAP" }],
  );
  strictEqual(body.reports?.[0]?.action, "reduce+amend");
});

Deno.test("a reduce rejected before OKX releases the lease so a later run can retry", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
    submit: () => ({ httpStatus: 423, status: "rejected_risk", reason: "kill_switch_engaged", ordId: null, algoId: null, detail: null }),
  });
  strictEqual(harness.submitted.length, 1);
  strictEqual(harness.finishes[0]?.outcome.done, false);
  strictEqual(harness.finishes[0]?.outcome.reduced, false);
  match(harness.finishes[0]?.outcome.note ?? "", /half_reduce_rejected:rejected_risk:kill_switch_engaged/);
});

Deno.test("an exchange error that may have reached OKX closes the reduce for good until checked on OKX", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
    submit: () => ({ httpStatus: 502, status: "exchange_error", reason: "outcome_unknown", ordId: null, algoId: null, detail: null }),
  });
  strictEqual(harness.finishes[0]?.outcome.done, true);
  strictEqual(harness.finishes[0]?.outcome.reduced, false);
  match(harness.finishes[0]?.outcome.note ?? "", /check_okx/);
});

Deno.test("a transport failure on the reduce is treated as unknown, not as unplaced", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
    submit: () => ({ httpStatus: null, status: "transport_error", reason: "timeout", ordId: null, algoId: null, detail: null }),
  });
  strictEqual(harness.finishes[0]?.outcome.done, true);
});

Deno.test("an okx_rejected exchange error is treated as nothing placed", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
    submit: () => ({ httpStatus: 502, status: "exchange_error", reason: "okx_rejected:51008", ordId: null, algoId: null, detail: null }),
  });
  strictEqual(harness.finishes[0]?.outcome.done, false);
});

Deno.test("a reduce lease held by another run places nothing", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
    leaseFree: false,
  });
  strictEqual(harness.submitted.length, 0);
  strictEqual(harness.finishes.length, 0);
  match(harness.evals[0]?.patch.lastNote ?? "", /half_reduce_claimed_elsewhere/);
});

Deno.test("a subscription whose half-way reduce is already done never claims or reduces again", async () => {
  const { harness } = await run({
    subscriptions: [{ ...BTC_SHORT, halfReduceDone: true }],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
  });
  strictEqual(harness.claims.length, 0);
  strictEqual(harness.submitted.length, 0);
});

Deno.test("a stale 5m bar blocks the half-way reduce", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteBars: { "BTC-USDT-SWAP": fiveMinute(82300, FIVE_LAST_CONFIRMED - 3_600_000) },
  });
  strictEqual(harness.claims.length, 0);
  strictEqual(harness.submitted.length, 0);
  match(harness.evals[0]?.patch.lastNote ?? "", /skip:stale_5m/);
});

Deno.test("a close that holds the midpoint does not reduce", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82000 },
  });
  strictEqual(harness.claims.length, 0);
  strictEqual(harness.submitted.length, 0);
});

Deno.test("dynamic ATR take-profit amends the OCO TP only when it moves at least 0.15 ATR", async () => {
  const qqqPosition: PositionRow[] = [{ posSide: "net", pos: 10, avgPx: 731.19, markPx: 735 }];
  const { harness } = await run({
    subscriptions: [QQQ_LONG],
    positions: { "QQQ-USDT-SWAP": qqqPosition },
    algos: { "QQQ-USDT-SWAP": [algo({ algoId: "qqq-old", side: "sell", sz: 10, slTriggerPx: "721", tpTriggerPx: "741" })] },
    fiveMinuteClose: { "QQQ-USDT-SWAP": 733 },
    hourlyBars: { "QQQ-USDT-SWAP": hourly(30, HOUR_LAST_CONFIRMED, 731) },
    submit: (_intent, h) => {
      h.algos["QQQ-USDT-SWAP"] = [...h.algos["QQQ-USDT-SWAP"], algo({ algoId: "qqq-new", side: "sell", sz: 10, slTriggerPx: "721", tpTriggerPx: "739.19" })];
      return ACKED("qqq-new");
    },
  });

  strictEqual(harness.submitted.length, 1);
  const amend = harness.submitted[0];
  strictEqual(amend?.action, "amend_tpsl");
  strictEqual(amend?.instId, "QQQ-USDT-SWAP");
  strictEqual(amend?.side, "sell");
  strictEqual(amend?.sz, "10");
  strictEqual(amend?.slTriggerPx, "721");
  strictEqual(amend?.tpTriggerPx, "739.19");
  strictEqual(amend?.tpOrdPx, "-1");
  strictEqual(harness.evals[0]?.patch.tpPx, 739.19);
  ok(harness.evals[0]?.patch.lastAmendAt);
  deepStrictEqual(harness.cancelled, [{ algoId: "qqq-old", instId: "QQQ-USDT-SWAP" }]);
});

Deno.test("a TP move under 0.15 ATR is not amended", async () => {
  const { harness } = await run({
    subscriptions: [QQQ_LONG],
    positions: { "QQQ-USDT-SWAP": [{ posSide: "net", pos: 10, avgPx: 731.19, markPx: 735 }] },
    algos: { "QQQ-USDT-SWAP": [algo({ algoId: "qqq-old", side: "sell", sz: 10, slTriggerPx: "721", tpTriggerPx: "739.5" })] },
    fiveMinuteClose: { "QQQ-USDT-SWAP": 733 },
    hourlyBars: { "QQQ-USDT-SWAP": hourly(30, HOUR_LAST_CONFIRMED, 731) },
  });
  strictEqual(harness.submitted.length, 0);
  strictEqual(harness.evals[0]?.patch.lastNote, "no_change");
});

Deno.test("a dynamic TP that the mark has already reached is not placed", async () => {
  const { harness } = await run({
    subscriptions: [QQQ_LONG],
    positions: { "QQQ-USDT-SWAP": [{ posSide: "net", pos: 10, avgPx: 731.19, markPx: 739 }] },
    algos: { "QQQ-USDT-SWAP": [algo({ algoId: "qqq-old", side: "sell", sz: 10, slTriggerPx: "721", tpTriggerPx: "741" })] },
    fiveMinuteClose: { "QQQ-USDT-SWAP": 733 },
    hourlyBars: { "QQQ-USDT-SWAP": hourly(30, HOUR_LAST_CONFIRMED, 731) },
  });
  strictEqual(harness.submitted.length, 0);
  match(harness.evals[0]?.patch.lastNote ?? "", /tp_not_beyond_mark/);
});

Deno.test("a position without an exchange stop is skipped, never amended blind", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": [] },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
  });
  strictEqual(harness.submitted.length, 0);
  strictEqual(harness.claims.length, 0);
  match(harness.evals[0]?.patch.lastNote ?? "", /skip:no_exchange_stop/);
});

Deno.test("too little 1H history skips the subscription", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    hourlyBars: { "BTC-USDT-SWAP": hourly(10) },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
  });
  strictEqual(harness.submitted.length, 0);
  match(harness.evals[0]?.patch.lastNote ?? "", /skip:stale_or_short_1h/);
});

Deno.test("a position whose direction no longer matches the subscription is skipped", async () => {
  const { harness } = await run({
    subscriptions: [BTC_SHORT],
    positions: { "BTC-USDT-SWAP": [{ posSide: "net", pos: 0.5, avgPx: 81818.5, markPx: 81900 }] },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
  });
  strictEqual(harness.submitted.length, 0);
  match(harness.evals[0]?.patch.lastNote ?? "", /skip:direction_mismatch:long/);
});

Deno.test("dry run places nothing and writes nothing", async () => {
  const { harness } = await run(
    {
      subscriptions: [BTC_SHORT, QQQ_LONG],
      positions: {
        "BTC-USDT-SWAP": BTC_SHORT_POSITION,
        "QQQ-USDT-SWAP": [{ posSide: "net", pos: 10, avgPx: 731.19, markPx: 735 }],
      },
      algos: {
        "BTC-USDT-SWAP": BTC_PROTECTION,
        "QQQ-USDT-SWAP": [algo({ algoId: "qqq-old", side: "sell", sz: 10, slTriggerPx: "721", tpTriggerPx: "741" })],
      },
      fiveMinuteClose: { "BTC-USDT-SWAP": 82300, "QQQ-USDT-SWAP": 733 },
      hourlyBars: { "QQQ-USDT-SWAP": hourly(30, HOUR_LAST_CONFIRMED, 731) },
      dryRun: true,
    },
  );
  strictEqual(harness.submitted.length, 0);
  strictEqual(harness.claims.length, 0);
  strictEqual(harness.finishes.length, 0);
  strictEqual(harness.evals.length, 0);
  ok(harness.logs.some((line) => line.includes("dry_run:half_reduce")));
});

Deno.test("one subscription failing does not stop the others, and the failure is recorded", async () => {
  const { body, harness } = await run({
    subscriptions: [BTC_SHORT, QQQ_LONG],
    failPositionsFor: "BTC-USDT-SWAP",
    positions: { "QQQ-USDT-SWAP": [{ posSide: "net", pos: 10, avgPx: 731.19, markPx: 735 }] },
    algos: { "QQQ-USDT-SWAP": [algo({ algoId: "qqq-old", side: "sell", sz: 10, slTriggerPx: "721", tpTriggerPx: "741" })] },
    fiveMinuteClose: { "QQQ-USDT-SWAP": 733 },
    hourlyBars: { "QQQ-USDT-SWAP": hourly(30, HOUR_LAST_CONFIRMED, 731) },
  });
  strictEqual(body.status, "ok");
  const failed = harness.evals.find((e) => e.id === "sub-btc");
  match(failed?.patch.lastNote ?? "", /error:OKX positions timed out/);
  strictEqual(harness.submitted.length, 1);
  strictEqual(harness.submitted[0]?.instId, "QQQ-USDT-SWAP");
});

Deno.test("a failed eval write does not fail the run", async () => {
  const { response } = await run({ subscriptions: [BTC_SHORT], positions: {}, evalFails: true });
  strictEqual(response.status, 200);
});

Deno.test("reduce key changes after an attempt that placed nothing, so the retry is a new order", async () => {
  const keys: string[] = [];
  const submit = (intent: Record<string, unknown>): SubmitOutcome => {
    if (intent.action === "reduce") keys.push(String(intent.idempotencyKey));
    return { httpStatus: 423, status: "rejected_risk", reason: "kill_switch_engaged", ordId: null, algoId: null, detail: null };
  };
  const base: Scenario = {
    positions: { "BTC-USDT-SWAP": BTC_SHORT_POSITION },
    algos: { "BTC-USDT-SWAP": BTC_PROTECTION },
    fiveMinuteClose: { "BTC-USDT-SWAP": 82300 },
    submit,
  };
  await run({ ...base, subscriptions: [{ ...BTC_SHORT, halfReduceAttempts: 0 }] });
  await run({ ...base, subscriptions: [{ ...BTC_SHORT, halfReduceAttempts: 1 }] });
  strictEqual(keys.length, 2);
  ok(keys[0] !== keys[1]);
});
