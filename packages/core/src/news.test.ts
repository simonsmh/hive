import { describe, expect, it } from "vitest";
import { NewsFormatError, parseJin10FlashList, parseJin10Time, stripMarkup, toIngestRows } from "./news.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");

describe("parseJin10Time", () => {
  it("reads Beijing wall-clock times as UTC+8", () => {
    expect(parseJin10Time("2026-10-13 17:40:05")).toBe("2026-10-13T09:40:05.000Z");
    expect(parseJin10Time("2026-10-13 17:40")).toBe("2026-10-13T09:40:00.000Z");
  });

  it("accepts ISO-8601 with an explicit zone and rejects garbage", () => {
    expect(parseJin10Time("2026-10-13T09:40:05Z")).toBe("2026-10-13T09:40:05.000Z");
    expect(parseJin10Time("not a time")).toBeNull();
    expect(parseJin10Time(undefined)).toBeNull();
    expect(parseJin10Time("")).toBeNull();
  });
});

describe("stripMarkup", () => {
  it("removes tags, decodes common entities and collapses whitespace", () => {
    expect(stripMarkup("<b>美联储</b>&nbsp;&amp;&nbsp;利率<br/>维持不变")).toBe("美联储 & 利率\n维持不变");
  });
});

describe("parseJin10FlashList", () => {
  const envelope = (data: unknown[]) => ({ status: 200, data });

  it("maps a well-formed flash list to normalised items", () => {
    const items = parseJin10FlashList(
      envelope([
        {
          id: 20261013001,
          time: "2026-10-13 17:40:00",
          important: 1,
          data: { content: "<b>央行</b>宣布降息", title: "", source: "金十数据", link: "https://example.com/a" },
        },
      ]),
      NOW,
    );
    expect(items).toEqual([
      {
        source: "jin10",
        externalId: "20261013001",
        title: null,
        body: "央行宣布降息",
        url: "https://example.com/a",
        author: "金十数据",
        publishedAt: "2026-10-13T09:40:00.000Z",
        important: true,
      },
    ]);
  });

  it("falls back to the flash detail URL for missing or non-http links", () => {
    const [a, b] = parseJin10FlashList(
      envelope([
        { id: "7", time: "2026-10-13 17:00:00", data: { content: "x" } },
        { id: "8", time: "2026-10-13 17:01:00", data: { content: "y", link: "javascript:alert(1)" } },
      ]),
      NOW,
    )!;
    expect(a?.url).toBe("https://flash.jin10.com/detail/7");
    expect(b?.url).toBe("https://flash.jin10.com/detail/8");
    expect(a?.important).toBe(false);
  });

  it("skips items without an id or content, and falls back to receipt time when the timestamp is unusable", () => {
    const items = parseJin10FlashList(
      envelope([
        { id: "", data: { content: "no id" } },
        { id: "9", data: {} },
        { id: "10", time: "garbage", data: { content: "kept" } },
      ]),
      NOW,
    );
    expect(items.map((i) => i.externalId)).toEqual(["10"]);
    expect(items[0]?.publishedAt).toBe(new Date(NOW).toISOString());
  });

  it("accepts a bare array payload", () => {
    expect(parseJin10FlashList([{ id: 1, data: { content: "a" } }], NOW)).toHaveLength(1);
  });

  it("returns an empty list for an empty feed", () => {
    expect(parseJin10FlashList(envelope([]), NOW)).toEqual([]);
  });

  it("throws NewsFormatError when the envelope is unrecognised", () => {
    expect(() => parseJin10FlashList({ hello: "world" })).toThrow(NewsFormatError);
    expect(() => parseJin10FlashList("<html>blocked</html>")).toThrow(NewsFormatError);
  });

  it("throws when the envelope reports a non-200 status", () => {
    expect(() => parseJin10FlashList({ status: 403, data: [] })).toThrow(/status 403/);
  });

  it("throws when a non-empty list has no usable items, which signals a format change", () => {
    expect(() => parseJin10FlashList(envelope([{ foo: 1 }, { id: "", data: {} }]))).toThrow(NewsFormatError);
  });

  it("truncates overlong titles and bodies", () => {
    const [item] = parseJin10FlashList(envelope([{ id: "1", data: { title: "t".repeat(400), content: "c".repeat(5000) } }]), NOW)!;
    expect(item?.title).toHaveLength(300);
    expect(item?.body).toHaveLength(4000);
  });
});

describe("toIngestRows", () => {
  it("emits snake_case rows with the important flag as a numeric score", () => {
    const rows = toIngestRows([
      {
        source: "jin10",
        externalId: "1",
        title: null,
        body: "b",
        url: "https://flash.jin10.com/detail/1",
        author: null,
        publishedAt: "2026-10-13T09:40:00.000Z",
        important: true,
      },
    ]);
    expect(rows).toEqual([
      {
        external_id: "1",
        title: null,
        body: "b",
        url: "https://flash.jin10.com/detail/1",
        author: null,
        published_at: "2026-10-13T09:40:00.000Z",
        score: 1,
      },
    ]);
  });
});
