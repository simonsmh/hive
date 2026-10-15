import type { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  createVapidAuthorization,
  encryptPushPayload,
  hkdf,
  hkdfExpand,
  hkdfExtract,
  sendWebPush,
  type PushSubscriptionKeys,
} from "./webpush.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("hkdf (RFC 5869)", () => {
  it("matches SHA-256 test case 1", async () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = hexToBytes("000102030405060708090a0b0c");
    const info = hexToBytes("f0f1f2f3f4f5f6f7f8f9");
    const prk = await hkdfExtract(salt, ikm);
    expect(bytesToHex(prk)).toBe("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5");
    const okm = await hkdfExpand(prk, info, 42);
    expect(bytesToHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
    expect(bytesToHex(await hkdf(salt, ikm, info, 42))).toBe(bytesToHex(okm));
  });
});

async function generateP256(): Promise<{ pair: webcrypto.CryptoKeyPair; publicRaw: Uint8Array; privateScalar: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { pair, publicRaw, privateScalar: base64UrlDecode(jwk.d!) };
}

describe("VAPID authorization", () => {
  it("produces a verifiable ES256 JWT scoped to the push service origin", async () => {
    const { publicRaw, privateScalar } = await generateP256();
    const keys = {
      publicKey: base64UrlEncode(publicRaw),
      privateKey: base64UrlEncode(privateScalar),
      subject: "mailto:ops@example.com",
    };
    const header = await createVapidAuthorization("https://push.example.net/send/abc", keys, Date.UTC(2026, 9, 16));
    expect(header.startsWith("vapid t=")).toBe(true);
    expect(header.endsWith(`, k=${keys.publicKey}`)).toBe(true);

    const jwt = header.slice("vapid t=".length, header.indexOf(","));
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader)))).toEqual({ typ: "JWT", alg: "ES256" });
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(payload.aud).toBe("https://push.example.net");
    expect(payload.sub).toBe("mailto:ops@example.com");
    expect(payload.exp).toBe(Math.floor(Date.UTC(2026, 9, 16) / 1000) + 12 * 3600);

    const verifyKey = await crypto.subtle.importKey(
      "raw",
      publicRaw,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      base64UrlDecode(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    expect(valid).toBe(true);
  });
});

describe("payload encryption (RFC 8291)", () => {
  it("round-trips: a receiver with the UA private key recovers the payload", async () => {
    const ua = await generateP256();
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const subscription: PushSubscriptionKeys = {
      endpoint: "https://push.example.net/send/abc",
      p256dh: base64UrlEncode(ua.publicRaw),
      auth: base64UrlEncode(authSecret),
    };
    const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const salt = hexToBytes("101112131415161718191a1b1c1d1e1f");
    const payload = new TextEncoder().encode(JSON.stringify({ title: "Hive 新闻", body: "MU 异动" }));

    const body = await encryptPushPayload(subscription, payload, { salt, ephemeralKeyPair: ephemeral });

    // Header: salt(16) || rs(4) || idlen(1) || ephemeral public(65).
    expect(body.slice(0, 16)).toEqual(salt);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096);
    expect(body[20]).toBe(65);
    const asPublic = body.slice(21, 86);
    expect(asPublic).toEqual(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)));

    // Receiver side: ECDH with the UA private key and the sender's ephemeral public.
    const asKey = await crypto.subtle.importKey(
      "raw",
      asPublic,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.pair.privateKey, 256));
    const keyInfo = new Uint8Array([
      ...new TextEncoder().encode("WebPush: info\0"),
      ...ua.publicRaw,
      ...asPublic,
    ]);
    const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
    const prk = await hkdfExtract(salt, ikm);
    const cek = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
    const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, tagLength: 128 },
        cekKey,
        body.slice(86),
      ),
    );
    expect(plain[plain.length - 1]).toBe(0x02);
    expect(plain.slice(0, -1)).toEqual(payload);
  });

  it("rejects malformed subscription keys", async () => {
    await expect(
      encryptPushPayload({ endpoint: "https://x", p256dh: "AA", auth: base64UrlEncode(new Uint8Array(16)) }, new Uint8Array()),
    ).rejects.toThrow(/p256dh/);
  });
});

describe("sendWebPush", () => {
  it("posts an aes128gcm body with a VAPID header and flags gone subscriptions", async () => {
    const server = await generateP256();
    const ua = await generateP256();
    const vapid = {
      publicKey: base64UrlEncode(server.publicRaw),
      privateKey: base64UrlEncode(server.privateScalar),
      subject: "mailto:ops@example.com",
    };
    const subscription: PushSubscriptionKeys = {
      endpoint: "https://push.example.net/send/abc",
      p256dh: base64UrlEncode(ua.publicRaw),
      auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    };
    let seen: { url: string; init: RequestInit } | null = null;
    const ok = await sendWebPush(subscription, "hello", vapid, {
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { status: 201 };
      },
    });
    expect(ok).toEqual({ status: 201, gone: false });
    expect(seen!.url).toBe(subscription.endpoint);
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.authorization).toContain("vapid t=");
    expect((seen!.init.body as Uint8Array).length).toBeGreaterThan(86);

    const gone = await sendWebPush(subscription, "hello", vapid, { fetchImpl: async () => ({ status: 410 }) });
    expect(gone).toEqual({ status: 410, gone: true });
  });
});
