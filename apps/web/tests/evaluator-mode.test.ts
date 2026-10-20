import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluatorAccountMode } from "../src/modules/evaluator-mode";

vi.mock("@/lib/supabase", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "@/lib/supabase";

const mockedGetDb = vi.mocked(getDb);

function mockOrders(mode: string | null) {
  mockedGetDb.mockReturnValue({
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => ({
            maybeSingle: () =>
              Promise.resolve(
                mode === null ? { data: null, error: null } : { data: { mode }, error: null },
              ),
          }),
        }),
      }),
    }),
  } as never);
}

afterEach(() => {
  vi.resetAllMocks();
  delete process.env.HIVE_EVALUATOR_MODE;
});

describe("evaluatorAccountMode", () => {
  it("prefers the explicit HIVE_EVALUATOR_MODE env", async () => {
    process.env.HIVE_EVALUATOR_MODE = "demo";
    mockOrders("live");
    expect(await evaluatorAccountMode()).toBe("demo");
    expect(mockedGetDb).not.toHaveBeenCalled();
  });

  it("falls back to the mode order-submit last wrote", async () => {
    mockOrders("live");
    expect(await evaluatorAccountMode()).toBe("live");
    mockOrders("demo");
    expect(await evaluatorAccountMode()).toBe("demo");
  });

  it("returns null when nothing is configured and no orders exist", async () => {
    mockOrders(null);
    expect(await evaluatorAccountMode()).toBeNull();
  });

  it("returns null when the database is unreachable instead of guessing", async () => {
    mockedGetDb.mockImplementation(() => {
      throw new Error("nope");
    });
    expect(await evaluatorAccountMode()).toBeNull();
  });
});
