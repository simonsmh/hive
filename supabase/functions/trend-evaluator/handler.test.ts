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
    liveEnabled: true,
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
  const handler = makeHandler(fakeStore([instance], { NVDA: breakoutSeries() }, state), state, ACKED, [account]);
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

Deno.test("kill switch skips the run and a wrong secret is rejected", async () => {
  const state = newFakeState();
  const handler = makeHandler(fakeStore([{ ...BASE_INSTANCE }], { NVDA: breakoutSeries() }, state, true), state);
  const { body } = await run(handler);
  strictEqual((body as unknown as { status: string }).status, "skipped");
  strictEqual(state.patches.length, 0);

  const denied = await handler(request("wrong-secret"));
  strictEqual(denied.status, 401);
});
