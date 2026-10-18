import { describe, expect, it } from "vitest";
import { NewsFormatError, parseBlockBeatsFlashList, parseJin10FlashList, parseJin10Time, stripMarkup, toIngestRows } from "./news.js";

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

describe("parseBlockBeatsFlashList", () => {
  const payload = {
    page: 1,
    limit: 20,
    list: [
      { id: 221820, title: "标题 <i>一</i>", content: "<p>正文一</p>", add_time: 1792315945, url: "", is_hot: 1, is_top: 0, lang: "cn" },
      { id: 221819, title: "", content: "正文二", add_time: 1792314263, url: "https://example.com/a", is_hot: 0, is_top: 1, lang: "cn" },
      { id: 221818, title: "无正文", content: "  ", add_time: 1792314263, url: "", is_hot: 0, is_top: 0, lang: "cn" },
    ],
  };

  it("maps items, strips markup, falls back to the flash URL and scores hot/top items", () => {
    const items = parseBlockBeatsFlashList(payload, NOW);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      source: "blockbeats",
      externalId: "221820",
      title: "标题 一",
      body: "正文一",
      url: "https://www.theblockbeats.info/flash/221820",
      author: null,
      publishedAt: new Date(1792315945 * 1000).toISOString(),
      important: true,
    });
    expect(items[1]?.title).toBeNull();
    expect(items[1]?.url).toBe("https://example.com/a");
    expect(items[1]?.important).toBe(true);
  });

  it("accepts a data-wrapped envelope and rejects an unknown one", () => {
    expect(parseBlockBeatsFlashList({ data: payload }, NOW)).toHaveLength(2);
    expect(() => parseBlockBeatsFlashList({ nope: true }, NOW)).toThrow(NewsFormatError);
    expect(() => parseBlockBeatsFlashList({ code: 40101, msg: "Invalid App Key" }, NOW)).toThrow(NewsFormatError);
  });

  it("falls back to now when add_time is unusable", () => {
    const items = parseBlockBeatsFlashList({ list: [{ id: 1, content: "正文", add_time: 0 }] }, NOW);
    expect(items[0]?.publishedAt).toBe(new Date(NOW).toISOString());
  });
});
