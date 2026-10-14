import { createHmac } from "node:crypto";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { okxAuthHeaders } from "./okx-signing.ts";

const CREDENTIALS = { apiKey: "key-123", apiSecret: "secret-456", passphrase: "phrase-789" };

Deno.test("signs timestamp + method + request path with HMAC-SHA256, base64 encoded", async () => {
  const path = "/api/v5/orbit/news-search?sortBy=latest&importance=high&limit=50";
  const timestamp = "2026-10-14T10:55:00.123Z";
  const headers = await okxAuthHeaders(CREDENTIALS, "GET", path, timestamp);

  const expected = createHmac("sha256", CREDENTIALS.apiSecret).update(`${timestamp}GET${path}`).digest("base64");
  deepStrictEqual(headers, {
    "OK-ACCESS-KEY": "key-123",
    "OK-ACCESS-SIGN": expected,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": "phrase-789",
  });
});

Deno.test("a different query string produces a different signature", async () => {
  const timestamp = "2026-10-14T10:55:00.000Z";
  const a = await okxAuthHeaders(CREDENTIALS, "GET", "/api/v5/orbit/news-search?limit=50", timestamp);
  const b = await okxAuthHeaders(CREDENTIALS, "GET", "/api/v5/orbit/news-search?limit=49", timestamp);
  strictEqual(a["OK-ACCESS-SIGN"] === b["OK-ACCESS-SIGN"], false);
});
