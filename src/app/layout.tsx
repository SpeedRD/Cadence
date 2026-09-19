import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";

import { ICON_COLORS } from "@/components/app-icon-mark";
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

/**
 * `theme-color` is `--background` per scheme, so the browser's own chrome
 * (Safari's bars, the standalone status bar) takes the page's ground instead
 * of a white bar over a near-black app. The media query follows the OS
 * scheme, which is what browsers evaluate; the in-app toggle
 * (theme-provider.tsx) matches it whenever the two agree.
 *
 * `viewportFit: "cover"` is what makes `env(safe-area-inset-*)` non-zero on
 * a notched phone. Without it the bottom tab bar (mobile-tab-bar.tsx) is
 * laid out to the screen's true edge, under the home indicator and the
 * rounded corners; with it the bar's own inset padding lifts its content
 * above them.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: ICON_COLORS.lightBackground },
    { media: "(prefers-color-scheme: dark)", color: ICON_COLORS.background },
  ],
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
          {/* Below sonner's own 600px breakpoint a toast is full-width at
              the bottom edge, where the app's tab bar (49px plus the
              home-indicator inset, mobile-tab-bar.tsx) sits; the offset is
              sonner's 16px default plus that bar. */}
          <Toaster
            position="bottom-right"
            mobileOffset={{ bottom: "calc(16px + 49px + env(safe-area-inset-bottom))" }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
