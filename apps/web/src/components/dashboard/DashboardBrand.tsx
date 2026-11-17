"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HOME_HREF } from "@/src/modules/registry";

/** The Hive wordmark always returns to the feature catalog. */
export function DashboardBrand() {
  const pathname = usePathname();
  const atHome = pathname === HOME_HREF;
  return (
    <Link href={HOME_HREF} className="brand" aria-current={atHome ? "page" : undefined}>
      Hive
    </Link>
  );
}
