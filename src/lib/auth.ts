import { compare, hash } from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  verifySessionToken,
} from "@/lib/session";

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;
export const SETTINGS_ID = "singleton";

const BCRYPT_ROUNDS = 12;

/** The settings singleton, created on first access. */
export async function getSettings() {
  const existing = await prisma.settings.findUnique({
    where: { id: SETTINGS_ID },
  });
  if (existing) return existing;
  return prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID },
  });
}

export async function isPinConfigured(): Promise<boolean> {
  const settings = await getSettings();
  return Boolean(settings.pinHash);
}

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

export async function setPin(pin: string): Promise<void> {
  const pinHash = await hash(pin, BCRYPT_ROUNDS);
  await prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    update: { pinHash },
    create: { id: SETTINGS_ID, pinHash },
  });
}

export async function verifyPin(pin: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.pinHash) return false;
  return compare(pin, settings.pinHash);
}

export async function startSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Server-side gate for every protected route, alongside the proxy check. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}
