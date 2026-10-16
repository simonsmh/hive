/**
 * Browser-side Web Push plumbing: permission, subscription lifecycle, and syncing
 * the subscription to /api/push/subscriptions. Everything degrades to a typed state
 * the settings UI can render (unsupported browsers, denied permission, no VAPID key).
 */

export interface PushFilters {
  news: boolean;
  alerts: boolean;
}

export type PushSupport = "ready" | "unsupported" | "no-vapid-key" | "no-service-worker";

/** Thrown when the browser has no registered service worker (e.g. dev mode). */
export class NoServiceWorkerError extends Error {}

export function pushSupport(publicKey: string | null): PushSupport {
  if (!publicKey) return "no-vapid-key";
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }
  return "ready";
}

export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Upper bound for waiting on a service worker registration before giving up. */
const REGISTRATION_WAIT_MS = 5000;
/** Interval between registration checks; catches an in-flight register(). */
const REGISTRATION_POLL_MS = 100;

async function registration(): Promise<ServiceWorkerRegistration> {
  // On a clean production profile, ServiceWorkerRegister starts register() in a
  // separate effect, so a single getRegistration() can resolve undefined while
  // registration is still in flight. Poll until it settles instead of reading
  // once: a real registration shows up within a few hundred milliseconds, while
  // in dev (register() is deliberately skipped) nothing ever appears and we still
  // give up after REGISTRATION_WAIT_MS rather than leaving the UI stuck loading
  // (`navigator.serviceWorker.ready` never settles in that case).
  const deadline = Date.now() + REGISTRATION_WAIT_MS;
  for (;;) {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) return existing;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_POLL_MS));
  }
  throw new NoServiceWorkerError("no service worker is registered");
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg.pushManager.getSubscription();
}

/**
 * Whether a browser subscription was created for this application server key.
 * After a VAPID key rotation the old subscription is unusable: the server signs
 * with the new key while the push service still expects the old one, so the
 * subscription must be recreated instead of reused.
 */
export function sameApplicationServerKey(serverKey: ArrayBuffer | null, publicKey: string): boolean {
  if (!serverKey) return false;
  const expected = urlBase64ToUint8Array(publicKey);
  if (serverKey.byteLength !== expected.byteLength) return false;
  const actual = new Uint8Array(serverKey);
  return actual.every((byte, index) => byte === expected[index]);
}

interface SubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  filters: PushFilters;
}

function toPayload(subscription: PushSubscription, filters: PushFilters): SubscriptionPayload {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    filters,
  };
}

/**
 * (Re-)registers a browser subscription with the server. Used both on subscribe
 * and on settings load: if subscribing succeeded but the first POST was lost, the
 * browser alone would report "subscribed" while the server had no row and no
 * notification would ever arrive.
 */
export async function syncSubscription(subscription: PushSubscription, filters: PushFilters): Promise<void> {
  const response = await fetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toPayload(subscription, filters)),
  });
  if (!response.ok) throw new Error(`subscription sync failed (${response.status})`);
}

/** Asks for permission, subscribes, and registers the subscription with the server. */
export async function subscribePush(publicKey: string, filters: PushFilters): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("permission-not-granted");
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  if (existing && !sameApplicationServerKey(existing.options?.applicationServerKey ?? null, publicKey)) {
    // Stale key: drop it so the fresh subscription below is bound to the current key.
    await existing.unsubscribe();
  }
  const subscription =
    existing && sameApplicationServerKey(existing.options?.applicationServerKey ?? null, publicKey)
      ? existing
      : await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
  await syncSubscription(subscription, filters);
  return subscription;
}

/** Re-syncs filter choices for an existing subscription. */
export async function updatePushFilters(filters: PushFilters): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription) await syncSubscription(subscription, filters);
}

/** Removes the server registration first, then the browser subscription. */
export async function unsubscribePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await fetch("/api/push/subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined);
  await subscription.unsubscribe();
}
