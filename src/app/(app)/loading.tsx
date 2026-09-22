import { Skeleton } from "@/components/ui/skeleton";

/**
 * The page frame shown the moment a tab is tapped, while the destination
 * renders on the server (every route here is force-dynamic). It sits under
 * (app)/layout.tsx, so the header, sidebar and tab bar stay mounted and only
 * <main>'s page content swaps to this. Shapes follow PageHeader (a 2xl title,
 * a description line, mb-6) and two cards; no data, so it never waits itself.
 */
export default function Loading() {
  return (
    <div aria-busy="true" className="space-y-5">
      <div className="mb-6 space-y-1">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
