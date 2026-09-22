import { MobileActionDock } from "@/components/mobile-action-dock";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  dock,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * The page's one primary action as a phone renders it, docked above the
   * tab bar (MobileActionDock). The page's header copy of the same action,
   * in `actions`, carries `max-sm:hidden`.
   */
  dock?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-wrap items-end justify-between gap-4",
        className,
      )}
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div data-slot="page-header-actions" className="flex flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
      {/* Last in the header rather than the page: it is fixed, so where it
          sits in the flow does not move it, and here - unlike as the page's
          last child - its display:none from sm up cannot change which child
          the page's space-y treats as last. */}
      {dock ? <MobileActionDock>{dock}</MobileActionDock> : null}
    </div>
  );
}
