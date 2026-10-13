import { describe, expect, it } from "vitest";
import { groupNewsByEvent, safeHttpUrl, type NewsEventRow, type NewsItemRow } from "./mapper";

const events: NewsEventRow[] = [
  { id: "e1", title: "  美联储讲话  ", first_published_at: "2026-10-13T10:00:00Z" },
  { id: "e2", title: null, first_published_at: "2026-10-13T08:00:00Z" },
];

const items: NewsItemRow[] = [
  { id: 11, event_id: "e1", source: "reuters", title: "Fed speaks", url: "https://example.com/a", published_at: "2026-10-13T10:01:00Z", credibility: "0.9" },
  { id: 12, event_id: "e1", source: "wsj", title: "  ", url: "https://example.com/b", published_at: "2026-10-13T10:05:00Z", credibility: null },
  { id: 13, event_id: "e2", source: "x", title: "Oil rallies", url: "javascript:alert(1)", published_at: null, credibility: 0.5 },
  { id: 14, event_id: null, source: "y", title: "Unclustered", url: "https://example.com/c", published_at: "2026-10-13T11:00:00Z", credibility: 0.1 },
  { id: 15, event_id: "gone", source: "z", title: "Orphan", url: "https://example.com/d", published_at: "2026-10-13T11:00:00Z", credibility: 0.1 },
];

describe("groupNewsByEvent", () => {
  const grouped = groupNewsByEvent(events, items);

  it("keeps the event order given by the query", () => {
    expect(grouped.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("sorts items inside an event newest first and attaches only their own event's items", () => {
    expect(grouped[0]?.items.map((i) => i.id)).toEqual(["12", "11"]);
    expect(grouped[1]?.items.map((i) => i.id)).toEqual(["13"]);
  });

  it("trims titles and falls back to the first item's title, then to a placeholder", () => {
    expect(grouped[0]?.title).toBe("美联储讲话");
    expect(grouped[1]?.title).toBe("Oil rallies");
    const bare = groupNewsByEvent([{ id: "e3", title: null, first_published_at: "2026-10-13T00:00:00Z" }], []);
    expect(bare[0]?.title).toBe("未命名事件");
    expect(bare[0]?.items).toEqual([]);
  });

  it("falls back to the URL when an item has no usable title", () => {
    expect(grouped[0]?.items[0]?.title).toBe("https://example.com/b");
  });

  it("converts credibility strings to numbers and keeps nulls", () => {
    expect(grouped[0]?.items.find((i) => i.id === "11")?.credibility).toBe(0.9);
    expect(grouped[0]?.items.find((i) => i.id === "12")?.credibility).toBeNull();
  });

  it("never exposes a non-http URL as a link", () => {
    expect(grouped[1]?.items[0]?.url).toBeNull();
  });
});

describe("safeHttpUrl", () => {
  it.each([
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["http://example.com", "http://example.com/"],
  ])("accepts %s", (input, expected) => {
    expect(safeHttpUrl(input)).toBe(expected);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "/relative/path", "ftp://x.test/a", "", null, undefined])(
    "rejects %s",
    (input) => {
      expect(safeHttpUrl(input)).toBeNull();
    },
  );
});
