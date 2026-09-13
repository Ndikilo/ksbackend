import en from "./locales/en.json";
import fr from "./locales/fr.json";

export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

type Dictionary = Readonly<Record<string, string>>;
const dictionaries = { en, fr } satisfies Record<Locale, Dictionary>;
const dictionaryFor = (locale: Locale): Dictionary => dictionaries[locale];

const LOCALE_SET: ReadonlySet<string> = new Set(LOCALES);
const isLocale = (value: string): value is Locale => LOCALE_SET.has(value);

/**
 * Pick the best supported locale from an `Accept-Language` header (simple prefix
 * match, first supported wins), falling back to the app default.
 */
export const negotiateLocale = (acceptLanguage: string | undefined, fallback: Locale): Locale => {
  if (acceptLanguage === undefined) return fallback;
  for (const part of acceptLanguage.split(",")) {
    const tag = (part.split(";")[0] ?? "").trim().toLowerCase().slice(0, 2);
    if (isLocale(tag)) return tag;
  }
  return fallback;
};

/**
 * Look up a message by dot-key in the given locale, interpolating `{param}`
 * placeholders. Falls back to English, then to the raw key, so a missing
 * translation degrades visibly rather than throwing. (CI enforces key parity —
 * see i18n.test.ts.)
 */
export const translate = (
  locale: Locale,
  key: string,
  params: Record<string, string | number> = {},
): string => {
  const template = dictionaryFor(locale)[key] ?? dictionaryFor("en")[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
};

/** All message keys (English is the source of truth). Exposed for the parity test. */
export const messageKeys = (): ReadonlyArray<string> => Object.keys(en);
