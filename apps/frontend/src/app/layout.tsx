import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "XeeClip — Turn long videos into short clips", template: "%s · XeeClip" },
  description: "Turn long videos into ready-to-post short clips with AI: hooks, captions and hashtags included.",
  applicationName: "XeeClip",
  appleWebApp: { capable: true, title: "XeeClip", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false }
};

/**
 * `viewport-fit=cover` lets the fixed bars use env(safe-area-inset-*) on notched phones, and
 * `interactive-widget=resizes-content` makes Android Chrome shrink the layout viewport (and so
 * `dvh`) when the keyboard opens, which keeps fixed chat inputs above it. iOS reports the keyboard
 * through visualViewport instead; see useKeyboardInset.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#070a12",
  colorScheme: "dark"
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
