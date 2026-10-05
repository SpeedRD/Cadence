/**
 * How far a scroller must scroll (positive = down) so `target` sits wholly
 * inside `view` once `marginTop`/`marginBottom` are taken off its edges -
 * e.g. the band a sticky footer covers. 0 when it already does, so a
 * visible target never moves. A target taller than the band is aligned by
 * its top, so its start is what shows. Rects are viewport coordinates
 * (getBoundingClientRect); DOM-free so the harness can check it.
 */
export function revealScrollDelta(
  view: { top: number; bottom: number },
  target: { top: number; bottom: number },
  margins: { top?: number; bottom?: number } = {},
): number {
  const top = view.top + (margins.top ?? 0);
  const bottom = view.bottom - (margins.bottom ?? 0);
  const fitsAbove = target.top >= top;
  const fitsBelow = target.bottom <= bottom;
  if (fitsAbove && fitsBelow) return 0;
  if (target.bottom - target.top > bottom - top) return target.top - top;
  return fitsBelow ? target.top - top : target.bottom - bottom;
}
