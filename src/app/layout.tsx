import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import { connection } from "next/server";

import { ICON_COLORS } from "@/components/app-icon-mark";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { SETTINGS_ID } from "@/lib/auth";
import { isLocale, type Locale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";

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

/**
 * The app's language, for <html lang>. Read per request - `connection()`
 * keeps every route out of build-time prerendering, so no build needs a live
 * database, which is why this layout once hardcoded "en" - and never allowed
 * to fail the page: no database, no settings row yet or an unknown value
 * answers "en", as the app does everywhere else.
 */
async function documentLanguage(): Promise<Locale> {
  await connection();
  try {
    const settings = await prisma.settings.findUnique({ where: { id: SETTINGS_ID }, select: { language: true } });
    return settings && isLocale(settings.language) ? settings.language : "en";
  } catch {
    return "en";
  }
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const language = await documentLanguage();
  return (
    <html
      lang={language}
      suppressHydrationWarning
      className={`${archivo.variable} ${instrumentSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <ThemeProvider>
          {children}
          {/* Below sonner's own 600px breakpoint a toast is full-width at
              the bottom edge, where the app's tab bar (49px plus the
              home-indicator inset, mobile-tab-bar.tsx) sits; the offset is
              sonner's 16px default plus that bar. While a phone has a dialog
              open the Toaster moves to the top instead (ui/sonner.tsx), clear
              of the bottom sheet, below the status bar's inset. */}
          <Toaster
            position="bottom-right"
            mobileOffset={{
              top: "calc(8px + env(safe-area-inset-top))",
              bottom: "calc(16px + 49px + env(safe-area-inset-bottom))",
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
