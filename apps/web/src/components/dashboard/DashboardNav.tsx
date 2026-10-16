"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PanelIcon, PanelRegistration } from "@/src/modules/registry";

const ICON_PATHS: Record<PanelIcon, string[]> = {
  pulse: ["M2 12h4l3-8 4 16 3-8h6"],
  chart: ["M3 17l6-6 4 4 8-8", "M3 21h18"],
  news: ["M4 5h14v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z", "M18 9h2v8a2 2 0 0 1-2 2", "M7 9h7", "M7 13h7", "M7 17h4"],
  bell: ["M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8", "M10 20a2 2 0 0 0 4 0"],
  gear: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1 1.55.61.26 1.32.1 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01c.26.6.86 1 1.55 1H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.55 1z",
  ],
};

function NavIcon({ name }: { name: PanelIcon }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * One navigation model, two presentations: a bottom tab bar on phones and tablets,
 * a side rail on desktop. CSS decides which one is visible at each breakpoint.
 */
export function DashboardNav({
  items,
  variant,
}: {
  items: readonly PanelRegistration[];
  variant: "tabbar" | "sidebar";
}) {
  const pathname = usePathname();
  return (
    <nav className={variant === "sidebar" ? "sidenav" : "tabbar"} aria-label="主导航">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.id}
            href={item.href}
            className={variant === "sidebar" ? "side-tab" : "tab"}
            aria-current={active ? "page" : undefined}
          >
            <NavIcon name={item.icon} />
            <span>{item.title}</span>
          </Link>
        );
      })}
    </nav>
  );
}
