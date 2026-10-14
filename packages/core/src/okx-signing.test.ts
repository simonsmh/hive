import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { okxAuthHeaders } from "./okx-signing.js";

const CREDENTIALS = { apiKey: "key-123", apiSecret: "secret-456", passphrase: "phrase-789" };

describe("okxAuthHeaders", () => {
  it("signs timestamp + method + request path with HMAC-SHA256, base64 encoded", async () => {
    const path = "/api/v5/orbit/news-search?sortBy=latest&importance=high&limit=50";
    const timestamp = "2026-10-14T10:55:00.123Z";
    const headers = await okxAuthHeaders(CREDENTIALS, "GET", path, timestamp);

    const expected = createHmac("sha256", CREDENTIALS.apiSecret).update(`${timestamp}GET${path}`).digest("base64");
    expect(headers).toEqual({
      "OK-ACCESS-KEY": "key-123",
      "OK-ACCESS-SIGN": expected,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": "phrase-789",
    });
  });

  it("a different query string produces a different signature", async () => {
    const timestamp = "2026-10-14T10:55:00.000Z";
    const a = await okxAuthHeaders(CREDENTIALS, "GET", "/api/v5/orbit/news-search?limit=50", timestamp);
    const b = await okxAuthHeaders(CREDENTIALS, "GET", "/api/v5/orbit/news-search?limit=49", timestamp);
    expect(a["OK-ACCESS-SIGN"]).not.toBe(b["OK-ACCESS-SIGN"]);
  });

  it("includes the POST body in the signed string", async () => {
    const path = "/api/v5/trade/order";
    const body = JSON.stringify({ instId: "XAU-USDT-SWAP", side: "sell", sz: "1" });
    const timestamp = "2026-10-14T14:40:00.000Z";
    const headers = await okxAuthHeaders(CREDENTIALS, "POST", path, timestamp, body);

    const expected = createHmac("sha256", CREDENTIALS.apiSecret).update(`${timestamp}POST${path}${body}`).digest("base64");
    expect(headers["OK-ACCESS-SIGN"]).toBe(expected);
  });

  it("a changed body produces a different signature", async () => {
    const timestamp = "2026-10-14T14:40:00.000Z";
    const a = await okxAuthHeaders(CREDENTIALS, "POST", "/api/v5/trade/order", timestamp, '{"sz":"1"}');
    const b = await okxAuthHeaders(CREDENTIALS, "POST", "/api/v5/trade/order", timestamp, '{"sz":"2"}');
    expect(a["OK-ACCESS-SIGN"]).not.toBe(b["OK-ACCESS-SIGN"]);
  });
});
