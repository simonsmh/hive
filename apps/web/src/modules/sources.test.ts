import { describe, expect, it } from "vitest";
import { sourceLabel } from "./sources";

describe("sourceLabel", () => {
  it("uses the Chinese display name for known sources", () => {
    expect(sourceLabel("okx")).toBe("OKX 行情");
    expect(sourceLabel("jin10")).toBe("Jin10 快讯");
    expect(sourceLabel("okx-news")).toBe("OKX 快讯");
  });

  it("falls back to the upper-cased key for unknown sources", () => {
    expect(sourceLabel("reuters")).toBe("REUTERS");
  });
});
