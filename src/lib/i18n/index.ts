import { en } from "./en";
import { es } from "./es";

export type Locale = "en" | "es";
export type { Dictionary } from "./en";

export const dictionaries = { en, es } as const;

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}

export function isLocale(value: string): value is Locale {
  return value === "en" || value === "es";
}
