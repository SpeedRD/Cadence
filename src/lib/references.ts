import { prisma } from "@/lib/prisma";

/** The messages checkReferences can return; every caller's dictionary section has them. */
export interface ReferenceMessages {
  accountNoLongerExists: string;
  accountNoLongerActive: string;
  categoryNoLongerExists: string;
}

/**
 * Confirms the rows a write is about to point at actually exist, and that a new
 * row is not being filed against an archived account. Without this a stale id -
 * a category deleted in another tab, an account archived since the form
 * opened - reached the database and came back as a raw foreign-key error.
 * Editing an existing row accepts an archived account, since its history has to
 * stay editable; only creating something new requires an active one.
 *
 * Lives here rather than in the transactions action module because a "use
 * server" file turns every export into a callable endpoint; a plain helper
 * shared by several actions (transactions, goal contributions) belongs in lib.
 */
export async function checkReferences(
  t: ReferenceMessages,
  accountIds: string[],
  categoryId: string | null,
  requireActiveAccounts: boolean,
): Promise<string | null> {
  for (const accountId of accountIds) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (!account) return t.accountNoLongerExists;
    if (requireActiveAccounts && account.status !== "ACTIVE") return t.accountNoLongerActive;
  }
  if (categoryId) {
    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) return t.categoryNoLongerExists;
  }
  return null;
}
