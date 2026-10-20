import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PANELS, getDefaultHref, getNavItems, requirePanel, validateRegistry, type PanelRegistration } from "./registry";

const panelPage = (id: string) => fileURLToPath(new URL(`../../app/(dashboard)/${id}/page.tsx`, import.meta.url));

describe("PANELS registry", () => {
  it("is well-formed", () => {
    expect(validateRegistry(PANELS)).toEqual([]);
  });

  it("has a page file for every entry at app/(dashboard)/<id>/page.tsx", () => {
    for (const panel of PANELS) {
      expect(existsSync(panelPage(panel.id)), panel.id).toBe(true);
    }
  });

  it("uses the Chinese panel titles from the spec", () => {
    expect(PANELS.map((p) => p.title)).toEqual(["数据源健康", "行情", "新闻", "告警", "标的管理", "条件单", "趋势策略", "设置"]);
  });
});

describe("getNavItems", () => {
  it("orders entries by their order field regardless of declaration order", () => {
    const shuffled: PanelRegistration[] = [
      { id: "b", title: "B", icon: "chart", href: "/b", order: 20 },
      { id: "a", title: "A", icon: "pulse", href: "/a", order: 10 },
      { id: "c", title: "C", icon: "news", href: "/c", order: 30 },
    ];
    expect(getNavItems(shuffled).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the registry it was given", () => {
    const input = [...PANELS].reverse();
    const before = input.map((p) => p.id);
    getNavItems(input);
    expect(input.map((p) => p.id)).toEqual(before);
  });
});

describe("requirePanel", () => {
  it("returns the registration for a known id and throws for an unknown one", () => {
    expect(requirePanel("quotes").href).toBe("/quotes");
    expect(() => requirePanel("missing")).toThrow(/unknown dashboard panel "missing"/);
  });
});

describe("getDefaultHref", () => {
  it("points at the first nav entry, and falls back to /login for an empty registry", () => {
    expect(getDefaultHref()).toBe("/health");
    expect(getDefaultHref([])).toBe("/login");
  });
});

describe("validateRegistry", () => {
  const valid: PanelRegistration = { id: "news", title: "新闻", icon: "news", href: "/news", order: 1 };

  it("reports duplicate ids, hrefs and orders", () => {
    const errors = validateRegistry([valid, { ...valid, href: "/news-2", order: 1 }]);
    expect(errors.join("\n")).toMatch(/duplicate id/);
    expect(errors.join("\n")).toMatch(/duplicate order 1/);
  });

  it("requires the href to mirror the page directory", () => {
    expect(validateRegistry([{ ...valid, href: "/other" }]).join("\n")).toMatch(/href must be "\/news"/);
  });

  it("rejects malformed ids, empty titles, unknown icons and non-integer orders", () => {
    const errors = validateRegistry([
      { ...valid, id: "Bad Id", href: "/Bad Id" },
      { ...valid, id: "x2", href: "/x2", title: "  " },
      { ...valid, id: "x3", href: "/x3", icon: "rocket" as PanelRegistration["icon"] },
      { ...valid, id: "x4", href: "/x4", order: 1.5 },
    ]).join("\n");
    expect(errors).toMatch(/lowercase letters/);
    expect(errors).toMatch(/title is empty/);
    expect(errors).toMatch(/unknown icon "rocket"/);
    expect(errors).toMatch(/order must be an integer/);
  });
});
