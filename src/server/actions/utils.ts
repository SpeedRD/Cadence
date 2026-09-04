import { revalidatePath } from "next/cache";

export type ActionState = {
  ok: boolean;
  error?: string;
  message?: string;
  /** Changes identity on every result so effects re-run on repeat submits. */
  at?: number;
  /**
   * Set only by the contribution that crossed a goal's target, so the client
   * can mark that one moment. Absent on every later write to an already
   * achieved goal - see rebuildGoalSaved() in src/lib/goals.ts.
   */
  achievedGoalId?: string;
} | null;

export function fail(error: string): ActionState {
  return { ok: false, error, at: Date.now() };
}

export function done(
  message?: string,
  extra?: { achievedGoalId?: string },
): ActionState {
  return { ok: true, message, at: Date.now(), ...extra };
}

/**
 * Every page reads live data, so a single layout-level revalidation keeps the
 * client router cache honest without threading paths through each action.
 */
export function revalidateApp(): void {
  revalidatePath("/", "layout");
}
