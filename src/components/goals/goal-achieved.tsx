"use client";

import { useEffect, useSyncExternalStore } from "react";

import { Meter } from "@/components/meter";
import { cn } from "@/lib/utils";

/**
 * Crossing a goal's target is the rarest, highest-emotion moment in the app,
 * and the only place here that spends the delight budget. It has to fire on
 * exactly the contribution that crossed the line and never again, which the
 * server components that draw a goal cannot know on their own: a render is
 * stateless, so "fully funded" looks identical on the contribution that earned
 * it and on every page load afterwards.
 *
 * So the crossing travels as a one-shot client-side event. addContributionAction
 * returns achievedGoalId only for that write (see rebuildGoalSaved), the
 * contribution dialog publishes it here, and the goal's meter and note read it
 * back. Module state, deliberately: it is scoped to this browser session and a
 * reload clears it, which is exactly the lifetime a celebration should have.
 */
let achievedGoalId: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => achievedGoalId;
/** Never celebrating on the server, so hydration matches a fresh page load. */
const getServerSnapshot = () => null;

export function markGoalAchieved(goalId: string) {
  achievedGoalId = goalId;
  emit();
}

/** The meter's 520ms land plus the note's 480ms delay and 260ms fade. */
const CELEBRATION_MS = 1000;

function useJustAchieved(goalId: string) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const celebrating = current === goalId;

  // Released once it has played, so a later revalidation - another goal's
  // contribution, a navigation back to this page - cannot replay it.
  useEffect(() => {
    if (!celebrating) return;
    const timer = setTimeout(() => {
      achievedGoalId = null;
      emit();
    }, CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [celebrating]);

  return celebrating;
}

/**
 * A goal's progress meter, which lands on a longer curve for the one update
 * that completes it and behaves exactly like every other Meter otherwise.
 */
export function GoalMeter({
  goalId,
  value,
  size,
}: {
  goalId: string;
  value: number;
  size?: "default" | "lg";
}) {
  return (
    <Meter
      value={value}
      max={1}
      status="accent"
      size={size}
      celebrate={useJustAchieved(goalId)}
    />
  );
}

/**
 * The "fully funded" line. It animates in only on the crossing; on an ordinary
 * page load of an already-achieved goal it is simply there, as it should be.
 */
export function GoalAchievedNote({
  goalId,
  className,
  children,
}: {
  goalId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const celebrating = useJustAchieved(goalId);
  return (
    <span className={cn(className, celebrating && "goal-achieved-note")}>
      {children}
    </span>
  );
}
