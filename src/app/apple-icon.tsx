import { ImageResponse } from "next/og";

import { AppIconMark } from "@/components/app-icon-mark";

/**
 * `<link rel="apple-touch-icon">`: what "Add to Home Screen" on an iPhone
 * uses instead of the manifest's icons. Same PeriodRail mark as icon.tsx;
 * iOS applies its own rounded mask, so the ground is opaque edge to edge.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<AppIconMark size={size.width} />, size);
}
