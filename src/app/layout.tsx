import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
});

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "Cadence",
  description: "Personal finance on your pay rhythm.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // Static "en" rather than reading Settings.language: the root layout wraps
  // routes Next.js statically prerenders at build time (e.g. /_not-found), so
  // a DB read here would make every production build depend on a live,
  // already-migrated database connection.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${archivo.variable} ${instrumentSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <ThemeProvider>
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
