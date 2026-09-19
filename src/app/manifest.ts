import type { MetadataRoute } from "next";

import { ICON_COLORS } from "@/components/app-icon-mark";
import { ICON_SIZES } from "./icon";

/**
 * Served at /manifest.webmanifest (and exempted from the PIN gate in
 * src/proxy.ts, since installers fetch it without a session). README.md's
 * position is that the responsive web app is the mobile app, so it installs
 * like one: standalone, with the app's own ground behind the splash screen
 * and its own icon. Colours are `--background` resolved to hex - the dark
 * value, because the app is dark-first and this screen shows before any
 * stylesheet or theme choice is loaded.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cadence",
    short_name: "Cadence",
    description: "Personal finance on your pay rhythm.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: ICON_COLORS.background,
    theme_color: ICON_COLORS.background,
    icons: ICON_SIZES.flatMap((size) =>
      // The mark sits inside the centre 60% (app-icon-mark.tsx), so the same
      // file serves both as-is and under an adaptive-icon mask.
      (["any", "maskable"] as const).map((purpose) => ({
        src: `/icon/${size}`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose,
      })),
    ),
  };
}
