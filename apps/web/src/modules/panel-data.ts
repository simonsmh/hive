import { ConfigError } from "@/lib/api";

export type PanelResult<T> = { ok: true; data: T } | { ok: false; message: string };

/** Panels render an error state instead of throwing, and the raw error is logged server-side only. */
export async function loadPanelData<T>(label: string, load: () => Promise<T>): Promise<PanelResult<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    console.error(`[dashboard] ${label} failed`, error);
    const message =
      error instanceof ConfigError ? "服务端配置缺失，请检查环境变量" : "数据暂时无法加载，请稍后重试";
    return { ok: false, message };
  }
}
