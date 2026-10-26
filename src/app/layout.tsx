import type { Metadata, Viewport } from "next";
// Self-hosted fonts: Public Sans (the typeface designed for government sites) for the interface,
// Literata (a long-form reading face) for answers and document passages.
import "@fontsource-variable/public-sans";
import "@fontsource-variable/literata";
import "./globals.css";

export const metadata: Metadata = {
  title: "Policy Knowledge Assistant",
  description: "Ask questions about published public policy documents and see the exact page each answer comes from.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1626" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
