import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";

// Runs via the Prisma CLI (`prisma db seed`), same as migrations - prefer the
// session-capable DIRECT_URL, falling back to DATABASE_URL for local dev.
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  }),
});

/**
 * Default categories. Colors come from a colour-blind-safe categorical palette
 * so the reports page reads correctly for everyone.
 */
const CATEGORIES = [
  { name: "Groceries", kind: "EXPENSE", color: "#199e70", icon: "shopping-basket" },
  { name: "Dining", kind: "EXPENSE", color: "#d95926", icon: "utensils" },
  { name: "Transport", kind: "EXPENSE", color: "#3987e5", icon: "bus" },
  {
    name: "Subscriptions",
    kind: "EXPENSE",
    color: "#9085e9",
    icon: "repeat",
    isSubscriptionDefault: true,
  },
  { name: "Entertainment", kind: "EXPENSE", color: "#d55181", icon: "clapperboard" },
  { name: "Bills", kind: "EXPENSE", color: "#c98500", icon: "receipt" },
  { name: "Shopping", kind: "EXPENSE", color: "#e66767", icon: "shopping-bag" },
  {
    name: "Savings/Investment",
    kind: "EXPENSE",
    color: "#2aa3b8",
    icon: "piggy-bank",
    isSavingsDefault: true,
  },
  { name: "Other", kind: "EXPENSE", color: "#7a8590", icon: "circle-dashed" },
  { name: "Income", kind: "INCOME", color: "#008300", icon: "arrow-down-left" },
] as const;

async function main() {
  for (const category of CATEGORIES) {
    const data = {
      kind: category.kind,
      color: category.color,
      icon: category.icon,
      isSubscriptionDefault:
        "isSubscriptionDefault" in category ? category.isSubscriptionDefault : false,
      isSavingsDefault:
        "isSavingsDefault" in category ? category.isSavingsDefault : false,
    };
    await prisma.category.upsert({
      where: { name: category.name },
      update: data,
      create: { name: category.name, ...data },
    });
  }

  // The settings singleton exists from the start; the PIN is set on first run.
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });

  const count = await prisma.category.count();
  console.log(`Seeded default categories (${count} total).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
