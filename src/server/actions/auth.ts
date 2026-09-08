"use server";

import { redirect } from "next/navigation";

import {
  isPinConfigured,
  endSession,
  getSettings,
  requireAuth,
  setPin,
  startSession,
  verifyPin,
} from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { isRecoveryConfigured, verifyRecoverySecret } from "@/lib/recovery";
import {
  changePinSchema,
  firstError,
  formObject,
  pinSchema,
  recoverPinSchema,
} from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function createPinAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).login;

  if (await isPinConfigured()) {
    return fail(t.pinAlreadySet);
  }

  const parsed = pinSchema.safeParse(String(formData.get("pin") ?? ""));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

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
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).login;

  const parsed = pinSchema.safeParse(String(formData.get("pin") ?? ""));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

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

/** Settings: a signed-in user swaps the PIN after proving they know the current one. */
export async function changePinAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;

  const parsed = changePinSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));
  if (!(await verifyPin(parsed.data.currentPin))) return fail(t.currentPinWrong);

  await setPin(parsed.data.pin);
  revalidateApp();
  return done(t.pinChanged);
}

/**
 * Login screen: a forgotten PIN is replaced by whoever holds RECOVERY_SECRET
 * (see .env.example), with no old PIN required. A wrong or missing secret
 * gets one generic answer, so the form never confirms whether a PIN is set.
 * The new-PIN format is checked first because that message says nothing
 * about the install either.
 */
export async function recoverPinAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).login;

  if (!isRecoveryConfigured()) return fail(t.recoveryNotConfigured);

  const parsed = recoverPinSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));
  if (!verifyRecoverySecret(parsed.data.secret)) return fail(t.recoveryRejected);

  await setPin(parsed.data.pin);
  await startSession();
  revalidateApp();
  redirect("/");
}
