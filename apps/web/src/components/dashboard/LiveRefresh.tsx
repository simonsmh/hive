"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { payloadString, subscribeTopic, type StreamTopic } from "@/src/modules/live/stream-client";

/**
 * Bridges the SSE stream and server-rendered panels. The page passes the content key
 * it rendered with (newest id / digest); when the stream reports a different key there
 * is genuinely new content — reconnect baselines replay the same key and are ignored.
 * In `prompt` mode a pill offers the refresh; in `auto` mode the panel refreshes itself.
 */
export function LiveRefresh({
  topic,
  field,
  baseline,
  label,
  auto = false,
}: {
  topic: StreamTopic;
  field: string;
  baseline: string;
  label: string;
  auto?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  useEffect(
    () =>
      subscribeTopic(topic, (data) => {
        const key = payloadString(data, field);
        if (key === null || key === baseline) return;
        if (auto) {
          router.refresh();
        } else {
          setPending(true);
        }
      }),
    [topic, field, baseline, auto, router],
  );

  if (!pending) return null;
  return (
    <button
      type="button"
      className="live-pill"
      onClick={() => {
        setPending(false);
        router.refresh();
      }}
    >
      {label}
    </button>
  );
}
