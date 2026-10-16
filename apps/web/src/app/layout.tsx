import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { origin } from "@/lib/env";
import { siteMetadata } from "./site-metadata";

const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage" });

export function generateMetadata(): Metadata {
  // env is validated on first use, so `next build` may run without PUBLIC_ORIGIN: then relative URLs stay relative.
  let base: string | undefined;
  try {
    base = origin();
  } catch {
    base = undefined;
  }
  return siteMetadata(base);
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {children}
        <Toaster position="top-center" />
      </body>
    </html>
  );
}
