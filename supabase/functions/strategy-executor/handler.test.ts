import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  buildIntent,
  createStrategyExecutorHandler,
  executionIdempotencyKey,
  type ExecutionBinding,
  type ExecutorStore,
  type OrderSubmitter,
  type RunStatus,
  type SubmitOutcome,
  type TriggerAlert,
} from "./handler.ts";

const CRON_SECRET = "cron-secret";
const NOW_MS = Date.parse("2026-11-03T00:00:00.000Z");

function binding(overrides: Partial<ExecutionBinding> = {}): ExecutionBinding {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "test-close",
    ruleId: "22222222-2222-4222-8222-222222222222",
    action: "close",
    instId: "SOXL-USDT-SWAP",
    side: "sell",
    posSide: "long",
    tdMode: "isolated",
    lever: null,
    sz: "0.03",
    ordType: "market",
    px: null,
    reduceOnly: true,
    slTriggerPx: null,
    slOrdPx: null,
    tpTriggerPx: null,
    tpOrdPx: null,
    theme: null,
    themeStopCapU: null,
    maxLossU: null,
    marginAmt: null,
    reason: null,
    cooldownSeconds: 3600,
    notifySubscriptionId: null,
    lastExecutedAtMs: null,
    createdAtMs: NOW_MS - 86_400_000,
    ...overrides,
  };
}

function alert(overrides: Partial<TriggerAlert> = {}): TriggerAlert {
  return {
    id: 9001,
    ruleId: "22222222-2222-4222-8222-222222222222",
    symbol: "SOXL",
    kind: "volume_spike",
    triggeredAtMs: NOW_MS - 60_000,
    ...overrides,
  };
}

interface FakeState {
  killed: boolean;
  bindings: ExecutionBinding[];
  alerts: TriggerAlert[];
  runs: Map<string, RunStatus>;
  runIds: Map<string, string>;
  submitted: Record<string, unknown>[];
  receipts: { subscriptionId: string; eventKey: string }[];
  executedMarks: string[];
}

function fakeStore(state: FakeState): ExecutorStore {
  return {
    async killSwitchEngaged() {
      return state.killed;
    },
    async listEnabledBindings() {
      return state.bindings;
    },
    async unprocessedAlerts() {
      return state.alerts;
    },
    async runAlertIds(bindingId: string) {
      const ids: number[] = [];
      for (const key of state.runs.keys()) {
        const [b, a] = key.split(":");
        if (b === bindingId) ids.push(Number(a));
      }
      return ids;
    },
    async insertRun(bindingId: string, alertId: number, _key: string, status: RunStatus) {
      const key = `${bindingId}:${alertId}`;
      if (state.runs.has(key)) return { inserted: false, runId: null };
      state.runs.set(key, status);
      const runId = `run-${bindingId.slice(0, 8)}-${alertId}`;
      state.runIds.set(runId, key);
      return { inserted: true, runId };
    },
    async finishRun(runId: string, status: RunStatus) {
      const key = state.runIds.get(runId);
      if (key !== undefined) state.runs.set(key, status);
    },
    async markBindingExecuted(bindingId: string) {
      state.executedMarks.push(bindingId);
    },
    async queueReceipt(subscriptionId: string, eventKey: string) {
      state.receipts.push({ subscriptionId, eventKey });
    },
  };
}

function submitter(outcome: SubmitOutcome): OrderSubmitter {
  return {
    async submit(intent: Record<string, unknown>) {
      submittedIntents.push(intent);
      return outcome;
    },
  };
}

let submittedIntents: Record<string, unknown>[] = [];

async function runHandler(state: FakeState, sub: OrderSubmitter, mode: "demo" | "live" = "demo", liveEnabled = true) {
  submittedIntents = [];
  const handler = createStrategyExecutorHandler({
    cronSecret: CRON_SECRET,
    mode,
    liveEnabled,
    store: fakeStore(state),
    submitter: sub,
    now: () => NOW_MS,
    log: () => {},
  });
  const response = await handler(
    new Request("https://executor.local/", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const ACKED: SubmitOutcome = { httpStatus: 200, status: "acked", reason: null, ordId: "123", algoId: null, detail: null };

Deno.test("executor submits one intent per fresh alert and records ack", async () => {
  const state: FakeState = {
    killed: false,
    bindings: [binding({ notifySubscriptionId: "sub-1" })],
    alerts: [alert()],
    runs: new Map(), runIds: new Map(),
    submitted: [],
    receipts: [],
    executedMarks: [],
  };
  const { status, body } = await runHandler(state, submitter(ACKED));
  strictEqual(status, 200);
  strictEqual(body["executed"], 1);
  strictEqual(body["acked"], 1);
  strictEqual(submittedIntents.length, 1);
  strictEqual(submittedIntents[0]["action"], "close");
  strictEqual(submittedIntents[0]["instId"], "SOXL-USDT-SWAP");
  strictEqual(submittedIntents[0]["sz"], "0.03");
  strictEqual(submittedIntents[0]["source"], "hive:strategy-executor");
  strictEqual(state.receipts.length, 1);
  strictEqual(state.receipts[0].eventKey.startsWith("exec:"), true);
  strictEqual(state.executedMarks.length, 1);
});

Deno.test("executor skips stale alerts without submitting", async () => {
  const state: FakeState = {
    killed: false,
    bindings: [binding()],
    alerts: [alert({ triggeredAtMs: NOW_MS - 16 * 60_000 })],
    runs: new Map(), runIds: new Map(),
    submitted: [],
    receipts: [],
    executedMarks: [],
  };
  const { body } = await runHandler(state, submitter(ACKED));
  strictEqual(body["skippedStale"], 1);
  strictEqual(body["executed"], 0);
  strictEqual(submittedIntents.length, 0);
  strictEqual(state.executedMarks.length, 0);
});

Deno.test("executor skips alerts inside the binding cooldown", async () => {
  const state: FakeState = {
    killed: false,
    bindings: [binding({ lastExecutedAtMs: NOW_MS - 600_000 })],
    alerts: [alert()],
    runs: new Map(), runIds: new Map(),
    submitted: [],
    receipts: [],
    executedMarks: [],
  };
  const { body } = await runHandler(state, submitter(ACKED));
  strictEqual(body["skippedCooldown"], 1);
  strictEqual(submittedIntents.length, 0);
});

Deno.test("executor pauses on kill switch without consuming alerts", async () => {
  const state: FakeState = {
    killed: true,
    bindings: [binding()],
    alerts: [alert()],
    runs: new Map(), runIds: new Map(),
    submitted: [],
    receipts: [],
    executedMarks: [],
  };
  const { body } = await runHandler(state, submitter(ACKED));
  strictEqual(body["status"], "killed");
  strictEqual(body["candidates"], 0);
  strictEqual(submittedIntents.length, 0);
  strictEqual(state.runs.size, 0);
});

Deno.test("executor does not resubmit an alert that already has a run", async () => {
  const state: FakeState = {
    killed: false,
    bindings: [binding()],
    alerts: [alert()],
    runs: new Map([["11111111-1111-4111-8111-111111111111:9001", "acked"]]), runIds: new Map(),
    submitted: [],
    receipts: [],
    executedMarks: [],
  };
  const { body } = await runHandler(state, submitter(ACKED));
  strictEqual(body["executed"], 0);
  strictEqual(submittedIntents.length, 0);
});

Deno.test("executor skips live execution when live is not enabled", async () => {
  const state: FakeState = {
    killed: false,
    bindings: [binding()],
    alerts: [alert()],
    runs: new Map(), runIds: new Map(),
    submitted: [],
    receipts: [],
    executedMarks: [],
  };
  const { body } = await runHandler(state, submitter(ACKED), "live", false);
  strictEqual(body["skippedLiveDisabled"], 1);
  strictEqual(submittedIntents.length, 0);
});

Deno.test("executor maps a risk rejection to rejected, not failed", async () => {
  const state: FakeState = {
    killed: false,
    bindings: [binding()],
    alerts: [alert()],
    runs: new Map(), runIds: new Map(),
    submitted: [],
    receipts: [],
    executedMarks: [],
  };
  const { body } = await runHandler(
    state,
    submitter({ httpStatus: 423, status: "rejected_risk", reason: "kill_switch_engaged", ordId: null, algoId: null, detail: null }),
  );
  strictEqual(body["rejected"], 1);
  strictEqual(body["failed"], 0);
});

Deno.test("idempotency key and intent id are deterministic per binding and alert", () => {
  strictEqual(executionIdempotencyKey("b1", 42), "exec:b1:42");
  const intent = buildIntent(binding(), "run-abc", "exec:b1:42", NOW_MS);
  strictEqual(intent["schema"], "okx.intent.v1");
  strictEqual(intent["intentId"], "exec-run-abc");
  strictEqual(intent["idempotencyKey"], "exec:b1:42");
  strictEqual(intent["ttlSec"], 120);
  deepStrictEqual(Object.keys(intent).sort(), [
    "action", "createdAt", "idempotencyKey", "instId", "intentId", "lever", "marginAmt", "maxLossU",
    "ordType", "posSide", "px", "reason", "reduceOnly", "schema", "side", "slOrdPx", "slTriggerPx",
    "source", "sz", "tdMode", "theme", "themeStopCapU", "tpOrdPx", "tpTriggerPx", "ttlSec",
  ]);
});

Deno.test("executor rejects unauthenticated calls", async () => {
  const handler = createStrategyExecutorHandler({
    cronSecret: CRON_SECRET,
    mode: "demo",
    liveEnabled: true,
    store: fakeStore({ killed: false, bindings: [], alerts: [], runs: new Map(), runIds: new Map(), submitted: [], receipts: [], executedMarks: [] }),
    submitter: submitter(ACKED),
    now: () => NOW_MS,
    log: () => {},
  });
  const response = await handler(new Request("https://executor.local/", { method: "POST" }));
  strictEqual(response.status, 401);
  ok(true);
});
