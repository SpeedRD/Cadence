"use client";

import { createContext, useContext } from "react";

import type { Locale } from "@/lib/i18n";

const LocaleContext = createContext<Locale>("en");

/**
 * The app's language, for the client components that cannot be handed it as a
 * prop. error.tsx is the reason this exists: an error boundary is given only
 * `error` and `retry`, and the root layout deliberately hardcodes lang="en"
 * (see the comment there), so there is nothing else on the page for it to read
 * the language from. Everything else keeps taking `locale` as a prop.
 */
export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}
