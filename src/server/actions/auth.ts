"use server";

import { redirect } from "next/navigation";

import {
  isPinConfigured,
  endSession,
  setPin,
  startSession,
  verifyPin,
} from "@/lib/auth";
import { firstError, pinSchema } from "@/lib/validation";

import { fail, revalidateApp, type ActionState } from "./utils";

export async function createPinAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (await isPinConfigured()) {
    return fail("A PIN is already set for this app");
  }

  const parsed = pinSchema.safeParse(String(formData.get("pin") ?? ""));
  if (!parsed.success) return fail(firstError(parsed.error));

  const confirmation = String(formData.get("confirm") ?? "").trim();
  if (parsed.data !== confirmation) return fail("Both entries must match");

  await setPin(parsed.data);
  await startSession();
  revalidateApp();
  redirect("/");
}

export async function loginAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = pinSchema.safeParse(String(formData.get("pin") ?? ""));
  if (!parsed.success) return fail(firstError(parsed.error));

  if (!(await verifyPin(parsed.data))) return fail("That PIN doesn't match");

  await startSession();
  revalidateApp();
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  revalidateApp();
  redirect("/login");
}
