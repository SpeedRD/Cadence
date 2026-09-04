"use client";

import { useEffect } from "react";

import { useLocale } from "@/components/shell/locale-provider";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { MISSING_RATE_DIGEST } from "@/lib/currency";
import { getDictionary } from "@/lib/i18n";

/**
 * Fallback UI for anything a page under this route group throws.
 *
 * The case worth naming is a missing exchange rate: convert() throws rather
 * than passing an amount through unconverted, so a rate table that could not be
 * filled takes the page down instead of quietly showing pesos as dollars. That
 * is the right trade, but only if the user is told what happened and that
 * waiting will fix it - the rate service is retried on the next request.
 *
 * Recognition is by digest, not message: Next.js replaces a server error's
 * message with a generic string in production, and forwards only the digest
 * (see MissingRateError). The message check is a development convenience.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = getDictionary(useLocale()).errorPage;

  useEffect(() => {
    console.error(error);
  }, [error]);

  const isMissingRate =
    error.digest === MISSING_RATE_DIGEST ||
    error.message.includes("No exchange rate available");

  return (
    <EmptyState
      title={isMissingRate ? t.ratesTitle : t.genericTitle}
      description={isMissingRate ? t.ratesDescription : t.genericDescription}
      action={
        <Button size="sm" onClick={() => retry()}>
          {t.tryAgain}
        </Button>
      }
    />
  );
}
