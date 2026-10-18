import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { DEFAULT_BLOCKBEATS_CONFIG, fetchBlockBeatsList, md5Hex } from "./api.ts";

/** Encrypted fixture produced with the same key derivation the live API uses (see research notes). */
const FIXTURE = {
  requestNowMs: 1_700_000_000_000,
  responseTs: "1700000000123",
  responseNonce: "AbCdEfGhIjKlMnOp",
  keyToken: "B6/EvejvpZfyphpxMTLkVQEtvrxcP8G1IG5Jce8Rj1s=",
  data: "3fTGCwNW/UoRhs15s13fMwSFEdY+URd+JZBC7CGedLBXocF8e1QM3g9feBNeiQpIM/qUOVDdEUsSgyw2VL86n5Jl/wu6GuZMYvpqF7XpYor3BOd00fdIY66p7WSY3nU6SRdMMnjoXAYq6AcXKJ8tdgD3gUKdydCxK2tlucZYvYxQ9hYhYHwM+fwFrGkED0w5g5NYzsQLUWCYt1B0chgI0X6uYqchS1EgX7kYzNDFdkAfdymtzp+cA+fJPsgnTBkdFOR9IMZuVLfCKHNiN5uW9W9UM0o/w2/C1tEsJkVoquyJxqlMaZXn+T8k3yNx5kXnINZY97awhTfL6HK/KVJgnA==",
} as const;

function fixtureResponse(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: FIXTURE.data }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-encrypted": "true",
      "x-key-token": FIXTURE.keyToken,
      "x-timestamp": FIXTURE.responseTs,
      "x-nonce": FIXTURE.responseNonce,
    },
  });
}

Deno.test("md5Hex matches the RFC 1321 test suite", () => {
  strictEqual(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  strictEqual(md5Hex("a"), "0cc175b9c0f1b6a831c399e269772661");
  strictEqual(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
  strictEqual(md5Hex("message digest"), "f96b697d7cb7938d525a2f31aaf161d0");
  strictEqual(md5Hex("abcdefghijklmnopqrstuvwxyz"), "c3fcd3d76192e4007dfb496cca67e13b");
  strictEqual(md5Hex("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
  strictEqual(
    md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
    "57edf4a22be3c955ac49da2e2107b67a",
  );
});

Deno.test("fetchBlockBeatsList signs the request and decrypts the response", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    seenHeaders = (init?.headers ?? {}) as Record<string, string>;
    return fixtureResponse();
  }) as typeof fetch;

  const payload = (await fetchBlockBeatsList({
    config: { ...DEFAULT_BLOCKBEATS_CONFIG },
    fetchImpl,
    now: () => FIXTURE.requestNowMs,
    nonce: () => "TestNonce1234567",
  })) as { page: number; list: Array<Record<string, unknown>> };

  strictEqual(seenHeaders["x-app-key"], DEFAULT_BLOCKBEATS_CONFIG.appKey);
  strictEqual(seenHeaders["x-encrypt"], "true");
  strictEqual(seenHeaders["x-timestamp"], String(FIXTURE.requestNowMs));
  strictEqual(/^[0-9a-f]{64}$/.test(seenHeaders["x-signature"] ?? ""), true);
  strictEqual(seenUrl.includes("end_time=1700000000"), true);
  strictEqual(payload.page, 1);
  strictEqual(payload.list.length, 2);
  deepStrictEqual(payload.list[0]?.id, 221820);
});

Deno.test("fetchBlockBeatsList rejects a non-zero envelope code", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ code: 40101, msg: "Invalid App Key" }), { status: 200 })) as unknown as typeof fetch;
  let message = "";
  try {
    await fetchBlockBeatsList({ config: { ...DEFAULT_BLOCKBEATS_CONFIG }, fetchImpl, now: () => FIXTURE.requestNowMs });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  strictEqual(message.includes("40101"), true);
});
