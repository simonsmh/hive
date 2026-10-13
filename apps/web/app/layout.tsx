import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ServiceWorkerRegister } from "@/src/components/pwa/ServiceWorkerRegister";
import { PWA_CONFIG } from "@/src/modules/pwa/config";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: PWA_CONFIG.name,
  title: { default: PWA_CONFIG.name, template: `%s · ${PWA_CONFIG.name}` },
  description: PWA_CONFIG.description,
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, title: PWA_CONFIG.name, statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: PWA_CONFIG.themeColor,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={PWA_CONFIG.lang}>
      <body>
        {children}
        <ServiceWorkerRegister />
        <SpeedInsights />
      </body>
    </html>
  );
}
