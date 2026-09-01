"use server";

import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  firstError,
  formObject,
  stagedApproveSchema,
  stagedEditSchema,
} from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

import { Prisma } from "@/generated/prisma/client";

/** Saves inline edits to a still-pending staged row without approving it. */
export async function updateStagedAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const parsed = stagedEditSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error));
  const { id, date, amount, currency, rawDescription, accountId, categoryId } =
    parsed.data;

  const staged = await prisma.stagedTransaction.findUnique({ where: { id } });
  if (!staged) return fail("That item no longer exists");
  if (staged.status !== "PENDING") return fail("This item was already reviewed");

  await prisma.stagedTransaction.update({
    where: { id },
    data: {
      date,
      amount,
      currency,
      rawDescription,
      accountId,
      suggestedCategoryId: categoryId,
    },
  });

  revalidateApp();
  return done("Saved");
}

/**
 * Approving writes a real Transaction with the staged row's source/externalId
 * and marks the staged row APPROVED - it is never mutated back to pending.
 * Every Phase 2A source (receipts, invoices, subscriptions, order
 * confirmations) represents money going out, so the transaction type is
 * always EXPENSE; nothing in this pipeline stages income.
 */
export async function approveStagedAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const parsed = stagedApproveSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error));
  const { id, date, amount, currency, rawDescription, accountId, categoryId } =
    parsed.data;

  const staged = await prisma.stagedTransaction.findUnique({ where: { id } });
  if (!staged) return fail("That item no longer exists");
  if (staged.status !== "PENDING") return fail("This item was already reviewed");

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true },
  });
  if (!account) return fail("That account no longer exists");

  try {
    await prisma.$transaction([
      prisma.transaction.create({
        data: {
          date,
          amount,
          currency,
          type: "EXPENSE",
          accountId,
          categoryId,
          note: rawDescription,
          source: staged.source,
          externalId: staged.externalId,
        },
      }),
      prisma.stagedTransaction.update({
        where: { id },
        data: {
          date,
          amount,
          currency,
          rawDescription,
          accountId,
          suggestedCategoryId: categoryId,
          status: "APPROVED",
          reviewedAt: new Date(),
        },
      }),
    ]);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return fail("This transaction already exists");
    }
    throw error;
  }

  revalidateApp();
  return done("Approved");
}

export async function rejectStagedAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail("Nothing to reject");

  const staged = await prisma.stagedTransaction.findUnique({ where: { id } });
  if (!staged) return fail("That item no longer exists");
  if (staged.status !== "PENDING") return fail("This item was already reviewed");

  await prisma.stagedTransaction.update({
    where: { id },
    data: { status: "REJECTED", reviewedAt: new Date() },
  });

  revalidateApp();
  return done("Rejected");
}
