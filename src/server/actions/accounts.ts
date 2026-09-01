"use server";

import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { accountSchema, firstError, formObject } from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function saveAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const parsed = accountSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error));

  const { id, ...values } = parsed.data;
  if (id) {
    await prisma.account.update({ where: { id }, data: values });
  } else {
    await prisma.account.create({ data: values });
  }

  revalidateApp();
  return done(id ? "Account updated" : "Account added");
}

export async function deleteAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail("Nothing to delete");

  await prisma.$transaction(async (tx) => {
    const legs = await tx.transaction.findMany({
      where: { accountId: id, transferId: { not: null } },
      select: { transferId: true },
    });
    const transferIds = legs
      .map((leg) => leg.transferId)
      .filter((value): value is string => Boolean(value));

    await tx.account.delete({ where: { id } });
    // The account's own rows cascade; this removes the far side of its transfers.
    if (transferIds.length > 0) {
      await tx.transaction.deleteMany({
        where: { transferId: { in: transferIds } },
      });
    }
  });

  revalidateApp();
  return done("Account deleted");
}
