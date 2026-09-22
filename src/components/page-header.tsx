import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  titleAction,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * The page's primary action as a phone shows it (below sm): trailing the
   * title, where iOS puts a list's "+", so it costs no row of its own. The
   * page's header copy of the same action, in `actions`, carries
   * `max-sm:hidden`; from sm up only that copy shows and nothing moves.
   */
  titleAction?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-wrap items-end justify-between gap-4",
        // With a titleAction, below sm: the title and the action share the
        // first row, the description and any remaining actions span below.
        // The title block dissolves (contents) so its heading and
        // description are placed in that grid directly.
        titleAction && "max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-0",
        className,
      )}
    >
      <div className={cn("space-y-1", titleAction && "max-sm:contents")}>
        <h1 className={cn("text-2xl font-semibold", titleAction && "max-sm:col-start-1 max-sm:row-start-1")}>
          {title}
        </h1>
        {description ? (
          <p className={cn("text-sm text-muted-foreground", titleAction && "max-sm:col-span-2")}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          data-slot="page-header-actions"
          className={cn("flex flex-wrap items-center gap-2", titleAction && "max-sm:col-span-2 max-sm:mt-4")}
        >
          {actions}
        </div>
      ) : null}
      {titleAction ? (
        <div className="flex sm:hidden max-sm:col-start-2 max-sm:row-start-1">{titleAction}</div>
      ) : null}
    </div>
  );
}
