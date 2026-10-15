import { describe, expect, it } from "vitest";
import { sameApplicationServerKey, urlBase64ToUint8Array } from "./push-client";

describe("sameApplicationServerKey", () => {
  it("matches an identical key", () => {
    const raw = urlBase64ToUint8Array("BEl6x8f3Gq2examplepublickeymaterial000000000");
    expect(sameApplicationServerKey(raw.buffer as ArrayBuffer, "BEl6x8f3Gq2examplepublickeymaterial000000000")).toBe(true);
  });

  it("rejects null, empty, and differing keys", () => {
    const raw = urlBase64ToUint8Array("BEl6x8f3Gq2examplepublickeymaterial000000000");
    expect(sameApplicationServerKey(null, "BEl6x8f3Gq2examplepublickeymaterial000000000")).toBe(false);
    expect(sameApplicationServerKey(new ArrayBuffer(0), "BEl6x8f3Gq2examplepublickeymaterial000000000")).toBe(false);
    expect(sameApplicationServerKey(raw.buffer as ArrayBuffer, "BEl6x8f3Gq2DIFFERENTkeymaterial000000000")).toBe(false);
    // One byte difference in a same-length key.
    const other = new Uint8Array(raw);
    other[0] = other[0]! ^ 0xff;
    expect(sameApplicationServerKey(other.buffer as ArrayBuffer, "BEl6x8f3Gq2examplepublickeymaterial000000000")).toBe(false);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("round-trips base64url without padding", () => {
    const bytes = urlBase64ToUint8Array("SGVsbG8td29ybGQ");
    expect(new TextDecoder().decode(bytes)).toBe("Hello-world");
  });
});
