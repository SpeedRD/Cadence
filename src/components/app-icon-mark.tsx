/**
 * The app icon: the sidebar's PeriodRail mark (period-rail.tsx rendered with
 * totalDays 10, elapsed 5, compact - five days inked, today in teal, four
 * hairlines left) drawn onto the dark `--background`. Rendered by
 * ImageResponse (Satori) for icon.tsx and apple-icon.tsx, so it is plain
 * inline styles and hex: Satori reads neither Tailwind classes nor oklch.
 *
 * Every colour is a globals.css token resolved to sRGB (CSS Color 4 math),
 * nothing new: the dark ground because the app is dark-first
 * (theme-provider.tsx) and a home-screen icon has one face, and the mark's
 * own foreground/35, foreground/12 and primary on top of it.
 */
export const ICON_COLORS = {
  /** `.dark --background: oklch(0.163 0.0095 248)` */
  background: "#0b0e12",
  /** `:root --background: oklch(0.985 0.002 240)` */
  lightBackground: "#f9fafb",
  /** `.dark --foreground: oklch(0.955 0.004 250)` */
  foreground: "#eef0f3",
  /** `.dark --primary: oklch(0.808 0.098 197)` */
  primary: "#6ad4d6",
} as const;

const TOTAL_DAYS = 10;
const ELAPSED = 5;

/**
 * @param size   the square icon's edge in px
 * @param inset  fraction of the edge kept clear on each side; 0.2 leaves the
 *               mark inside the 60% centre square, which is within the 80%
 *               circle a maskable (Android adaptive) icon guarantees to show
 */
export function AppIconMark({ size, inset = 0.2 }: { size: number; inset?: number }) {
  // The sidebar mark is 64px wide with 2px gaps and 8px-tall ticks; the icon
  // keeps those proportions (gap = width/32, height = width/8).
  const railWidth = size * (1 - 2 * inset);
  const gap = railWidth / 32;
  const tickHeight = railWidth / 8;
  const tickWidth = (railWidth - gap * (TOTAL_DAYS - 1)) / TOTAL_DAYS;
  const radius = Math.max(1, tickWidth / 8);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: ICON_COLORS.background,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap }}>
        {Array.from({ length: TOTAL_DAYS }, (_, day) => {
          const isToday = day === ELAPSED;
          const isPast = day < ELAPSED;
          return (
            <div
              key={day}
              style={{
                width: tickWidth,
                height: tickHeight,
                borderRadius: radius,
                background: isToday
                  ? ICON_COLORS.primary
                  : isPast
                    ? `${ICON_COLORS.foreground}59` // foreground/35
                    : `${ICON_COLORS.foreground}1f`, // foreground/12
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
