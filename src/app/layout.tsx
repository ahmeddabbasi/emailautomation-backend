import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Email Automation System",
  description: "Internal cold email outreach and sequence automation dashboard.",
};

// Every authenticated page reads live data straight from Supabase. Without
// this, Next statically prerenders pages with no dynamic API usage (and
// caches the fetch calls Supabase's client makes under the hood) at build
// time, baking in stale data instead of querying per request.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body>
    </html>
  );
}
