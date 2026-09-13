import { describe, expect, it } from "vitest";
import { negotiateLocale, translate } from "./i18n";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

describe("i18n", () => {
  it("en and fr have identical key sets (CI parity)", () => {
    expect(Object.keys(en).toSorted()).toEqual(Object.keys(fr).toSorted());
  });

  it("translates with interpolation and falls back to the key", () => {
    expect(translate("en", "errors.NOT_FOUND", { resource: "User" })).toBe("User not found.");
    expect(translate("fr", "errors.NOT_FOUND", { resource: "Patient" })).toBe(
      "Patient introuvable.",
    );
    expect(translate("en", "errors.__missing__")).toBe("errors.__missing__");
  });

  it("negotiates the locale from Accept-Language", () => {
    expect(negotiateLocale("fr-FR,fr;q=0.9,en;q=0.8", "en")).toBe("fr");
    expect(negotiateLocale("de-DE", "en")).toBe("en");
    expect(negotiateLocale(undefined, "fr")).toBe("fr");
  });
});
