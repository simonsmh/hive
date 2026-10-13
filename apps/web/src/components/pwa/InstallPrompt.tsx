"use client";

import { useEffect, useState } from "react";
import { isIosDevice, isStandaloneDisplay } from "@/src/modules/pwa/install";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "hive-install-dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage can be unavailable (private mode); the banner just reappears next visit.
  }
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const standalone = isStandaloneDisplay(
      window.matchMedia("(display-mode: standalone)").matches,
      (navigator as Navigator & { standalone?: boolean }).standalone,
    );
    if (standalone || readDismissed()) return;

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setDeferred(null);
      setVisible(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    if (isIosDevice(navigator.userAgent)) {
      setIosHint(true);
      setVisible(true);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    writeDismissed();
    setVisible(false);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    if (choice.outcome === "accepted") setVisible(false);
  };

  return (
    <aside className="install-banner" role="region" aria-label="安装应用">
      {deferred ? (
        <>
          <p>将 Hive 安装到主屏幕，离线时也能打开看板。</p>
          <div className="install-actions">
            <button type="button" className="btn" onClick={install}>
              安装
            </button>
            <button type="button" className="btn-ghost" onClick={dismiss}>
              稍后
            </button>
          </div>
        </>
      ) : iosHint ? (
        <>
          <p>在 Safari 中点按「分享」，再选择「添加到主屏幕」即可安装。</p>
          <div className="install-actions">
            <button type="button" className="btn-ghost" onClick={dismiss}>
              知道了
            </button>
          </div>
        </>
      ) : null}
    </aside>
  );
}
