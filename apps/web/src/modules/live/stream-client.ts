import { useEffect, useRef, useState } from "react";

export type StreamTopic = "quotes" | "news" | "alerts" | "health" | "ready";
export type StreamStatus = "connecting" | "live" | "down";

const TOPICS: readonly StreamTopic[] = ["quotes", "news", "alerts", "health", "ready"];

type Handler = (data: unknown) => void;

/**
 * One EventSource per tab, shared by every live component. The server closes the
 * connection after ~55s and EventSource reconnects by itself; because stream events
 * carry content keys (newest ids, digests), consumers can ignore the baseline snapshot
 * a reconnect replays. When the stream is down, components that hold data fall back to
 * their own polling.
 */
const handlers = new Map<StreamTopic, Set<Handler>>();
const statusHandlers = new Set<(status: StreamStatus) => void>();
let status: StreamStatus = "connecting";
let source: EventSource | null = null;

function setStatus(next: StreamStatus): void {
  if (status === next) return;
  status = next;
  for (const handler of statusHandlers) handler(next);
}

function ensureSource(): void {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/stream");
  source.onopen = () => setStatus("live");
  source.onerror = () => setStatus("down");
  for (const topic of TOPICS) {
    source.addEventListener(topic, (event) => {
      let data: unknown = null;
      try {
        data = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        data = null;
      }
      const set = handlers.get(topic);
      if (set) for (const handler of set) handler(data);
    });
  }
}

export function subscribeTopic(topic: StreamTopic, handler: Handler): () => void {
  ensureSource();
  let set = handlers.get(topic);
  if (!set) {
    set = new Set();
    handlers.set(topic, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

export function subscribeStatus(handler: (status: StreamStatus) => void): () => void {
  statusHandlers.add(handler);
  handler(status);
  return () => {
    statusHandlers.delete(handler);
  };
}

export function useStreamStatus(): StreamStatus {
  const [current, setCurrent] = useState<StreamStatus>(status);
  useEffect(() => subscribeStatus(setCurrent), []);
  return current;
}

/** Subscribes to one topic for the component's lifetime; the handler may change freely. */
export function useTopic(topic: StreamTopic, handler: Handler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeTopic(topic, (data) => ref.current(data)), [topic]);
}

/** Extracts a string field from an unknown stream payload. */
export function payloadString(data: unknown, field: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}
