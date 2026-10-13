"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PanelIcon, PanelRegistration } from "@/src/modules/registry";

const ICON_PATHS: Record<PanelIcon, string[]> = {
  pulse: ["M2 12h4l3-8 4 16 3-8h6"],
  chart: ["M3 17l6-6 4 4 8-8", "M3 21h18"],
  news: ["M4 5h14v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z", "M18 9h2v8a2 2 0 0 1-2 2", "M7 9h7", "M7 13h7", "M7 17h4"],
  bell: ["M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8", "M10 20a2 2 0 0 0 4 0"],
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

export function DashboardNav({ items }: { items: readonly PanelRegistration[] }) {
  const pathname = usePathname();
  return (
    <nav className="tabbar" aria-label="主导航">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link key={item.id} href={item.href} className="tab" aria-current={active ? "page" : undefined}>
            <NavIcon name={item.icon} />
            <span>{item.title}</span>
          </Link>
        );
      })}
    </nav>
  );
}
