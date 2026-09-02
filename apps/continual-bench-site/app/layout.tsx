import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Continual Bench", template: "%s — Continual Bench" },
  description: "An open protocol and toolkit for measuring whether a model learns new issue families without forgetting old ones.",
  metadataBase: new URL("https://continual.openpond.ai"),
  openGraph: {
    type: "website",
    title: "Continual Bench",
    description: "Convert a test set, run continual evaluation, and read a receipt-derived scorecard.",
    siteName: "Continual Bench",
  },
  twitter: {
    card: "summary",
    title: "Continual Bench",
    description: "Convert a test set, run continual evaluation, and read a receipt-derived scorecard.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f0e8",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="site-header">
          <Link className="wordmark" href="/">Continual Bench</Link>
          <nav aria-label="Documentation">
            <Link href="/convert-a-test-set/">Convert</Link>
            <Link href="/run-continual-evaluation/">Run</Link>
            <Link href="/read-the-scorecard/">Scorecard</Link>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <span>Continual Bench is an open protocol from OpenPond.</span>
          <span>MIT licensed · Results are not an official upstream leaderboard.</span>
        </footer>
      </body>
    </html>
  );
}
