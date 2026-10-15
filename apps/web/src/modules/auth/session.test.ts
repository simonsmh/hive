import { describe, expect, it } from "vitest";
import {
  MIN_SECRET_LENGTH,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  checkApiToken,
  checkDashboardPassword,
  createSessionToken,
  readCookieValue,
  isGatedPath,
  isUsableSecret,
  safeNextPath,
  sessionCookieAttributes,
  verifySessionToken,
} from "./session";

const SECRET = "x".repeat(40);
const OTHER_SECRET = "y".repeat(40);
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

describe("isUsableSecret", () => {
  it("requires at least the minimum length", () => {
    expect(isUsableSecret(undefined)).toBe(false);
    expect(isUsableSecret("")).toBe(false);
    expect(isUsableSecret("x".repeat(MIN_SECRET_LENGTH - 1))).toBe(false);
    expect(isUsableSecret("x".repeat(MIN_SECRET_LENGTH))).toBe(true);
  });
});

describe("session tokens", () => {
  it("verifies a freshly issued token", async () => {
    const token = await createSessionToken(SECRET, NOW);
    expect(await verifySessionToken(token, SECRET, NOW)).toBe(true);
  });

  it("encodes the expiry in seconds and keeps the token URL- and cookie-safe", async () => {
    const token = await createSessionToken(SECRET, NOW);
    const [version, expires, signature] = token.split(".");
    expect(version).toBe("v1");
    expect(Number(expires)).toBe(Math.floor(NOW / 1000) + SESSION_TTL_SECONDS);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a token after it expires", async () => {
    const token = await createSessionToken(SECRET, NOW, 60);
    expect(await verifySessionToken(token, SECRET, NOW + 59_000)).toBe(true);
    expect(await verifySessionToken(token, SECRET, NOW + 60_000)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET, NOW);
    expect(await verifySessionToken(token, OTHER_SECRET, NOW)).toBe(false);
  });

  it("rejects a tampered expiry, even when the signature is otherwise intact", async () => {
    const token = await createSessionToken(SECRET, NOW, 60);
    const [version, , signature] = token.split(".");
    const extended = `${version}.${Math.floor(NOW / 1000) + 10 * SESSION_TTL_SECONDS}.${signature}`;
    expect(await verifySessionToken(extended, SECRET, NOW)).toBe(false);
  });

  it.each([
    ["missing token", undefined],
    ["empty token", ""],
    ["garbage", "not-a-token"],
    ["wrong version", "v2.9999999999.abc"],
    ["non-numeric expiry", "v1.abc.def"],
    ["non-base64url signature", "v1.9999999999.@@@"],
    ["extra segment", "v1.9999999999.abc.def"],
  ])("rejects %s", async (_label, token) => {
    expect(await verifySessionToken(token, SECRET, NOW)).toBe(false);
  });

  it("fails closed when the secret is missing or too short", async () => {
    const token = await createSessionToken(SECRET, NOW);
    expect(await verifySessionToken(token, undefined, NOW)).toBe(false);
    expect(await verifySessionToken(token, "short", NOW)).toBe(false);
    await expect(createSessionToken("short", NOW)).rejects.toThrow(/too short/);
  });
});

describe("checkDashboardPassword", () => {
  const password = "correct horse battery staple";

  it("accepts only the exact configured password", async () => {
    expect(await checkDashboardPassword(password, password)).toBe(true);
    expect(await checkDashboardPassword("correct horse battery stapl", password)).toBe(false);
    expect(await checkDashboardPassword(`${password} `, password)).toBe(false);
    expect(await checkDashboardPassword("CORRECT HORSE BATTERY STAPLE", password)).toBe(false);
  });

  it("denies everything when no password is configured or the attempt is empty", async () => {
    expect(await checkDashboardPassword("anything", undefined)).toBe(false);
    expect(await checkDashboardPassword("", "")).toBe(false);
    expect(await checkDashboardPassword("", password)).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin relative paths including query strings", () => {
    expect(safeNextPath("/quotes")).toBe("/quotes");
    expect(safeNextPath("/quotes?symbol=BTC")).toBe("/quotes?symbol=BTC");
  });

  it.each([
    ["absolute URL", "https://evil.example/"],
    ["protocol-relative URL", "//evil.example"],
    ["backslash trick", "/\\evil.example"],
    ["embedded backslash", "/a\\b"],
    ["control characters", "/ok\r\nSet-Cookie: x=1"],
    ["login loop", "/login?next=/"],
    ["missing", undefined],
    ["non-string", ["/a"]],
  ])("falls back to / for %s", (_label, value) => {
    expect(safeNextPath(value)).toBe("/");
  });
});

describe("isGatedPath", () => {
  it.each(["/", "/health", "/quotes", "/news", "/alerts"])("gates dashboard page %s", (path) => {
    expect(isGatedPath(path)).toBe(true);
  });

  it.each(["/login", "/offline", "/manifest.webmanifest", "/sw.js", "/icons/icon-192.png", "/_next/static/chunk.js", "/favicon.ico"])(
    "leaves public asset or page %s open",
    (path) => {
      expect(isGatedPath(path)).toBe(false);
    },
  );

  it.each(["/api", "/api/quote", "/api/health"])("never gates the Bearer-protected API (%s)", (path) => {
    expect(isGatedPath(path)).toBe(false);
  });

  it("does not treat look-alike prefixes as public", () => {
    expect(isGatedPath("/loginx")).toBe(true);
    expect(isGatedPath("/apix")).toBe(true);
  });
});

describe("sessionCookieAttributes", () => {
  it("issues an httpOnly, Secure, SameSite=Lax cookie scoped to the whole site", () => {
    expect(sessionCookieAttributes()).toEqual({
      name: SESSION_COOKIE,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  });
});

describe("checkApiToken", () => {
  const token = "test-api-token-0123456789abcdef";

  it("accepts only the exact token", async () => {
    expect(await checkApiToken(token, token)).toBe(true);
    expect(await checkApiToken("hive-token-0123456789abcdefg", token)).toBe(false);
    expect(await checkApiToken(token.toUpperCase(), token)).toBe(false);
  });

  it("fails closed when nothing is configured or presented", async () => {
    expect(await checkApiToken("anything", undefined)).toBe(false);
    expect(await checkApiToken("", token)).toBe(false);
  });
});

describe("readCookieValue", () => {
  it("extracts the named cookie from a header with several cookies", () => {
    expect(readCookieValue("theme=dark; hive_session=v1.123.abc; other=1", "hive_session")).toBe("v1.123.abc");
    expect(readCookieValue("hive_session=v1.123.abc", "hive_session")).toBe("v1.123.abc");
  });

  it("returns undefined when the cookie or header is absent", () => {
    expect(readCookieValue("theme=dark", "hive_session")).toBeUndefined();
    expect(readCookieValue(null, "hive_session")).toBeUndefined();
    expect(readCookieValue("", "hive_session")).toBeUndefined();
  });

  it("does not match look-alike cookie names and decodes escapes", () => {
    expect(readCookieValue("hive_session_extra=x", "hive_session")).toBeUndefined();
    expect(readCookieValue("hive_session=a%20b", "hive_session")).toBe("a b");
  });
});
