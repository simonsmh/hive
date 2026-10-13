import { redirect } from "next/navigation";
import { getDefaultHref } from "@/src/modules/registry";

export default function DashboardIndex() {
  redirect(getDefaultHref());
}
