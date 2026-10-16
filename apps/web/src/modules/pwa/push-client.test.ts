import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NoServiceWorkerError,
  currentSubscription,
  sameApplicationServerKey,
  urlBase64ToUint8Array,
} from "./push-client";

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

describe("currentSubscription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps polling until an in-flight registration settles", async () => {
    const fakeReg = { pushManager: { getSubscription: async () => null } };
    let calls = 0;
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => {
          calls += 1;
          return calls >= 3 ? (fakeReg as unknown as ServiceWorkerRegistration) : undefined;
        },
      },
    });
    // On a clean production profile register() starts in a separate effect, so
    // the first reads resolve undefined while it is still in flight.
    await expect(currentSubscription()).resolves.toBeNull();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("throws NoServiceWorkerError when no worker ever registers (e.g. next dev)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: async () => undefined },
    });
    const pending = currentSubscription();
    const assertion = expect(pending).rejects.toBeInstanceOf(NoServiceWorkerError);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
  });
});
