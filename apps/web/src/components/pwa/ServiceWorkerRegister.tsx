"use client";

import { useEffect } from "react";

// Production only: in dev the worker would serve stale chunks and hide HMR updates.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.warn("[pwa] service worker registration failed", error);
    });
  }, []);

  return null;
}
