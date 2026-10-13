import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "@/lib/api";
import { loadPanelData } from "./panel-data";

describe("loadPanelData", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the loaded data on success", async () => {
    await expect(loadPanelData("ok", async () => [1, 2])).resolves.toEqual({ ok: true, data: [1, 2] });
  });

  it("maps configuration errors to an actionable message", async () => {
    const result = await loadPanelData("cfg", async () => {
      throw new ConfigError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    });
    expect(result).toEqual({ ok: false, message: "服务端配置缺失，请检查环境变量" });
  });

  it("hides database internals behind a generic message but logs the original error", async () => {
    const failure = new Error("password authentication failed for user postgres");
    const result = await loadPanelData("db", async () => {
      throw failure;
    });
    expect(result).toEqual({ ok: false, message: "数据暂时无法加载，请稍后重试" });
    expect(JSON.stringify(result)).not.toContain("postgres");
    expect(console.error).toHaveBeenCalledWith("[dashboard] db failed", failure);
  });
});
