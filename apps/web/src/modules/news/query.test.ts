import { describe, expect, it, vi } from "vitest";

// news/query.ts is a server module (imports "server-only" and the supabase
// client); digestNewsFeed itself is pure, so stub the server-only guard.
vi.mock("server-only", () => ({}));

import { digestNewsFeed } from "./query";

describe("digestNewsFeed", () => {
  it("is stable for unchanged input", () => {
    const events = [{ id: 7 }, { id: 6 }];
    const items = [{ id: 3 }, { id: 2 }, { id: 1 }];
    expect(digestNewsFeed(events, items)).toBe(digestNewsFeed([...events], [...items]));
  });

  it("moves when a new source lands on the newest event", () => {
    const events = [{ id: 7 }];
    const before = digestNewsFeed(events, [{ id: 3 }]);
    expect(digestNewsFeed(events, [{ id: 4 }, { id: 3 }])).not.toBe(before);
  });

  it("moves when a mid-feed item is swapped under the item cap", () => {
    // Regression: with the feed at NEWS_ITEM_LIMIT, attaching a source whose
    // publication time is not the newest displaces the oldest row of the
    // limited result while the newest id and the counts stay put. A digest of
    // only the first id + count would stay identical and the news page would
    // never offer a refresh.
    const events = [{ id: 7 }];
    const items = Array.from({ length: 500 }, (_, index) => ({ id: 500 - index }));
    const before = digestNewsFeed(events, items);
    const after = digestNewsFeed(events, [
      ...items.slice(0, 250), // ids 500..251
      { id: 501 }, // new source with a non-newest published_at
      ...items.slice(250, 499), // ids 250..2; id 1 falls off the capped result
    ]);
    expect(after).not.toBe(before);
  });
});
