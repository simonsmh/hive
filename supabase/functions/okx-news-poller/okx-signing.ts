export interface OkxCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

/**
 * OKX v5 REST headers: base64(HMAC-SHA256(secret, timestamp + method + requestPath + body)). The request path
 * includes the query string exactly as it is sent. The news endpoint only reads, so a read-only key is enough.
 */
export async function okxAuthHeaders(
  credentials: OkxCredentials,
  method: string,
  requestPath: string,
  timestamp: string,
): Promise<Record<string, string>> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(credentials.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}${method}${requestPath}`));
  return {
    "OK-ACCESS-KEY": credentials.apiKey,
    "OK-ACCESS-SIGN": btoa(String.fromCharCode(...new Uint8Array(signature))),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
  };
}
