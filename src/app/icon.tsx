import { ImageResponse } from "next/og";

import { AppIconMark } from "@/components/app-icon-mark";

/**
 * The manifest's icons (manifest.ts lists both), generated from the
 * PeriodRail mark at the two sizes installers want: 192 for the home screen
 * and 512 for the splash screen. Also linked as the page's `icon`, beside
 * favicon.ico. Nothing here reads a request, so both are built once and
 * cached.
 */
export const ICON_SIZES = [192, 512] as const;

export function generateImageMetadata() {
  return ICON_SIZES.map((size) => ({
    id: String(size),
    contentType: "image/png",
    size: { width: size, height: size },
  }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const size = Number(await id);
  return new ImageResponse(<AppIconMark size={size} />, { width: size, height: size });
}
