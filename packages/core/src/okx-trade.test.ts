import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OkxTradeClient, OkxTradeError } from "./okx-trade.js";

const CREDENTIALS = { apiKey: "trade-key", apiSecret: "trade-secret", passphrase: "trade-pass" };
const NOW = Date.parse("2026-10-14T06:40:30.000Z");

interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(respond: (call: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Recorded = { url, method: init?.method ?? "GET", headers, body: init?.body as string | undefined };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function client(fetchImpl: typeof fetch, demo = true) {
  return new OkxTradeClient({ credentials: CREDENTIALS, demo, fetchImpl, now: () => NOW });
}

describe("OkxTradeClient signed requests", () => {
  it("signs the exact POST body and sends the demo header", async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      json({ code: "0", msg: "", data: [{ ordId: "123", clOrdId: "abc", sCode: "0", sMsg: "" }] }),
    );
    const body = { instId: "XAU-USDT-SWAP", tdMode: "isolated", side: "sell", ordType: "market", sz: "1", reduceOnly: false };
    const placed = await client(fetchImpl).placeOrder(body);

    expect(placed).toEqual({ ordId: "123", clOrdId: "abc" });
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.url.pathname).toBe("/api/v5/trade/order");
    expect(call?.body).toBe(JSON.stringify(body));

    const timestamp = new Date(NOW).toISOString();
    const expectedSign = createHmac("sha256", CREDENTIALS.apiSecret)
      .update(`${timestamp}POST/api/v5/trade/order${JSON.stringify(body)}`)
      .digest("base64");
    expect(call?.headers["OK-ACCESS-SIGN"]).toBe(expectedSign);
    expect(call?.headers["OK-ACCESS-TIMESTAMP"]).toBe(timestamp);
    expect(call?.headers["x-simulated-trading"]).toBe("1");
  });

  it("omits the demo header when trading live", async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      json({ code: "0", msg: "", data: [{ ordId: "9", clOrdId: "x", sCode: "0", sMsg: "" }] }),
    );
    await client(fetchImpl, false).placeOrder({ instId: "BTC-USDT-SWAP" });
    expect(calls[0]?.headers["x-simulated-trading"]).toBeUndefined();
  });

  it("signs the query string as sent for GET requests", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ code: "0", msg: "", data: [] }));
    await client(fetchImpl).position("XAU-USDT-SWAP");
    const expectedPath = "/api/v5/account/positions?instType=SWAP&instId=XAU-USDT-SWAP";
    const timestamp = new Date(NOW).toISOString();
    const expectedSign = createHmac("sha256", CREDENTIALS.apiSecret).update(`${timestamp}GET${expectedPath}`).digest("base64");
    const [call] = calls;
    expect(`${call?.url.pathname}${call?.url.search}`).toBe(expectedPath);
    expect(call?.headers["OK-ACCESS-SIGN"]).toBe(expectedSign);
  });
});

describe("OkxTradeClient error classification", () => {
  it("reports an element-level sCode rejection as a definitive api error", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ code: "0", msg: "", data: [{ ordId: "", clOrdId: "abc", sCode: "51008", sMsg: "Insufficient margin" }] }),
    );
    const error = await client(fetchImpl).placeOrder({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OkxTradeError);
    expect((error as OkxTradeError).kind).toBe("api");
    expect((error as OkxTradeError).sCode).toBe("51008");
    expect((error as OkxTradeError).message).toMatch(/Insufficient margin/);
  });

  it("treats a network failure as unknown outcome", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new Error("socket hang up");
    });
    const error = (await client(fetchImpl).placeOrder({}).catch((e: unknown) => e)) as OkxTradeError;
    expect(error.kind).toBe("network");
  });

  it("treats an unreadable success body as unknown outcome", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    const error = (await client(fetchImpl).placeOrder({}).catch((e: unknown) => e)) as OkxTradeError;
    expect(error.kind).toBe("network");
  });

  it("reports a non-2xx response as an http error", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("bad", { status: 500 }));
    const error = (await client(fetchImpl).placeOrder({}).catch((e: unknown) => e)) as OkxTradeError;
    expect(error.kind).toBe("http");
    expect(error.httpStatus).toBe(500);
  });

  it("flags key, signature and environment failures as auth errors", async () => {
    const { fetchImpl } = fakeFetch(() => json({ code: "50111", msg: "Invalid OK-ACCESS-KEY", data: [] }));
    const error = (await client(fetchImpl).placeOrder({}).catch((e: unknown) => e)) as OkxTradeError;
    expect(error.isAuth).toBe(true);
    expect(error.kind).toBe("api");
  });

  it("does not flag an insufficient-margin rejection as an auth error", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ code: "0", msg: "", data: [{ ordId: "", clOrdId: "", sCode: "51008", sMsg: "insufficient" }] }),
    );
    const error = (await client(fetchImpl).placeOrder({}).catch((e: unknown) => e)) as OkxTradeError;
    expect(error.isAuth).toBe(false);
  });
});

describe("OkxTradeClient reads", () => {
  it("returns null from findOrderByClOrdId when OKX says the order does not exist", async () => {
    const { fetchImpl } = fakeFetch(() => json({ code: "51603", msg: "Order does not exist", data: [] }));
    expect(await client(fetchImpl).findOrderByClOrdId("XAU-USDT-SWAP", "abc")).toBeNull();
  });

  it("returns the ordId and state when the clOrdId is found", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ code: "0", msg: "", data: [{ ordId: "777", state: "filled" }] }),
    );
    expect(await client(fetchImpl).findOrderByClOrdId("XAU-USDT-SWAP", "abc")).toEqual({ ordId: "777", state: "filled" });
  });

  it("caches contract values per instrument", async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      json({ code: "0", msg: "", data: [{ instId: "XAU-USDT-SWAP", ctVal: "0.001" }] }),
    );
    const trade = client(fetchImpl);
    expect(await trade.contractValue("XAU-USDT-SWAP")).toBe(0.001);
    expect(await trade.contractValue("XAU-USDT-SWAP")).toBe(0.001);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["OK-ACCESS-SIGN"]).toBeUndefined();
  });

  it("returns null for a flat position and the average price for an open one", async () => {
    const flat = fakeFetch(() => json({ code: "0", msg: "", data: [{ pos: "0", avgPx: "" }] }));
    expect(await client(flat.fetchImpl).position("XAU-USDT-SWAP")).toBeNull();

    const open = fakeFetch(() => json({ code: "0", msg: "", data: [{ pos: "-2", avgPx: "4100.5" }] }));
    expect(await client(open.fetchImpl).position("XAU-USDT-SWAP")).toEqual({ avgPx: 4100.5 });
  });

  it("reads the last price from the public ticker without credentials", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ code: "0", msg: "", data: [{ last: "4107" }] }));
    expect(await client(fetchImpl).lastPrice("XAU-USDT-SWAP")).toBe(4107);
    expect(calls[0]?.headers["OK-ACCESS-KEY"]).toBeUndefined();
  });

  it("sends the leverage with the margin mode and no posSide", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ code: "0", msg: "", data: [] }));
    await client(fetchImpl).setLeverage("XAU-USDT-SWAP", 15, "isolated");
    expect(calls[0]?.url.pathname).toBe("/api/v5/account/set-leverage");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ instId: "XAU-USDT-SWAP", lever: "15", mgnMode: "isolated" });
  });
});
