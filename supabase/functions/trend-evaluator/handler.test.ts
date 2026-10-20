import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { PendingAlgo, PositionRow } from "./core/position.ts";
import type { Candle } from "./core/types.ts";
import {
  createTrendEvaluatorHandler,
  PENDING_ADD_TIMEOUT_MS,
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

Deno.test("add with an unknown placement outcome is tracked as pending and settles next cycle", async () => {
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
  // Cycle 1: the add submission's response is lost in transport — it may have reached OKX.
  const state1 = newFakeState();
  const instance1: TrendInstanceRow = { ...BASE_INSTANCE, runMode: "live", status: "active", state: activeState };
  const preFill: AccountState = { positions: [positionRow(0.01, 109)], algos: [slAlgo("algo-1", 0.01, "99.25")] };
  const transport: SubmitOutcome = { httpStatus: 0, status: "transport_error", reason: null, ordId: null, algoId: null, detail: null };
  const handler1 = makeHandler(fakeStore([instance1], { NVDA: bars }, state1), state1, transport, [preFill]);
  await run(handler1);
  strictEqual(state1.intents.length, 1);
  const patch1 = state1.patches[0]!.patch;
  strictEqual(patch1.status, undefined);
  ok(patch1.state?.pendingAdd);
  strictEqual(patch1.state?.pendingAdd?.szNum, 0.01);
  strictEqual(patch1.state?.adds, 0);
  strictEqual(patch1.state?.stopPx, 99.25);
  ok(patch1.lastNote.includes("add_unknown_outcome"));
  ok(state1.events.map((event) => event.kind).includes("add_fill_pending"));

  // Cycle 2: the fill is visible — settle it from the account, never resubmit.
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
  strictEqual(patch2.state?.positionSz, 0.02);
});

Deno.test("pending add settles before an exit close so the close covers the filled size", async () => {
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
      protectiveAlgoId: "algo-2",
      openVerified: true,
      pendingAdd: { szNum: 0.01, barTs: LAST_TS - BAR_MS, newStopPx: 109.38, anchorPx: 113 },
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const filled: AccountState = { positions: [positionRow(0.02, 111)], algos: [slAlgo("algo-2", 0.02, "109.38")] };
  const flat: AccountState = { positions: [], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [
    filled,
    filled,
    filled,
    filled,
    flat,
  ]);
  await run(handler);
  // The only submission is the exit close, and it covers the settled 0.02 — not the stale 0.01.
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "close");
  strictEqual(state.intents[0]!.sz, "0.02");
  const kinds = state.events.map((event) => event.kind);
  ok(kinds.includes("added"));
  ok(kinds.includes("exit_triggered"));
  ok(kinds.indexOf("added") < kinds.indexOf("exit_triggered"));
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "done");
  strictEqual(patch.state?.adds, 1);
  strictEqual(patch.state?.exitReason, "atr_decay");
});

Deno.test("expiry settles a pending add before closing out", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    expiresAtMs: NOW - 1_000,
    state: {
      entryPx: 109,
      entryAtr: 5.5,
      peakAtr: 5.5,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      protectiveAlgoId: "algo-2",
      openVerified: true,
      pendingAdd: { szNum: 0.01, barTs: LAST_TS - BAR_MS, newStopPx: 109.38, anchorPx: 113 },
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const filled: AccountState = { positions: [positionRow(0.02, 111)], algos: [slAlgo("algo-2", 0.02, "109.38")] };
  const flat: AccountState = { positions: [], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [
    filled,
    filled,
    filled,
    flat,
  ]);
  await run(handler);
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "close");
  strictEqual(state.intents[0]!.sz, "0.02");
  const kinds = state.events.map((event) => event.kind);
  ok(kinds.includes("added"));
  ok(kinds.includes("expired"));
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "expired");
  strictEqual(patch.state?.adds, 1);
});

Deno.test("the loser of the open action claim persists no state", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, runMode: "live" as const };
  const store: TrendStore = {
    ...fakeStore([instance], { NVDA: breakoutSeries() }, state),
    claim: () => Promise.resolve(false),
  };
  const handler = makeHandler(store, state, ACKED, [{ positions: [], algos: [] }]);
  await run(handler);
  // No recordEval, no events, no submission: the winner's opened state must not be
  // overwritten by this invocation's pre-open snapshot.
  strictEqual(state.patches.length, 0);
  strictEqual(state.events.length, 0);
  strictEqual(state.intents.length, 0);
});

Deno.test("ownership is lost when the remainder matches the tracked size but our stop is gone", async () => {
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
  // Our stop fired and closed our 0.05; an equal-size external position opened in the same
  // window. Size alone cannot tell it apart from ours — the missing algo can.
  const account: AccountState = { positions: [positionRow(0.05, 110)], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [account]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "done");
  strictEqual(patch.state?.exitReason, "ownership_lost");
  strictEqual(patch.state?.positionSz, 0);
  ok(state.events.map((event) => event.kind).includes("ownership_lost"));
  strictEqual(state.intents.length, 0);
  deepStrictEqual(state.cancels, []);
});

Deno.test("a stale owned algo id is recovered from the live replacement instead of terminalizing", async () => {
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
      // algo-old was replaced by a reconcile amend whose new id was never persisted; the
      // replacement is live at exactly this book's (size, stop).
      protectiveAlgoId: "algo-old",
      openVerified: true,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const account: AccountState = {
    positions: [positionRow(0.05, 110)],
    algos: [slAlgo("algo-new", 0.05, "99.25")],
  };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [account]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  // The replacement is re-adopted: the book stays active, no ownership_lost terminalization.
  strictEqual(patch.status, undefined);
  strictEqual(patch.state?.protectiveAlgoId, "algo-new");
  ok(!patch.state?.exitReason);
  ok(state.events.map((event) => event.kind).includes("algo_id_recovered"));
  ok(!state.events.map((event) => event.kind).includes("ownership_lost"));
  strictEqual(state.intents.length, 0);
});

Deno.test("a post-amend account read failure keeps the replacement algo id for the next cycle", async () => {
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
      protectiveAlgoId: "algo-old",
      openVerified: true,
      lastAddAnchorPx: 109,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  // algo-old sits at the wrong stop, so the drift reconcile amends to the unified stop; the
  // post-amend account read then throws. The known-good replacement id must still be
  // persisted so the next cycle adopts it instead of terminalizing on the stale id.
  const drifted: AccountState = {
    positions: [positionRow(0.05, 110)],
    algos: [slAlgo("algo-old", 0.05, "95.00")],
  };
  let reads = 0;
  const script: (AccountState | "throw")[] = [drifted, drifted, drifted, "throw"];
  const exchange: TrendExchange = {
    instrumentSpec: () => Promise.resolve({ ctVal: 1, lotSz: 0.01, minSz: 0.01, tickSz: 0.01 }),
    accountState: () => {
      const entry = script[Math.min(reads, script.length - 1)];
      reads += 1;
      return entry === "throw" ? Promise.reject(new Error("read boom")) : Promise.resolve(entry);
    },
    cancelAlgos: (items) => {
      state.cancels.push(...items);
      return Promise.resolve();
    },
  };
  const submitter: OrderSubmitter = {
    submit: (intent) => {
      state.intents.push(intent);
      return Promise.resolve({ ...ACKED, algoId: "algo-new" });
    },
  };
  const handler = createTrendEvaluatorHandler({
    cronSecret: CRON,
    mode: "live",
    liveEnabled: true,
    dryRun: false,
    store: fakeStore([instance], { NVDA: flatSeries() }, state),
    exchange,
    submitter,
    now: () => NOW,
    newIntentId: () => "tf-test-1",
    log: () => {},
  });
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, undefined);
  strictEqual(patch.state?.protectiveAlgoId, "algo-new");
  ok(state.events.map((event) => event.kind).includes("reconcile_failed"));
  ok(state.alerts.some((alert) => alert.kind === "trend_reconcile_failed" && (alert.dedup_key ?? "").includes(":drift:")));
  strictEqual(state.cancels.length, 0);
});

Deno.test("a partially filled add settles its observed delta at timeout instead of being dropped", async () => {
  const bars = [...breakoutSeries(), bar(5, 110, 114, 112, 113)];
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
      protectiveAlgoId: "algo-2",
      openVerified: true,
      // An accepted 0.02 add whose fill never completed: only 0.01 landed, the rest was
      // canceled, and the fill has been invisible past the one-hour timeout.
      pendingAdd: { szNum: 0.02, barTs: LAST_TS - 61 * MIN, newStopPx: 109.38, anchorPx: 113 },
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const partial: AccountState = {
    positions: [positionRow(0.02, 110)],
    algos: [slAlgo("algo-2", 0.02, "109.38")],
  };
  const state = newFakeState();
  const handler = makeHandler(fakeStore([instance], { NVDA: bars }, state), state, ACKED, [partial]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  // The partial fill is adopted into the book (not cleared as dead): the next exit closes it.
  strictEqual(patch.state?.pendingAdd, null);
  strictEqual(patch.state?.adds, 1);
  strictEqual(patch.state?.positionSz, 0.02);
  strictEqual(patch.state?.entryPx, 110);
  strictEqual(patch.state?.stopPx, 109.38);
  ok(patch.lastNote.includes("add_partial_fill"));
});

Deno.test("a timed-out pending add with no fill is still cleared without touching the book", async () => {
  const bars = [...breakoutSeries(), bar(5, 110, 114, 112, 113)];
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
      protectiveAlgoId: "algo-1",
      openVerified: true,
      pendingAdd: { szNum: 0.01, barTs: LAST_TS - 61 * MIN, newStopPx: 109.38, anchorPx: 113 },
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  // Nothing landed: the account still shows only the pre-add size.
  const noFill: AccountState = {
    positions: [positionRow(0.01, 109)],
    algos: [slAlgo("algo-1", 0.01, "99.25")],
  };
  const state = newFakeState();
  const handler = makeHandler(fakeStore([instance], { NVDA: bars }, state), state, ACKED, [noFill]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.state?.pendingAdd, null);
  strictEqual(patch.state?.adds, 0);
  strictEqual(patch.state?.positionSz, 0.01);
  ok(patch.lastNote.includes("add_fill_timeout:pending_cleared"));
});

Deno.test("expiry settles an observed partial add instead of dropping it", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    expiresAtMs: NOW - 1_000,
    state: {
      entryPx: 109,
      entryAtr: 5.5,
      peakAtr: 5.5,
      stopPx: 99.25,
      positionSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      protectiveAlgoId: "algo-2",
      openVerified: true,
      // An accepted 0.02 add, only 0.01 landed, expiry hits before the fill timeout.
      pendingAdd: { szNum: 0.02, barTs: LAST_TS - BAR_MS, newStopPx: 109.38, anchorPx: 113 },
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const partial: AccountState = {
    positions: [positionRow(0.02, 110)],
    algos: [slAlgo("algo-2", 0.02, "109.38")],
  };
  const flat: AccountState = { positions: [], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [
    partial,
    partial,
    partial,
    flat,
  ]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "expired");
  // The partial delta is adopted into the book (not dropped): the close covers the
  // settled 0.02, and the settled add is recorded.
  strictEqual(patch.state?.pendingAdd, null);
  strictEqual(patch.state?.adds, 1);
  strictEqual(patch.state?.positionSz, 0);
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "close");
  strictEqual(state.intents[0]!.sz, "0.02");
  ok(patch.lastNote.includes("add_partial_fill"));
});

Deno.test("an exit fires while an add is pending: the visible exposure is closed", async () => {
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
      protectiveAlgoId: "algo-2",
      openVerified: true,
      // The add's fill is not visible yet (within the timeout): the exit must not wait.
      pendingAdd: { szNum: 0.01, barTs: LAST_TS - BAR_MS, newStopPx: 109.38, anchorPx: 113 },
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const noFill: AccountState = {
    positions: [positionRow(0.01, 109)],
    algos: [slAlgo("algo-2", 0.01, "99.25")],
  };
  const flat: AccountState = { positions: [], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [
    noFill,
    noFill,
    noFill,
    noFill,
    flat,
  ]);
  await run(handler);
  // Only the exit close is submitted, sized to the visible 0.01 — not blocked by the pending add.
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "close");
  strictEqual(state.intents[0]!.sz, "0.01");
  const kinds = state.events.map((event) => event.kind);
  ok(kinds.includes("exit_triggered"));
  ok(kinds.includes("exit_with_pending_add"));
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "done");
  strictEqual(patch.state?.pendingAdd, null);
  strictEqual(patch.state?.exitReason, "atr_decay");
  ok(state.alerts.some((a) => a.kind === "trend_add_failed" && a.payload.outcome === "exit_with_pending_add"));
});

Deno.test("an exit fires while an add is partially filled: the partial fill is settled and closed", async () => {
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
      protectiveAlgoId: "algo-2",
      openVerified: true,
      // An accepted 0.02 add, only 0.01 landed, and the exit fires before the fill timeout.
      // Without conclusive reconcile the exit would drop the marker and close only the
      // visible 0.01, orphaning the partially filled 0.01 as unmanaged exposure.
      pendingAdd: { szNum: 0.02, barTs: LAST_TS - BAR_MS, newStopPx: 109.38, anchorPx: 113 },
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const partial: AccountState = {
    positions: [positionRow(0.02, 110)],
    algos: [slAlgo("algo-2", 0.02, "109.38")],
  };
  const flat: AccountState = { positions: [], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [
    partial,
    partial,
    partial,
    partial,
    partial,
    flat,
  ]);
  await run(handler);
  // The partial delta is committed into the book before the exit: the close covers the
  // reconciled 0.02, and the settled add is recorded — nothing is left unmanaged.
  strictEqual(state.intents.length, 1);
  strictEqual(state.intents[0]!.action, "close");
  strictEqual(state.intents[0]!.sz, "0.02");
  const kinds = state.events.map((event) => event.kind);
  ok(kinds.includes("exit_triggered"));
  ok(kinds.includes("exit_with_pending_add"));
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "done");
  strictEqual(patch.state?.pendingAdd, null);
  strictEqual(patch.state?.adds, 1);
  strictEqual(patch.state?.positionSz, 0);
  strictEqual(patch.state?.exitReason, "atr_decay");
  ok(patch.lastNote.includes("add_partial_fill"));
  ok(patch.lastNote.includes("exit_with_pending_add:settled"));
});

Deno.test("an adverse add fill tightens the unified stop to respect the theme cap", async () => {
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
  // The add fills 2 points above the decision close: (115 - 109.38) * 0.02 = 0.1124 > 0.1 cap.
  const adverse: AccountState = { positions: [positionRow(0.02, 115)], algos: [slAlgo("algo-2", 0.02, "110")] };
  const handler = makeHandler(fakeStore([instance], { NVDA: bars }, state), state, ACKED, [
    before,
    adverse,
    adverse,
    adverse,
  ]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.state?.adds, 1);
  strictEqual(patch.state?.positionSz, 0.02);
  // Tightened to the cap-implied level: 115 - 0.1 / 0.02 = 110 (was 109.38).
  strictEqual(patch.state?.stopPx, 110);
  ok(state.events.map((event) => event.kind).includes("add_stop_tightened"));
  ok(state.alerts.some((a) => a.kind === "trend_add_stop_tightened"));
  ok(patch.lastNote.includes("add_stop_tightened"));
});

Deno.test("live open verification persists the executed initial unit size", async () => {
  const state = newFakeState();
  // Configured firstSz is 0.10 but risk sizing executes 0.01: the persisted unit is the
  // executed size, not the configured one.
  const instance = { ...BASE_INSTANCE, runMode: "live" as const, firstSz: "0.10" };
  const account: AccountState = {
    positions: [positionRow(0.01, 109.2)],
    algos: [slAlgo("algo-1", 0.01, "99.25")],
  };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, ACKED, [
    { positions: [], algos: [] },
    account,
  ]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(state.intents[0]!.sz, "0.01");
  strictEqual(patch.state?.positionSz, 0.01);
  strictEqual(patch.state?.initialUnitSz, 0.01);
});

Deno.test("add planning caps at the executed initial unit, not the configured firstSz", async () => {
  const bars = [...breakoutSeries(), bar(5, 110, 114, 112, 113)];
  // Configured firstSz 0.10, but the open was risk-sized down to 0.01. The loss cap is wide
  // open (100U) so it cannot bind: without the executed-unit cap the plan would take 0.10.
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    firstSz: "0.10",
    themeStopCapU: 100,
    state: {
      entryPx: 109,
      entryAtr: 5.5,
      peakAtr: 5.5,
      stopPx: 99.25,
      positionSz: 0.01,
      initialUnitSz: 0.01,
      adds: 0,
      lastAddAnchorPx: 109,
      protectiveAlgoId: "algo-1",
      openVerified: true,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  const preFill: AccountState = {
    positions: [positionRow(0.01, 109)],
    algos: [slAlgo("algo-1", 0.01, "99.25")],
  };
  const transport: SubmitOutcome = { httpStatus: 0, status: "transport_error", reason: null, ordId: null, algoId: null, detail: null };
  const state = newFakeState();
  const handler = makeHandler(fakeStore([instance], { NVDA: bars }, state), state, transport, [preFill]);
  await run(handler);
  strictEqual(state.intents.length, 1);
  // Adds reuse the open intent shape; the reason distinguishes the add path.
  ok((state.intents[0]!.reason as string).startsWith("trend_follow add"));
  strictEqual(state.intents[0]!.sz, "0.01");
});

Deno.test("live open tightens the stop when the fill lands worse than the trigger close", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, runMode: "live" as const };
  // Trigger close 109, planned stop 99.25, size 0.01: the planned whole-position loss is
  // (109 - 99.25) * 0.01 = 0.0975 U <= 0.1 U cap. A 109.50 fill pushes it to 0.1025 U, so the
  // stop must tighten to 109.50 - 0.1/0.01 = 99.50 before protection converges.
  const account: AccountState = { positions: [positionRow(0.01, 109.5)], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, ACKED, [
    { positions: [], algos: [] },
    account,
  ]);
  await run(handler);
  strictEqual(state.intents[0]!.action, "open");
  strictEqual(state.intents[0]!.slTriggerPx, "99.25");
  // Protection converges with the tightened stop (99.50), not the planned one.
  strictEqual(state.intents[1]!.action, "amend_tpsl");
  strictEqual(state.intents[1]!.slTriggerPx, "99.50");
  const patch = state.patches[0]!.patch;
  strictEqual(patch.state?.entryPx, 109.5);
  strictEqual(patch.state?.stopPx, 99.5);
  ok(state.events.map((event) => event.kind).includes("open_stop_tightened"));
  ok(state.alerts.some((alert) => alert.kind === "trend_open_stop_tightened"));
  ok(state.alerts.some((alert) => alert.kind === "trend_opened" && (alert.payload as { stop_px: number }).stop_px === 99.5));
});

Deno.test("live open keeps the planned stop when the fill lands inside the cap", async () => {
  const state = newFakeState();
  const instance = { ...BASE_INSTANCE, runMode: "live" as const };
  // 109.20 fill: (109.20 - 99.25) * 0.01 = 0.0995 U <= 0.1 U cap — no tightening.
  const account: AccountState = { positions: [positionRow(0.01, 109.2)], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, ACKED, [
    { positions: [], algos: [] },
    account,
  ]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.state?.stopPx, 99.25);
  ok(!state.events.map((event) => event.kind).includes("open_stop_tightened"));
});

Deno.test("acked add with no visible position hangs the add as pending and settles next cycle", async () => {
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
  const before: AccountState = { positions: [positionRow(0.01, 109)], algos: [slAlgo("algo-1", 0.01, "99.25")] };
  // Cycle 1: the add is acked but the position row is gone from the account read — the add
  // must be recorded as pending, not dropped (dropping it would cap the landed fill as
  // external exposure outside the tracked stop).
  const state1 = newFakeState();
  const instance1: TrendInstanceRow = { ...BASE_INSTANCE, runMode: "live", status: "active", state: activeState };
  const handler1 = makeHandler(fakeStore([instance1], { NVDA: bars }, state1), state1, ACKED, [
    before,
    { positions: [], algos: [] },
  ]);
  await run(handler1);
  strictEqual(state1.intents.length, 1);
  strictEqual(state1.intents[0]!.action, "open");
  const patch1 = state1.patches[0]!.patch;
  deepStrictEqual(patch1.state?.pendingAdd, {
    szNum: 0.01,
    barTs: LAST_TS + BAR_MS,
    newStopPx: 109.38,
    anchorPx: 113,
  });
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

Deno.test("close retries rotate the idempotency key after a confirmed-unplaced failure", async () => {
  const rejected: SubmitOutcome = { httpStatus: 422, status: "rejected_risk", reason: "loss_exceeds_theme_cap", ordId: null, algoId: null, detail: null };
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
  const account: AccountState = { positions: [positionRow(0.01, 109)], algos: [slAlgo("algo-1", 0.01, "99.25")] };
  const expired = (st: unknown): TrendInstanceRow => ({
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    expiresAtMs: NOW - MIN,
    state: st as Record<string, unknown>,
  });
  const keyOf = (intent: Record<string, unknown>): string => intent.idempotencyKey as string;

  // Cycle 1: expiry close is rejected before placing — the retry bucket advances to 1 and the
  // instance stays active.
  const state1 = newFakeState();
  const handler1 = makeHandler(fakeStore([expired(activeState)], { NVDA: flatSeries() }, state1), state1, rejected, [account]);
  await run(handler1);
  strictEqual(state1.intents.length, 1);
  strictEqual(state1.intents[0]!.action, "close");
  const patch1 = state1.patches[0]!.patch;
  strictEqual(patch1.state?.closeAttempts, 1);
  strictEqual(patch1.status, undefined);
  ok(state1.events.map((event) => event.kind).includes("close_failed"));
  const key1 = keyOf(state1.intents[0]!);

  // Cycle 2: same frozen bar, same reason — the retry must use a fresh key, not replay the
  // stored failure or hit duplicate_key_expired.
  const state2 = newFakeState();
  const carried = { ...patch1.state, lastEvalBarTs: LAST_TS - BAR_MS };
  const handler2 = makeHandler(fakeStore([expired(carried)], { NVDA: flatSeries() }, state2), state2, rejected, [account]);
  await run(handler2);
  strictEqual(state2.intents.length, 1);
  const key2 = keyOf(state2.intents[0]!);
  ok(key1 !== key2, `idempotency key must rotate: ${key1} vs ${key2}`);
  strictEqual(state2.patches[0]!.patch.state?.closeAttempts, 2);
});

Deno.test("partially filled open stays unverified instead of locking the book at the partial size", async () => {
  const state = newFakeState();
  // Wide loss cap so risk sizing executes the full configured firstSz of 0.10.
  const instance = { ...BASE_INSTANCE, runMode: "live" as const, firstSz: "0.10", themeStopCapU: 100 };
  // First read is the pre-open collision check (flat); the post-ack read shows only a
  // 0.04 partial fill of the 0.10 submitted size.
  const postAck: AccountState = {
    positions: [positionRow(0.04, 109.2)],
    algos: [slAlgo("algo-p", 0.04, "99.25")],
  };
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, ACKED, [
    { positions: [], algos: [] },
    postAck,
  ]);
  await run(handler);
  strictEqual(state.intents[0]!.sz, "0.10");
  const patch = state.patches[0]!.patch;
  strictEqual(patch.status, "active");
  // Protection converged on the partial size, but the open is NOT verified: the remainder
  // typically fills seconds later, and recording the partial as the unit would strand it
  // as external size (capped out of the unified stop and the eventual close).
  strictEqual(patch.state?.openVerified, false);
  strictEqual(patch.state?.positionSz, 0.04);
  strictEqual(patch.state?.initialUnitSz, 0.1);
  strictEqual(patch.state?.entryPx, 109.2);
  strictEqual(patch.state?.stopPx, 99.25);
  const kinds = state.events.map((event) => event.kind);
  ok(kinds.includes("open_fill_pending"));
  ok(!kinds.includes("opened"));
  ok(!state.alerts.some((alert) => alert.kind === "trend_opened"));
  ok(patch.lastNote.includes("open_fill_pending"));
});

Deno.test("pending open adopts the late remainder up to the submitted size on the next cycle", async () => {
  const state1 = newFakeState();
  const instance1 = { ...BASE_INSTANCE, runMode: "live" as const, firstSz: "0.10", themeStopCapU: 100 };
  const postAck: AccountState = {
    positions: [positionRow(0.04, 109.2)],
    algos: [slAlgo("algo-p", 0.04, "99.25")],
  };
  const handler1 = makeHandler(fakeStore([instance1], { NVDA: breakoutSeries() }, state1), state1, ACKED, [
    { positions: [], algos: [] },
    postAck,
  ]);
  await run(handler1);
  strictEqual(state1.patches[0]!.patch.state?.openVerified, false);

  // Next cycle the remainder filled: the full 0.10 is visible. The book must adopt it as
  // our own open (not cap ownership at the 0.04 partial) and verify.
  const state2 = newFakeState();
  const carried = { ...state1.patches[0]!.patch.state, lastEvalBarTs: LAST_TS - BAR_MS };
  const instance2: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    firstSz: "0.10",
    themeStopCapU: 100,
    state: carried as unknown as Record<string, unknown>,
  };
  const filled: AccountState = {
    positions: [positionRow(0.1, 109.3)],
    algos: [slAlgo("algo-p", 0.1, "99.25")],
  };
  const handler2 = makeHandler(fakeStore([instance2], { NVDA: flatSeries() }, state2), state2, ACKED, [filled]);
  await run(handler2);
  const patch2 = state2.patches[0]!.patch;
  strictEqual(patch2.state?.openVerified, true);
  strictEqual(patch2.state?.positionSz, 0.1);
  strictEqual(patch2.state?.initialUnitSz, 0.1);
  strictEqual(patch2.state?.entryPx, 109.3);
  strictEqual(patch2.state?.lastAddAnchorPx, 109.3);
  ok(state2.events.map((event) => event.kind).includes("open_verified"));
});

Deno.test("verified open still caps an external top-up at the booked size", async () => {
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
      positionSz: 0.05,
      initialUnitSz: 0.05,
      adds: 0,
      lastAddAnchorPx: 109,
      protectiveAlgoId: "algo-1",
      openVerified: true,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  // Someone else added 0.03 on top of our verified 0.05: the book must not adopt it.
  const account: AccountState = {
    positions: [positionRow(0.08, 109.5)],
    algos: [slAlgo("algo-1", 0.05, "99.25")],
  };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [account]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.state?.positionSz, 0.05);
  strictEqual(patch.state?.openVerified, true);
  strictEqual(patch.state?.entryPx, 109);
  const kinds = state.events.map((event) => event.kind);
  ok(!kinds.includes("open_fill_pending"));
  ok(!kinds.includes("open_verified"));
});

Deno.test("pending open settles at the observed size after the fill timeout", async () => {
  const state = newFakeState();
  const instance: TrendInstanceRow = {
    ...BASE_INSTANCE,
    runMode: "live",
    status: "active",
    state: {
      entryPx: 109,
      entryBarTs: LAST_TS - PENDING_ADD_TIMEOUT_MS - 60_000,
      entryAtr: 5.5,
      peakAtr: 5.5,
      stopPx: 99.25,
      positionSz: 0.02,
      initialUnitSz: 0.05,
      adds: 0,
      lastAddAnchorPx: 109,
      protectiveAlgoId: null,
      openVerified: false,
      lastEvalBarTs: LAST_TS - BAR_MS,
    },
  };
  // The remainder never filled: settle the observed 0.02 into the book so the eventual
  // exit closes what actually filled instead of leaving it open.
  const account: AccountState = { positions: [positionRow(0.02, 109.2)], algos: [] };
  const handler = makeHandler(fakeStore([instance], { NVDA: flatSeries() }, state), state, ACKED, [account]);
  await run(handler);
  const patch = state.patches[0]!.patch;
  strictEqual(patch.state?.openVerified, true);
  strictEqual(patch.state?.positionSz, 0.02);
  strictEqual(patch.state?.initialUnitSz, 0.02);
  ok(patch.lastNote.includes("open_fill_timeout"));
  ok(
    state.alerts.some(
      (alert) => alert.kind === "trend_open_failed" && (alert.payload as { outcome: string }).outcome === "open_fill_timeout",
    ),
  );
});
