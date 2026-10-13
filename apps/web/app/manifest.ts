import type { MetadataRoute } from "next";
import { PWA_CONFIG } from "@/src/modules/pwa/config";
import { getNavItems } from "@/src/modules/registry";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PWA_CONFIG.name,
    short_name: PWA_CONFIG.name,
    description: PWA_CONFIG.description,
    lang: PWA_CONFIG.lang,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: PWA_CONFIG.backgroundColor,
    theme_color: PWA_CONFIG.themeColor,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: getNavItems().map((panel) => ({
      name: panel.title,
      short_name: panel.title,
      url: panel.href,
    })),
  };
}
