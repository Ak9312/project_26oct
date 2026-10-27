import type { Metadata, Viewport } from "next";
// Public Sans: the open typeface designed for public-service websites. Self-hosted.
import "@fontsource-variable/public-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "Policy Knowledge Assistant",
  description: "Ask questions about published public policy documents and see the exact page each answer comes from.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#13294b" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1f3d" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
