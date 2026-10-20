import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { PendingAlgo, PositionRow } from "./core/position.ts";
import type { Candle } from "./core/types.ts";
import {
  createTrendEvaluatorHandler,
  type AccountState,
  type AlertInsert,
  type OrderSubmitter,
  type SubmitOutcome,
  type TrendEventInsert,
  type TrendExchange,
  type TrendInstanceRow,
  type TrendPatch,
  type TrendStore,
} from "./handler.ts";

const CRON = "cron-secret-test";
const MIN = 60_000;
const BAR_MS = 300_000;
const NOW = Date.parse("2026-10-20T13:00:00.000Z");
const LAST_TS = NOW - MIN;

const PARAMS = {
  atrLen: 2,
  expansionWindow: 3,
  expansionMultiple: 1.1,
  donchianLen: 3,
  volumeLen: 3,
  volumeMultiple: 1.5,
  triggerTrMultiple: 1.2,
  clvBand: 0.25,
  erLen: 2,
  erMin: 0.2,
  addStepAtr: 0.5,
  maxAdds: 2,
  atrDecayExitPct: 28,
  maExitLen: 4,
  stopBufferAtr: 0.5,
};

function bar(index: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { ts: LAST_TS - (4 - index) * BAR_MS, open, high, low, close, volume, volCcy: volume, confirmed: true };
}

/** Quiet base, then one fat high-volume breakout bar at index 4 (same shape as the core tests). */
function breakoutSeries(): Candle[] {
  return [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 101, 99, 100.5),
    bar(2, 100.5, 101.5, 99.5, 101),
    bar(3, 101, 102, 100, 101.5),
    bar(4, 101.5, 110, 101, 109, 300),
  ];
}

function flatSeries(): Candle[] {
  return [0, 1, 2, 3, 4].map((i) => bar(i, 100, 100.6, 99.4, 100));
}

const BASE_INSTANCE: TrendInstanceRow = {
  id: "tf-1",
  mode: "live",
  runMode: "shadow",
  instId: "NVDA-USDT-SWAP",
  symbol: "NVDA",
  direction: "long",
  posSide: "net",
  tdMode: "isolated",
  lever: 20,
  firstSz: "0.01",
  theme: "trend-probe",
  themeStopCapU: 0.1,
  params: PARAMS,
  state: {},
  status: "armed",
  expiresAtMs: NOW + 86_400_000,
};

interface FakeState {
  patches: { id: string; patch: TrendPatch }[];
  events: TrendEventInsert[];
  alerts: AlertInsert[];
  claims: string[];
  intents: Record<string, unknown>[];
  cancels: { algoId: string; instId: string }[];
}

function newFakeState(): FakeState {
  return { patches: [], events: [], alerts: [], claims: [], intents: [], cancels: [] };
}

function fakeStore(
  instances: TrendInstanceRow[],
  barsBySymbol: Record<string, Candle[]>,
  state: FakeState,
  kill = false,
): TrendStore {
  return {
    killSwitchEngaged: () => Promise.resolve(kill),
    listActiveInstances: () => Promise.resolve(instances),
    confirmedCandles: (symbol) => Promise.resolve(barsBySymbol[symbol] ?? []),
    recordEval: (id, patch) => {
      state.patches.push({ id, patch });
      return Promise.resolve();
    },
    claim: (id) => {
      state.claims.push(id);
      return Promise.resolve(true);
    },
    getInstance: (id) => Promise.resolve(instances.find((row) => row.id === id) ?? null),
    insertEvent: (event) => {
      state.events.push(event);
      return Promise.resolve();
    },
    insertAlert: (alert) => {
      state.alerts.push(alert);
      return Promise.resolve();
    },
  };
}

function fakeExchange(state: FakeState, accountScript: AccountState[]): TrendExchange {
  let reads = 0;
  return {
    instrumentSpec: () => Promise.resolve({ ctVal: 1, lotSz: 0.01, minSz: 0.01, tickSz: 0.01 }),
    accountState: () => {
      const entry = accountScript[Math.min(reads, accountScript.length - 1)] ?? { positions: [], algos: [] };
      reads += 1;
      return Promise.resolve(entry);
    },
    cancelAlgos: (items) => {
      state.cancels.push(...items);
      return Promise.resolve();
    },
  };
}

const ACKED: SubmitOutcome = { httpStatus: 200, status: "acked", reason: null, ordId: "ord-1", algoId: null, detail: null };

function makeHandler(
  store: TrendStore,
  state: FakeState,
  outcome: SubmitOutcome = ACKED,
  accountScript: AccountState[] = [{ positions: [], algos: [] }],
  liveEnabled = true,
) {
  const submitter: OrderSubmitter = {
    submit: (intent) => {
      state.intents.push(intent);
      return Promise.resolve(outcome);
    },
  };
  return createTrendEvaluatorHandler({
    cronSecret: CRON,
    mode: "live",
    liveEnabled,
    dryRun: false,
    store,
    exchange: fakeExchange(state, accountScript),
    submitter,
    now: () => NOW,
    newIntentId: () => "tf-test-1",
    log: () => {},
  });
}

function request(auth = CRON): Request {
  return new Request("https://example.test/trend-evaluator", {
    method: "POST",
    headers: { authorization: `Bearer ${auth}` },
  });
}

async function run(handler: (req: Request) => Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(request());
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function positionRow(pos: number, avgPx: number): PositionRow {
  return { posSide: "net", pos, avgPx, markPx: avgPx };
}

function slAlgo(algoId: string, sz: number, slTriggerPx: string): PendingAlgo {
  return { algoId, algoClOrdId: `s-${algoId}`, side: "sell", posSide: "net", sz, reduceOnly: true, slTriggerPx, slOrdPx: "-1", tpTriggerPx: null, tpOrdPx: null };
}

Deno.test("shadow instance opens a simulated position on the breakout bar and never submits", async () => {
  const state = newFakeState();
  const handler = makeHandler(fakeStore([{ ...BASE_INSTANCE }], { NVDA: breakoutSeries() }, state), state);
  const { status, body } = await run(handler);
  strictEqual(status, 200);
  strictEqual((body as unknown as { instances: number }).instances, 1);
  strictEqual(state.intents.length, 0);
  strictEqual(state.alerts.length, 0);
  const kinds = state.events.map((event) => event.kind);
  ok(kinds.includes("trigger_fired"));
  ok(kinds.includes("shadow_open"));
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "active");
  strictEqual(patch.state?.entryPx, 109);
  strictEqual(patch.state?.stopPx, 99.25);
  strictEqual(patch.state?.positionSz, 0.01);
});

Deno.test("shadow instance logs the failed gates once, then stays quiet while they do not change", async () => {
  const state = newFakeState();
  const handler = makeHandler(fakeStore([{ ...BASE_INSTANCE }], { NVDA: flatSeries() }, state), state);
  await run(handler);
  const watching = state.events.filter((event) => event.kind === "watching");
  strictEqual(watching.length, 1);
  const failed = (watching[0]!.detail as { failedChecks: string[] }).failedChecks;
  ok(failed.length > 0);

  // Feed the recorded state back (rewound one bar): the same failed set must not be logged again.
  const state2 = newFakeState();
  const carried = { ...state.patches[0]!.patch.state, lastEvalBarTs: LAST_TS - BAR_MS };
  const handler2 = makeHandler(
    fakeStore([{ ...BASE_INSTANCE, state: carried as unknown as Record<string, unknown> }], { NVDA: flatSeries() }, state2),
    state2,
  );
  await run(handler2);
  strictEqual(state2.events.filter((event) => event.kind === "watching").length, 0);
});

Deno.test("a minute without a new bar writes nothing", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, state: { lastEvalBarTs: LAST_TS } };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state);
  const { body } = await run(handler);
  const reports = (body as unknown as { reports: { notes: string[] }[] }).reports;
  ok(reports[0]!.notes.includes("no_new_bar"));
  strictEqual(state.patches.length, 0);
  strictEqual(state.events.length, 0);
});

Deno.test("live instance opens through order-submit and verifies the position and its stop", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, runMode: "live" as const };
  const account: AccountState = {
    positions: [positionRow(0.01, 109.2)],
    algos: [slAlgo("algo-1", 0.01, "99.25")],
  };
  // First read is the pre-open collision check (must be flat), then the post-open account.
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, ACKED, [
    { positions: [], algos: [] },
    account,
  ]);
  const { status } = await run(handler);
  strictEqual(status, 200);
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "open");
  strictEqual(state.intents[0]!.sz, "0.01");
  strictEqual(state.intents[0]!.slTriggerPx, "99.25");
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "active");
  strictEqual(patch.state?.entryPx, 109.2);
  ok(state.events.map((event) => event.kind).includes("opened"));
  ok(state.alerts.some((alert) => alert.kind === "trend_opened"));
});

Deno.test("live instance fails terminally when order-submit rejects the open before placing", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, runMode: "live" as const };
  const rejected: SubmitOutcome = { httpStatus: 422, status: "rejected_risk", reason: "loss_exceeds_theme_cap", ordId: null, algoId: null, detail: null };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, rejected);
  await run(handler);
  strictEqual(state.patches[0]!.patch.status, "failed");
  ok(state.events.map((event) => event.kind).includes("open_failed"));
});

Deno.test("shadow active instance exits on ATR decay and closes the book", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    status: "active",
    state: {
      entryPx: 109,
      entryBarTs: LAST_TS - 4 * BAR_MS,
      entryAtr: 5.5,
      peakAtr: 10,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "done");
  strictEqual(patch.state?.exitReason, "atr_decay");
  strictEqual(patch.state?.positionSz, 0);
  ok(state.events.map((event) => event.kind).includes("shadow_exit"));
});

Deno.test("live active instance detects a vanished position, cancels the orphan stop and finishes", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    state: {
      entryPx: 109,
      peakAtr: 5.5,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const account: AccountState = { positions: [], algos: [slAlgo("algo-left", 0.01, "99.25")] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [account]);
  await run(handler);
  strictEqual(state.patches[0]!.patch.status, "done");
  deepStrictEqual(state.cancels, [{ algoId: "algo-left", instId: "NVDA-USDT-SWAP" }]);
  ok(state.events.map((event) => event.kind).includes("position_gone"));
  strictEqual(state.intents.length, 0);
});

Deno.test("live active instance pyramids one step and trails the unified stop", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    state: {
      entryPx: 109,
      entryAtr: 5.5,
      peakAtr: 5.5,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const bars = [...breakoutSeries(), bar(5, 110, 114, 112, 113)];
  const before: AccountState = { positions: [positionRow(0.01, 109)], algos: [slAlgo("algo-1", 0.01, "99.25")] };
  const after: AccountState = { positions: [positionRow(0.02, 111)], algos: [slAlgo("algo-2", 0.02, "109.38")] };
  const handler = makeHandler(fakeStore([instance], { NVDA: bars }, state), state, ACKED, [before, after]);
  await run(handler);
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "open");
  strictEqual(state.intents[0]!.slTriggerPx, "109.38");
  const patch = state.patches[0]!.patch;
  strictEqual(patch.state?.adds, 1);
  strictEqual(patch.state?.stopPx, 109.38);
  strictEqual(patch.state?.positionSz, 0.02);
  ok(state.events.map((event) => event.kind).includes("added"));
});

Deno.test("expired armed instance ends without evaluating the trigger", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, expiresAtMs: NOW - 1 };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state);
  await run(handler);
  strictEqual(state.patches[0]!.patch.status, "expired");
  strictEqual(state.intents.length, 0);
});

Deno.test("live open is refused when the account already holds a position on the instrument", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, runMode: "live" as const };
  const account: AccountState = { positions: [positionRow(0.05, 200)], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, ACKED, [account]);
  await run(handler);
  strictEqual(state.intents.length, 0);
  const skipped = state.events.find((event) => event.kind === "open_skipped");
  strictEqual((skipped!.detail as { reason: string }).reason, "position_collision");
  ok(state.alerts.some((alert) => alert.kind === "trend_open_blocked"));
  strictEqual(state.patches[0]!.patch.status, undefined);
});

Deno.test("expired active instance closes out even when the tape is stale", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    expiresAtMs: NOW - 1,
    state: {
      entryPx: 109,
      peakAtr: 5.5,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const stale = flatSeries().map((b) => ({ ...b, ts: b.ts - 30 * MIN }));
  const before: AccountState = { positions: [positionRow(0.01, 109)], algos: [slAlgo("algo-1", 0.01, "99.25")] };
  const after: AccountState = { positions: [], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: stale }, state), state, ACKED, [before, after]);
  await run(handler);
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "close");
  strictEqual(state.patches[0]!.patch.status, "expired");
  ok(state.events.map((event) => event.kind).includes("expired"));
});

Deno.test("expired armed instance ends even when the tape is stale", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, expiresAtMs: NOW - 1 };
  const stale = flatSeries().map((b) => ({ ...b, ts: b.ts - 30 * MIN }));
  const handler = makeHandler(fakeStore([instance], { NVDA: stale }, state), state);
  await run(handler);
  strictEqual(state.patches[0]!.patch.status, "expired");
  strictEqual(state.intents.length, 0);
});

Deno.test("shadow instances evaluate while live submissions are disabled; live instances wait", async () => {
  const state = newFakeState();
  const shadow = { ...BASE_INSTANCE };
  const live = { ...BASE_INSTANCE, id: "tf-2", runMode: "live" as const };
  const handler = makeHandler(fakeStore([shadow, live], { NVDA: breakoutSeries() }, state), state, ACKED, [
    { positions: [], algos: [] },
  ], false);
  const { body } = await run(handler);
  strictEqual((body as unknown as { liveDisabled: boolean }).liveDisabled, true);
  ok(state.events.some((event) => event.kind === "shadow_open" && event.instanceId === "tf-1"));
  ok(!state.events.some((event) => event.instanceId === "tf-2"));
  strictEqual(state.intents.length, 0);
  const reports = (body as unknown as { reports: { notes: string[] }[] }).reports;
  ok(reports[1]!.notes.includes("live_disabled"));
});

Deno.test("live exit closes only the instance's own size when the account row carries external size", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    state: {
      entryPx: 109,
      entryAtr: 5.5,
      peakAtr: 10,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const before: AccountState = {
    positions: [positionRow(0.03, 109)],
    algos: [slAlgo("algo-own", 0.01, "99.25"), slAlgo("algo-external", 0.02, "95")],
  };
  const after: AccountState = {
    positions: [positionRow(0.02, 109)],
    algos: [slAlgo("algo-own", 0.01, "99.25"), slAlgo("algo-external", 0.02, "95")],
  };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [before, before, after]);
  await run(handler);
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "close");
  strictEqual(state.intents[0]!.sz, "0.01");
  strictEqual(state.patches[0]!.patch.status, "done");
  // Only this instance's stop is swept; the external position's protection stays in place.
  deepStrictEqual(state.cancels, [{ algoId: "algo-own", instId: "NVDA-USDT-SWAP" }]);
});

Deno.test("repeat adds alert under distinct dedup keys", async () => {
  const mk = (shift: number) => {
    const fake = newFakeState();
    const instance: TrendInstanceRow = {
      ...BASE_INSTANCE,
      runMode: "live",
      status: "active",
      state: {
        entryPx: 109,
        entryAtr: 5.5,
        peakAtr: 5.5,
        stopPx: 99.25,
        positionSz: 0.01,
        adds: 0,
        lastAddAnchorPx: 109,
        lastEvalBarTs: LAST_TS - BAR_MS + shift,
      },
    };
    const bars = [...breakoutSeries(), bar(5, 110, 114, 112, 113)].map((b) => ({ ...b, ts: b.ts + shift }));
    const before: AccountState = { positions: [positionRow(0.01, 109)], algos: [slAlgo("algo-1", 0.01, "99.25")] };
    const after: AccountState = { positions: [positionRow(0.02, 111)], algos: [slAlgo("algo-2", 0.02, "109.38")] };
    const handler = makeHandler(fakeStore([instance], { NVDA: bars }, fake), fake, ACKED, [before, after]);
    return { fake, handler };
  };
  const a = mk(0);
  await run(a.handler);
  const b = mk(2 * BAR_MS);
  await run(b.handler);
  const keyA = a.fake.alerts.find((alert) => alert.kind === "trend_added")!.dedup_key;
  const keyB = b.fake.alerts.find((alert) => alert.kind === "trend_added")!.dedup_key;
  ok(keyA.startsWith("trend:tf-1:trend_added:"));
  ok(keyB.startsWith("trend:tf-1:trend_added:"));
  ok(keyA !== keyB);
});

Deno.test("kill switch skips the run and a wrong secret is rejected", async () => {
  const state = newFakeState();
  const handler = makeHandler(fakeStore([{ ...BASE_INSTANCE }], { NVDA: breakoutSeries() }, state, true), state);
  const { body } = await run(handler);
  strictEqual((body as unknown as { status: string }).status, "skipped");
  strictEqual(state.patches.length, 0);

  const denied = await handler(request("wrong-secret"));
  strictEqual(denied.status, 401);
});

Deno.test("live add stays pending until its fill is visible, then settles without resubmitting", async () => {
  const bars = [...breakoutSeries(), bar(5, 110, 114, 112, 113)];
  const activeState = {
    entryPx: 109,
    entryAtr: 5.5,
    peakAtr: 5.5,
    stopPx: 99.25,
    positionSz: 0.01,
    adds: 0,
    lastAddAnchorPx: 109,
    lastEvalBarTs: LAST_TS - BAR_MS,
  };
  // Cycle 1: the add is acked but the account still shows the pre-add size.
  const state1 = newFakeState();
  const instance1: TrendInstanceRow = { ...BASE_INSTANCE, runMode: "live", status: "active", state: activeState };
  const preFill: AccountState = { positions: [positionRow(0.01, 109)], algos: [slAlgo("algo-1", 0.01, "99.25")] };
  const handler1 = makeHandler(fakeStore([instance1], { NVDA: bars }, state1), state1, ACKED, [preFill]);
  await run(handler1);
  strictEqual(state1.intents.length, 1);
  strictEqual(state1.intents[0]!.action, "open");
  const patch1 = state1.patches[0]!.patch;
  ok(patch1.state?.pendingAdd);
  strictEqual(patch1.state?.adds, 0);
  strictEqual(patch1.state?.stopPx, 99.25);
  ok(state1.events.map((event) => event.kind).includes("add_fill_pending"));

  // Cycle 2: a new bar arrives and the fill is now visible — settle, don't resubmit.
  const state2 = newFakeState();
  const carried = { ...patch1.state, lastEvalBarTs: LAST_TS + BAR_MS };
  const bars2 = [...bars, bar(6, 112, 115, 111, 114)];
  const instance2: TrendInstanceRow = { ...BASE_INSTANCE, runMode: "live", status: "active", state: carried as unknown as Record<string, unknown> };
  const filled: AccountState = { positions: [positionRow(0.02, 111)], algos: [slAlgo("algo-2", 0.02, "109.38")] };
  const handler2 = makeHandler(fakeStore([instance2], { NVDA: bars2 }, state2), state2, ACKED, [filled]);
  await run(handler2);
  strictEqual(state2.intents.length, 0);
  const patch2 = state2.patches[0]!.patch;
  strictEqual(patch2.state?.pendingAdd, null);
  strictEqual(patch2.state?.adds, 1);
  strictEqual(patch2.state?.stopPx, 109.38);
  strictEqual(patch2.state?.positionSz, 0.02);
  ok(state2.events.map((event) => event.kind).includes("added"));
});

Deno.test("reconciler never cancels a protective algo it does not own", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    state: {
      entryPx: 109,
      peakAtr: 0.5,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      protectiveAlgoId: "algo-1",
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  // algo-1 is ours at the unified stop; ext-1 guards someone else's exposure at another stop.
  const account: AccountState = {
    positions: [positionRow(0.01, 109)],
    algos: [slAlgo("algo-1", 0.01, "99.25"), slAlgo("ext-1", 0.05, "95")],
  };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [account]);
  await run(handler);
  deepStrictEqual(state.cancels, []);
  strictEqual(state.intents.length, 0);
  ok(state.alerts.some((alert) => alert.kind === "trend_external_algos"));
});

Deno.test("open stays recoverable when post-open verification throws", async () => {
  const state = newFakeState();
  let reads = 0;
  const store = fakeStore([{ ...BASE_INSTANCE, runMode: "live" as const }], { NVDA: breakoutSeries() }, state);
  const exchange: TrendExchange = {
    instrumentSpec: () => Promise.resolve({ ctVal: 1, lotSz: 0.01, minSz: 0.01, tickSz: 0.01 }),
    accountState: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve({ positions: [], algos: [] });
      return Promise.reject(new Error("boom"));
    },
    cancelAlgos: () => Promise.resolve(),
  };
  const submitter: OrderSubmitter = { submit: () => Promise.resolve(ACKED) };
  const handler = createTrendEvaluatorHandler({
    cronSecret: CRON,
    mode: "live",
    liveEnabled: true,
    dryRun: false,
    store,
    exchange,
    submitter,
    now: () => NOW,
    newIntentId: () => "tf-test-1",
    log: () => {},
  });
  const { status } = await run(handler);
  strictEqual(status, 200);
  const patch = state.patches[0]!.patch;
  // Already active: the next cycle adopts the position instead of the collision guard wedging it.
  strictEqual(patch.status, "active");
  strictEqual(patch.state?.positionSz, 0.01);
  ok(state.events.map((event) => event.kind).includes("opened_ack"));
  ok(patch.lastNote.includes("post_open_verify_threw"));
  ok(state.alerts.some((alert) => alert.kind === "trend_reconcile_failed"));
});

Deno.test("acked open with no visible fill stays active and verifies on the next cycle", async () => {
  const bars = breakoutSeries();
  const state1 = newFakeState();
  const instance1 = { ...BASE_INSTANCE, runMode: "live" as const };
  // Collision check is flat; the post-open read still shows no position (fill latency).
  const empty: AccountState = { positions: [], algos: [] };
  const handler1 = makeHandler(fakeStore([instance1], { NVDA: bars }, state1), state1, ACKED, [{ positions: [], algos: [] }, empty]);
  await run(handler1);
  const patch1 = state1.patches[0]!.patch;
  strictEqual(patch1.status, "active");
  strictEqual(patch1.state?.openVerified, false);
  strictEqual(patch1.state?.lastAddAnchorPx, 109);
  ok(state1.events.map((event) => event.kind).includes("open_unverified"));

  // Next cycle the fill is visible: adopt it and verify.
  const state2 = newFakeState();
  const carried = { ...patch1.state, lastEvalBarTs: LAST_TS };
  const bars2 = [...bars, bar(5, 108, 110, 107, 109)];
  const instance2: TrendInstanceRow = { ...BASE_INSTANCE, runMode: "live", status: "active", state: carried as unknown as Record<string, unknown> };
  const filled: AccountState = { positions: [positionRow(0.01, 109.2)], algos: [] };
  const handler2 = makeHandler(fakeStore([instance2], { NVDA: bars2 }, state2), state2, ACKED, [filled]);
  await run(handler2);
  const patch2 = state2.patches[0]!.patch;
  strictEqual(patch2.state?.openVerified, true);
  strictEqual(patch2.state?.positionSz, 0.01);
  strictEqual(patch2.state?.entryPx, 109.2);
  strictEqual(patch2.state?.lastAddAnchorPx, 109.2);
  ok(state2.events.map((event) => event.kind).includes("open_verified"));
});

Deno.test("open with an unknown placement outcome stays recoverable instead of failing", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, runMode: "live" as const };
  const unknown: SubmitOutcome = { httpStatus: 0, status: "exchange_error", reason: "outcome_unknown", ordId: null, algoId: null, detail: null };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, unknown);
  await run(handler);
  strictEqual(state.intents.length, 1);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "active");
  strictEqual(patch.state?.openVerified, false);
  ok(state.events.map((event) => event.kind).includes("open_unknown_outcome"));
  ok(patch.lastNote.includes("open_unknown_outcome"));
});

Deno.test("verified live open initializes the add anchor from the fill price", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, runMode: "live" as const };
  const account: AccountState = { positions: [positionRow(0.01, 109.2)], algos: [slAlgo("algo-1", 0.01, "99.25")] };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, ACKED, [
    { positions: [], algos: [] },
    account,
  ]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "active");
  strictEqual(patch.state?.openVerified, true);
  strictEqual(patch.state?.lastAddAnchorPx, 109.2);
});

Deno.test("strategy stands down instead of adopting the external remainder after its stop fires", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    state: {
      entryPx: 109,
      peakAtr: 0.5,
      stopPx: 99.25,
      positionSz: 0.05,
      adds: 0,
      protectiveAlgoId: "algo-1",
      openVerified: true,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  // Our unified stop fired (algo-1 gone) closing our 0.05; the 0.03 left is someone else's.
  const account: AccountState = { positions: [positionRow(0.03, 110)], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [account]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "done");
  strictEqual(patch.state?.exitReason, "ownership_lost");
  strictEqual(patch.state?.positionSz, 0);
  ok(state.events.map((event) => event.kind).includes("ownership_lost"));
  ok(state.alerts.some((alert) => alert.kind === "trend_ownership_lost"));
  strictEqual(state.intents.length, 0);
  deepStrictEqual(state.cancels, []);
});

Deno.test("manual partial close with our stop still in place keeps managing the remainder", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    state: {
      entryPx: 109,
      peakAtr: 0.5,
      stopPx: 99.25,
      positionSz: 0.05,
      adds: 0,
      protectiveAlgoId: "algo-1",
      openVerified: true,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  // User manually reduced our position; our stop algo is still there, so the rest is ours.
  const account: AccountState = { positions: [positionRow(0.03, 109)], algos: [slAlgo("algo-1", 0.05, "99.25")] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [account]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, undefined);
  strictEqual(patch.state?.positionSz, 0.03);
  ok(!state.events.map((event) => event.kind).includes("ownership_lost"));
});
