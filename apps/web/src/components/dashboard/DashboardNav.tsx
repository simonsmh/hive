"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { activePanel, groupNavItems } from "@/src/modules/registry";
import type { PanelIcon, PanelRegistration } from "@/src/modules/registry";

const ICON_PATHS: Record<PanelIcon, string[]> = {
  pulse: ["M2 12h4l3-8 4 16 3-8h6"],
  chart: ["M3 17l6-6 4 4 8-8", "M3 21h18"],
  news: ["M4 5h14v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z", "M18 9h2v8a2 2 0 0 1-2 2", "M7 9h7", "M7 13h7", "M7 17h4"],
  bell: ["M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8", "M10 20a2 2 0 0 0 4 0"],
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3.5 6h.01", "M3.5 12h.01", "M3.5 18h.01"],
  target: [
    "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z",
    "M12 18c3.314 0 6-2.686 6-6s-2.686-6-6-6-6 2.686-6 6 2.686 6 6 6z",
    "M12 14c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2z",
  ],
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

export function DashboardNav({ items, variant }: {
  items: readonly PanelRegistration[];
  variant: "tabbar" | "sidebar";
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const current = activePanel(pathname, items);
  const groups = groupNavItems(items);
  const links = <>
    <Link href="/" className="side-tab" aria-current={pathname === "/" ? "page" : undefined} onClick={event => { if(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return; event.preventDefault(); setOpen(false); setTarget("功能总览"); startTransition(() => router.push("/")); }}>功能总览</Link>
    {groups.map(group => <section className="nav-group" key={group.id} aria-label={group.title}>
      <h2>{group.title}</h2>
      {group.items.map(item => <Link key={item.id} href={item.href} className="side-tab"
        aria-current={current?.id === item.id ? "page" : undefined}
        onClick={event => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault(); setOpen(false); setTarget(item.title);
          startTransition(() => router.push(item.href));
        }}><NavIcon name={item.icon}/><span>{item.title}</span></Link>)}
    </section>)}
  </>;
  return <>
    {variant === "sidebar" ? <nav className="sidenav" aria-label="主导航">{links}</nav> :
      <div className="mobile-navigation">
        <button className="module-switch" aria-expanded={open} aria-controls="mobile-modules" onClick={() => setOpen(!open)}>
          <span>模块 / {current?.title ?? "功能总览"}</span><span>{open ? "收起 ×" : "全部模块 ▾"}</span>
        </button>
        {open && <nav id="mobile-modules" className="mobile-modules" aria-label="主导航">{links}</nav>}
      </div>}
    {pending && <div className={`navigation-pending pending-${variant}`} role="status">正在打开{target}… 当前内容仍为上一页面，请以各模块数据时间为准。</div>}
  </>;
}

export function DashboardContext() {
  const pathname = usePathname();
  const panel = activePanel(pathname);
  const group = groupNavItems().find(group => group.items.some(item => item.id === panel?.id));
  return <div className="workspace-context"><span>工作台 / {group?.title ?? "总览"} / <strong>{panel?.title ?? "功能总览"}</strong></span><span>数据时间与可用性见模块内标注</span></div>;
}

export function ModuleLink({href, children, className}: {href: string; children: React.ReactNode; className?: string}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <><Link href={href} className={className} onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); startTransition(() => router.push(href));
  }}>{children}</Link>{pending && <div className="navigation-pending" role="status">正在打开模块… 当前仍为上一页面，数据尚未更新。</div>}</>;
}
