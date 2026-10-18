/**
 * BlockBeats web-client API transport (unofficial). The public web app signs every request with
 * HMAC-SHA256 and, when `X-Encrypt: true` is sent, returns an AES-128-CBC encrypted body whose key
 * material is derived with MD5 from the shared secret. The demo credentials below are the ones the
 * public frontend ships; override them with Edge secrets if BlockBeats rotates them.
 */

export class BlockBeatsApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockBeatsApiError";
  }
}

export interface BlockBeatsConfig {
  baseUrl: string;
  appKey: string;
  appSecret: string;
}

export const DEFAULT_BLOCKBEATS_CONFIG: BlockBeatsConfig = {
  baseUrl: "https://api.blockbeats.cn",
  appKey: "bb_demo_app",
  appSecret: "bb_demo_secret_2026_01",
};

/** Path as used in the MD5 key derivation (no version prefix). */
const LIST_PATH = "/newsflash/list";
/** Path as used in the request line and the HMAC signature. */
const LIST_PATH_V2 = "/v2/newsflash/list";
const PAGE_SIZE = "20";

// ---------------------------------------------------------------------------
// MD5 (RFC 1321). WebCrypto does not provide MD5, but the key derivation needs
// its hex digest, so it is implemented locally. Validated against RFC vectors
// in api.test.ts.
// ---------------------------------------------------------------------------

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_TABLE = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

function md5Bytes(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(input);
  buffer[input.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let j = 0; j < 16; j++) words[j] = view.getUint32(offset + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_TABLE[i]! + words[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      const shift = MD5_SHIFT[i]!;
      b = (b + ((f << shift) | (f >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

export function md5Hex(input: string): string {
  const bytes = md5Bytes(new TextEncoder().encode(input));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Crypto helpers (AES-CBC + HMAC via WebCrypto; inflate via DecompressionStream)
// ---------------------------------------------------------------------------

function asciiBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", asciiBytes(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, asciiBytes(text) as BufferSource);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function aesCbcDecrypt(keyBytes: Uint8Array, ivBytes: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes as BufferSource }, key, ciphertext as BufferSource);
  return new Uint8Array(plain);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  let lastError: unknown = null;
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }
  throw new BlockBeatsApiError(`could not inflate blockbeats payload: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => NONCE_ALPHABET[byte % NONCE_ALPHABET.length]).join("");
}

// ---------------------------------------------------------------------------
// Signed + encrypted list fetch
// ---------------------------------------------------------------------------

export interface BlockBeatsFetchDeps {
  config: BlockBeatsConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

/**
 * Fetches one page of the newest flashes and returns the decrypted payload ({ page, limit, list }).
 * Throws BlockBeatsApiError on any transport, envelope or decryption failure.
 */
export async function fetchBlockBeatsList(deps: BlockBeatsFetchDeps): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = (deps.now ?? Date.now)();
  const timestamp = String(nowMs);
  const nonce = (deps.nonce ?? randomNonce)();
  const { config } = deps;

  const params: Record<string, string> = {
    end_time: String(Math.floor(nowMs / 1000)),
    ios: "0",
    limit: PAGE_SIZE,
    page: "1",
  };
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const signature = await hmacSha256Hex(config.appSecret, `GET|${LIST_PATH_V2}|${timestamp}|${nonce}|${canonical}`);
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const base = config.baseUrl.replace(/\/+$/, "");

  const response = await fetchImpl(`${base}${LIST_PATH_V2}?${query}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-app-key": config.appKey,
      "x-timestamp": timestamp,
      "x-nonce": nonce,
      "x-signature": signature,
      "x-encrypt": "true",
    },
  });
  if (!response.ok) throw new BlockBeatsApiError(`blockbeats HTTP ${response.status}`);

  const text = await response.text();
  let envelope: Record<string, unknown> | null;
  try {
    const parsed: unknown = JSON.parse(text);
    envelope = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    throw new BlockBeatsApiError("blockbeats response is not JSON (blocked, or the endpoint changed)");
  }
  if (envelope === null) throw new BlockBeatsApiError("blockbeats response envelope is not an object");
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    throw new BlockBeatsApiError(`blockbeats returned code ${envelope.code}: ${typeof envelope.msg === "string" ? envelope.msg : ""}`.trim());
  }

  const encrypted = response.headers.get("x-encrypted") === "true" && typeof envelope.data === "string";
  if (!encrypted) return envelope.data ?? envelope;

  const keyToken = response.headers.get("x-key-token");
  const responseTs = response.headers.get("x-timestamp");
  const responseNonce = response.headers.get("x-nonce");
  if (!keyToken || !responseTs || !responseNonce) {
    throw new BlockBeatsApiError("blockbeats encrypted response is missing key headers");
  }

  try {
    const tokenKey = asciiBytes(md5Hex(`${LIST_PATH}|${timestamp}|${config.appSecret.slice(-8)}`).slice(0, 16));
    const iv = asciiBytes(md5Hex(`${responseTs}|${responseNonce}|${config.appSecret.slice(0, 8)}`).slice(0, 16));
    const tokenPlain = await inflate(await aesCbcDecrypt(tokenKey, iv, base64Decode(keyToken)));
    const bodyKey = tokenPlain.slice(0, 16);
    const bodyPlain = await inflate(await aesCbcDecrypt(bodyKey, iv, base64Decode(envelope.data as string)));
    return JSON.parse(new TextDecoder().decode(bodyPlain)) as unknown;
  } catch (error) {
    if (error instanceof BlockBeatsApiError) throw error;
    throw new BlockBeatsApiError(`blockbeats decryption failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
