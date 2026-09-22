/**
 * A list page's one primary action on a phone (below sm), docked above the
 * tab bar where the thumb is, instead of in the page header at the top of the
 * screen. The page renders the same action in its header with `max-sm:hidden`
 * and a second copy here, so from sm up nothing moves.
 *
 * A toolbar row, not a floating button: the band is DialogFooter's and
 * CardFooter's `border-t bg-muted/50`, pre-composited over the page
 * background (the same colour, opaque) because rows scroll underneath it.
 * Fixed rather than sticky so it sits on the tab bar (49px of tabs under a
 * 1px border, plus the home-indicator inset) even when the page is
 * shorter than the screen; globals.css turns --action-dock-offset on while a
 * dock is on the page, which main's bottom padding and the toasts' offset
 * both add, so content can still scroll clear of it and a toast never lands
 * on the button. Pages reach it through PageHeader's `dock` prop.
 */
export function MobileActionDock({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="action-dock"
      className="fixed inset-x-0 bottom-[calc(50px+env(safe-area-inset-bottom))] z-30 flex h-(--action-dock-height) items-center gap-2 border-t bg-[color-mix(in_srgb,var(--color-muted)_50%,var(--color-background))] px-4 *:flex-1 sm:hidden"
    >
      {children}
    </div>
  );
}
