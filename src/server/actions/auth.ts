"use server";

import { redirect } from "next/navigation";

import {
  isPinConfigured,
  endSession,
  getSettings,
  setPin,
  startSession,
  verifyPin,
} from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { firstError, pinSchema } from "@/lib/validation";

import { fail, revalidateApp, type ActionState } from "./utils";

export async function createPinAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const settings = await getSettings();
  const t = getDictionary(isLocale(settings.language) ? settings.language : "en").login;

  if (await isPinConfigured()) {
    return fail(t.pinAlreadySet);
  }

  const parsed = pinSchema.safeParse(String(formData.get("pin") ?? ""));
  if (!parsed.success) return fail(firstError(parsed.error));

  const confirmation = String(formData.get("confirm") ?? "").trim();
  if (parsed.data !== confirmation) return fail(t.entriesMustMatch);

  await setPin(parsed.data);
  await startSession();
  revalidateApp();
  redirect("/");
}

export async function loginAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const settings = await getSettings();
  const t = getDictionary(isLocale(settings.language) ? settings.language : "en").login;

  const parsed = pinSchema.safeParse(String(formData.get("pin") ?? ""));
  if (!parsed.success) return fail(firstError(parsed.error));

  if (!(await verifyPin(parsed.data))) return fail(t.pinDoesNotMatch);

  await startSession();
  revalidateApp();
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  revalidateApp();
  redirect("/login");
}
