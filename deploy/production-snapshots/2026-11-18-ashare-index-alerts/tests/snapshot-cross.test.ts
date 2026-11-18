import { describe, expect, it } from "vitest";
import { parseRuleParams } from "../alert-evaluator/core/alerts.ts";
import { evaluateSnapshotCross } from "../alert-evaluator/core/snapshot-cross.ts";

describe("snapshot_cross kind wiring", () => {
  it("parses a one-shot below rule through the production evaluator schema", () => {
    const params = parseRuleParams("snapshot_cross", {
      level: 3720,
      direction: "below",
      once: true,
      maxQuoteAgeSeconds: 480,
    });
    expect(params).toEqual({
      kind: "snapshot_cross",
      level: 3720,
      direction: "below",
      once: true,
      maxQuoteAgeSeconds: 480,
    });
  });

  it("requires an armed quote above the level before a later snapshot at or below it can fire", () => {
    const params = parseRuleParams("snapshot_cross", { level: 3720, direction: "below", once: true });
    if (params.kind !== "snapshot_cross") throw new Error("expected snapshot_cross");
    expect(evaluateSnapshotCross(params, null, { price: 3710, ts: 1 })).toBe(false);
    expect(evaluateSnapshotCross(params, { price: 3769, ts: 1 }, { price: 3719.5, ts: 2 })).toBe(true);
  });
});
