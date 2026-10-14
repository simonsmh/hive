import { describe, expect, it } from "vitest";
import { NewsFormatError, toIngestRows } from "./news.js";
import { parseOkxNewsPage } from "./okx-news.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const CTIME = String(Date.parse("2026-10-13T11:59:00.000Z"));

const page = (details: unknown[]) => ({ details, nextCursor: "" });

describe("parseOkxNewsPage", () => {
  it("maps a high-importance entry to a normalised okx-news item", () => {
    const result = parseOkxNewsPage(
      page([
        {
          id: 884512,
          cTime: CTIME,
          title: "<b>美联储</b>维持利率不变",
          summary: "摘要",
          content: "<p>完整内容</p><br/>第二段",
          importance: "high",
          sourceUrl: "https://www.okx.com/zh-hans/feed/post/884512",
          platformList: ["spot"],
          ccyList: ["BTC"],
          duplicateAuthors: ["Reuters", "Reuters", { name: "Bloomberg" }],
        },
      ]),
      NOW,
    );
    expect(result.rawCount).toBe(1);
    expect(result.oldestMs).toBe(Date.parse("2026-10-13T11:59:00.000Z"));
    expect(result.items).toEqual([
      {
        source: "okx-news",
        externalId: "884512",
        title: "美联储维持利率不变",
        body: "完整内容\n第二段",
        url: "https://www.okx.com/zh-hans/feed/post/884512",
        author: "Reuters, Bloomberg",
        publishedAt: "2026-10-13T11:59:00.000Z",
        important: true,
      },
    ]);
  });

  it("falls back to the summary when content is empty, and to the post URL when sourceUrl is unusable", () => {
    const [item] = parseOkxNewsPage(
      page([{ id: "7", cTime: CTIME, title: "", content: "", summary: "只有摘要", importance: "high", sourceUrl: "javascript:alert(1)" }]),
      NOW,
    ).items;
    expect(item?.body).toBe("只有摘要");
    expect(item?.title).toBeNull();
    expect(item?.url).toBe("https://www.okx.com/zh-hans/feed/post/7");
    expect(item?.author).toBeNull();
  });

  it("skips entries that are not high importance, have no id, or have no text", () => {
    const { items, rawCount } = parseOkxNewsPage(
      page([
        { id: "1", cTime: CTIME, content: "低优先级", importance: "low" },
        { id: "", cTime: CTIME, content: "无 id" },
        { id: "3", cTime: CTIME, content: "", summary: "" },
        { id: "4", cTime: CTIME, content: "保留", importance: "HIGH" },
        { id: "5", cTime: CTIME, content: "没有 importance 字段也保留" },
      ]),
      NOW,
    );
    expect(rawCount).toBe(5);
    expect(items.map((item) => item.externalId)).toEqual(["4", "5"]);
  });

  it("counts skipped entries toward rawCount and oldestMs so pagination sees the real page", () => {
    const result = parseOkxNewsPage(
      page([
        { id: "1", cTime: String(NOW - 1_000), content: "保留", importance: "high" },
        { id: "2", cTime: String(NOW - 9_000), content: "低", importance: "low" },
      ]),
      NOW,
    );
    expect(result.rawCount).toBe(2);
    expect(result.oldestMs).toBe(NOW - 9_000);
  });

  it("uses receipt time when cTime is missing or implausible", () => {
    const [a, b] = parseOkxNewsPage(
      page([
        { id: "8", content: "无时间", importance: "high" },
        { id: "9", cTime: "1760", content: "秒级或错误", importance: "high" },
      ]),
      NOW,
    ).items;
    expect(a?.publishedAt).toBe(new Date(NOW).toISOString());
    expect(b?.publishedAt).toBe(new Date(NOW).toISOString());
  });

  it("accepts a numeric cTime and an empty page", () => {
    expect(parseOkxNewsPage(page([{ id: "1", cTime: Date.parse("2026-10-13T11:00:00.000Z"), content: "x", importance: "high" }]), NOW).oldestMs).toBe(
      Date.parse("2026-10-13T11:00:00.000Z"),
    );
    expect(parseOkxNewsPage(page([]), NOW)).toEqual({ items: [], rawCount: 0, oldestMs: null });
  });

  it("truncates overlong titles, bodies and authors", () => {
    const [item] = parseOkxNewsPage(
      page([{ id: "1", cTime: CTIME, title: "t".repeat(400), content: "c".repeat(5000), importance: "high", duplicateAuthors: "a".repeat(200) }]),
      NOW,
    ).items;
    expect(item?.title).toHaveLength(300);
    expect(item?.body).toHaveLength(4000);
    expect(item?.author).toHaveLength(120);
  });

  it("throws NewsFormatError when the envelope has no news array, is not an object, or reports a non-zero code", () => {
    expect(() => parseOkxNewsPage({ items: [] })).toThrow(NewsFormatError);
    expect(() => parseOkxNewsPage({ code: "0", msg: "", data: { totalPage: "1" } })).toThrow(NewsFormatError);
    expect(() => parseOkxNewsPage("<html>blocked</html>")).toThrow(NewsFormatError);
    expect(() => parseOkxNewsPage({ code: "51000", msg: "param error", details: [] })).toThrow(/code 51000/);
  });

  it("accepts a zero code and throws when a non-empty page has nothing usable", () => {
    expect(parseOkxNewsPage({ code: "0", details: [] }, NOW).items).toEqual([]);
    expect(() => parseOkxNewsPage(page([{ foo: 1 }, { id: "", content: "x" }]), NOW)).toThrow(NewsFormatError);
  });

  it("produces rows that the ingest RPC stores with score 1", () => {
    const rows = toIngestRows(parseOkxNewsPage(page([{ id: 42, cTime: CTIME, content: "快讯", importance: "high" }]), NOW).items);
    expect(rows).toEqual([
      {
        external_id: "42",
        title: null,
        body: "快讯",
        url: "https://www.okx.com/zh-hans/feed/post/42",
        author: null,
        published_at: "2026-10-13T11:59:00.000Z",
        score: 1,
      },
    ]);
  });
});

describe("parseOkxNewsPage envelope shapes", () => {
  const entry = (id: string, content = `内容 ${id}`) => ({ id, cTime: CTIME, content, importance: "high" });
  const v5 = (data: unknown) => ({ code: "0", msg: "", data });

  it("reads the news array from top-level details, the legacy shape", () => {
    const result = parseOkxNewsPage({ details: [entry("1"), entry("2")], nextCursor: "" }, NOW);
    expect(result.items.map((item) => item.externalId)).toEqual(["1", "2"]);
    expect(result.rawCount).toBe(2);
  });

  it("reads an OKX v5 envelope whose data is the array of items", () => {
    const result = parseOkxNewsPage({ code: "0", msg: "", data: [entry("1"), entry("2"), entry("3")] }, NOW);
    expect(result.items.map((item) => item.externalId)).toEqual(["1", "2", "3"]);
    expect(result.rawCount).toBe(3);
    expect(result.oldestMs).toBe(Date.parse("2026-10-13T11:59:00.000Z"));
  });

  it("accepts an empty data array as an empty page", () => {
    expect(parseOkxNewsPage({ code: "0", msg: "", data: [] }, NOW)).toEqual({ items: [], rawCount: 0, oldestMs: null });
  });

  it("reads the items from data[].details when data is a list of pages", () => {
    const result = parseOkxNewsPage(v5([{ details: [entry("1"), entry("2")], nextCursor: "" }]), NOW);
    expect(result.items.map((item) => item.externalId)).toEqual(["1", "2"]);
    expect(result.rawCount).toBe(2);
  });

  it.each(["details", "list", "newsList", "articles"])("reads the items from data.%s", (key) => {
    const result = parseOkxNewsPage(v5({ totalPage: "1", [key]: [entry("9")] }), NOW);
    expect(result.items.map((item) => item.externalId)).toEqual(["9"]);
    expect(result.rawCount).toBe(1);
  });

  it("prefers top-level details over data when both are arrays", () => {
    const result = parseOkxNewsPage({ code: "0", details: [entry("top")], data: [entry("data")] }, NOW);
    expect(result.items.map((item) => item.externalId)).toEqual(["top"]);
  });

  it("prefers data.details over data.list when both are present", () => {
    const result = parseOkxNewsPage(v5({ details: [entry("d")], list: [entry("l")] }), NOW);
    expect(result.items.map((item) => item.externalId)).toEqual(["d"]);
  });

  it("returns the OKX msg with a non-zero code, so the degraded reason says why", () => {
    expect(() => parseOkxNewsPage({ code: "50111", msg: "Invalid OK-ACCESS-KEY", data: [] })).toThrow(
      "okx-news returned code 50111: Invalid OK-ACCESS-KEY",
    );
    expect(() => parseOkxNewsPage({ code: 50103, msg: "" })).toThrow("okx-news returned code 50103");
  });

  it("names the envelope keys but no values when the array path is unknown", () => {
    const secretLike = "SECRET-NEWS-BODY-TEXT";
    let message = "";
    try {
      parseOkxNewsPage({ code: "0", msg: "", data: { totalPage: "2", ts: "1760000000000", summary: secretLike } });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("okx-news response has no news array");
    expect(message).toContain("top-level keys: code,msg,data");
    expect(message).toContain("totalPage,ts,summary");
    expect(message).not.toContain(secretLike);
    expect(message).not.toContain("1760000000000");
  });

  it("names the first item's keys when a data array holds no usable news", () => {
    expect(() => parseOkxNewsPage({ code: "0", data: [{ ts: "1", cursor: "x" }] })).toThrow(
      "okx-news response contained no usable news items (first item keys: ts,cursor)",
    );
  });

  it("throws when a list-shaped page holds only unusable entries", () => {
    expect(() => parseOkxNewsPage(v5([{ details: [{ id: "", content: "x" }] }]), NOW)).toThrow(NewsFormatError);
  });

  it("accepts the alias field names that OKX variants are known to use", () => {
    const [item] = parseOkxNewsPage(
      v5([
        {
          newsId: 77,
          createTime: String(Date.parse("2026-10-13T11:58:00.000Z")),
          summary: "摘要",
          importance: "high",
          url: "https://www.okx.com/zh-hans/feed/post/77",
          authors: ["Reuters"],
        },
      ]),
      NOW,
    ).items;
    expect(item).toEqual({
      source: "okx-news",
      externalId: "77",
      title: null,
      body: "摘要",
      url: "https://www.okx.com/zh-hans/feed/post/77",
      author: "Reuters",
      publishedAt: "2026-10-13T11:58:00.000Z",
      important: true,
    });
  });
});
