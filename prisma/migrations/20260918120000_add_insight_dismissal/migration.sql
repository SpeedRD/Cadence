-- An insight the user dismissed on the Inbox page (see InsightDismissal in
-- prisma/schema.prisma and src/lib/insights.ts): the (source, key) pair is
-- never shown in the Inbox or counted by the nav badge again. The same
-- pattern as RecurringSuggestionDismissal, generalized to every insight
-- source. Nothing else changes; the table starts empty.
-- CreateTable
CREATE TABLE "InsightDismissal" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InsightDismissal_source_key_key" ON "InsightDismissal"("source", "key");
