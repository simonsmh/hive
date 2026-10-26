import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { PANELS } from "@/src/modules/registry";

describe("web app manifest", () => {
  const data = manifest();

  it("is named Hive with Chinese metadata and a theme color", () => {
    expect(data.name).toBe("Hive");
    expect(data.short_name).toBe("Hive");
    expect(data.lang).toBe("zh-CN");
    expect(data.description).toMatch(/看板/);
    expect(data.theme_color).toBe("#d97706");
    expect(data.display).toBe("standalone");
    expect(data.start_url).toBe("/");
  });

  it("ships 192 and 512 icons plus separate maskable icons", () => {
    const icons = data.icons ?? [];
    const sizes = (purpose: string) => icons.filter((i) => i.purpose === purpose).map((i) => i.sizes).sort();
    expect(sizes("any")).toEqual(["192x192", "512x512"]);
    expect(sizes("maskable")).toEqual(["192x192", "512x512"]);
    for (const icon of icons) {
      expect(icon.src).toMatch(/^\/icons\/.+\.png$/);
    }
  });

  it("exposes one Chinese shortcut per dashboard panel", () => {
    expect(data.shortcuts?.map((s) => s.name)).toEqual(PANELS.slice().sort((a, b) => a.order - b.order).map((p) => p.title));
    expect(data.shortcuts?.map((s) => s.url)).toEqual(["/health", "/quotes", "/market", "/news", "/alerts", "/symbols", "/orders", "/trend", "/settings"]);
  });
});
