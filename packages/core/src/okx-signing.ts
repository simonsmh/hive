export interface OkxCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

/**
 * OKX v5 REST headers: base64(HMAC-SHA256(secret, timestamp + method + requestPath + body)). The request path
 * includes the query string exactly as it is sent, and the body is the exact JSON text sent on the wire (empty for
 * GET). Order placement must pass its body, or OKX rejects the signature.
 */
export async function okxAuthHeaders(
  credentials: OkxCredentials,
  method: string,
  requestPath: string,
  timestamp: string,
  body = "",
): Promise<Record<string, string>> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(credentials.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}${method}${requestPath}${body}`));
  return {
    "OK-ACCESS-KEY": credentials.apiKey,
    "OK-ACCESS-SIGN": btoa(String.fromCharCode(...new Uint8Array(signature))),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
  };
}
