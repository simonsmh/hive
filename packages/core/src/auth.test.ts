import { describe, expect, it } from "vitest";
import { isAuthorized, parseBearerToken } from "./auth.js";

describe("parseBearerToken", () => {
  it("extracts the token from a Bearer header, case-insensitively", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
    expect(parseBearerToken("bearer abc123  ")).toBe("abc123");
  });

  it("returns null for missing or malformed headers", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("Basic abc123")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer a b")).toBeNull();
  });
});

describe("isAuthorized", () => {
  const token = "s3cret-token-value-0123456789";

  it("accepts the exact token", () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects a wrong, prefix or suffix token", () => {
    expect(isAuthorized("Bearer s3cret-token-value", token)).toBe(false);
    expect(isAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(isAuthorized("Bearer wrong", token)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isAuthorized(null, token)).toBe(false);
    expect(isAuthorized(token, token)).toBe(false);
  });

  it("fails closed when no expected token is configured", () => {
    expect(isAuthorized("Bearer ", undefined)).toBe(false);
    expect(isAuthorized("Bearer anything", "")).toBe(false);
    expect(isAuthorized(undefined, undefined)).toBe(false);
  });
});
