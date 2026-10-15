// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.
/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption
 * (RFC 8291), implemented on WebCrypto only so the same module runs in Node
 * tests and in Deno Edge Functions. No state and no I/O except the final send,
 * whose fetch can be injected for tests.
 */
// The key types are derived from the subtle methods themselves so the module
// typechecks against both Node's and Deno's WebCrypto typings without naming
// either environment's ambient CryptoKey types.
type AnyKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
interface EphemeralKeyPairLike {
  publicKey: AnyKey;
  privateKey: AnyKey;
}
type FetchBody = NonNullable<RequestInit["body"]>;

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data as BufferSource));
}

/** HKDF-Extract (RFC 5869): an absent salt behaves as HashLen zero bytes. */
export async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt.length > 0 ? salt : new Uint8Array(32), ikm);
}

/** HKDF-Expand (RFC 5869) for outputs up to 255 * 32 bytes. */
export async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  let produced = 0;
  let previous: Uint8Array = new Uint8Array(0);
  for (let counter = 1; produced < length; counter++) {
    previous = await hmacSha256(prk, concat(previous, info, new Uint8Array([counter])));
    blocks.push(previous);
    produced += previous.length;
  }
  return concat(...blocks).slice(0, length);
}

export async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  return hkdfExpand(await hkdfExtract(salt, ikm), info, length);
}

export interface VapidKeys {
  /** base64url uncompressed P-256 public point (65 bytes, 0x04 prefix). */
  publicKey: string;
  /** base64url P-256 private scalar (32 bytes). */
  privateKey: string;
  /** Contact URI for the push service, typically a mailto: address. */
  subject: string;
}

async function vapidSigningKey(keys: VapidKeys) {
  const publicPoint = base64UrlDecode(keys.publicKey);
  if (publicPoint.length !== 65 || publicPoint[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  }
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicPoint.slice(1, 33)),
    y: base64UrlEncode(publicPoint.slice(33, 65)),
    d: base64UrlEncode(base64UrlDecode(keys.privateKey)),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Builds the `Authorization: vapid t=<jwt>, k=<public key>` header value for one endpoint. */
export async function createVapidAuthorization(endpoint: string, keys: VapidKeys, nowMs: number = Date.now()): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, sub: keys.subject }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await vapidSigningKey(keys),
    encoder.encode(signingInput) as BufferSource,
  );
  return `vapid t=${signingInput}.${base64UrlEncode(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  /** base64url uncompressed P-256 public point of the user agent. */
  p256dh: string;
  /** base64url 16-byte auth secret. */
  auth: string;
}

const RECORD_SIZE = 4096;

/**
 * Encrypts a payload for one subscription (RFC 8291, aes128gcm). The ephemeral
 * key pair and salt are injectable so tests can decrypt deterministically.
 */
export async function encryptPushPayload(
  subscription: PushSubscriptionKeys,
  payload: Uint8Array,
  options: { salt?: Uint8Array; ephemeralKeyPair?: EphemeralKeyPairLike } = {},
): Promise<Uint8Array> {
  const uaPublic = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh must be a 65-byte uncompressed point");
  if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");

  const ephemeral: EphemeralKeyPairLike =
    options.ephemeralKeyPair ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as unknown as EphemeralKeyPairLike);
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256),
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, encoder.encode("Content-Encoding: nonce\0"), 12);

  const cekKey = await crypto.subtle.importKey("raw", cek as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = concat(payload, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 }, cekKey, plaintext as BufferSource),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export interface WebPushResult {
  status: number;
  /** True when the push service says the subscription is gone (404/410) and should be deleted. */
  gone: boolean;
}

type FetchLike = (input: string, init: RequestInit) => Promise<{ status: number }>;

/** Sends one encrypted push message. Network failures propagate to the caller. */
export async function sendWebPush(
  subscription: PushSubscriptionKeys,
  payloadText: string,
  vapid: VapidKeys,
  options: { ttlSeconds?: number; urgency?: "very-low" | "low" | "normal" | "high"; fetchImpl?: FetchLike } = {},
): Promise<WebPushResult> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const body = await encryptPushPayload(subscription, encoder.encode(payloadText));
  const response = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: await createVapidAuthorization(subscription.endpoint, vapid),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(options.ttlSeconds ?? 3600),
      urgency: options.urgency ?? "normal",
    },
    body: body as FetchBody,
  });
  return { status: response.status, gone: response.status === 404 || response.status === 410 };
}
