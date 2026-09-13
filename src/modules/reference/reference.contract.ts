import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";

export const ProfessionReferenceResponse = z
  .object({
    id: z.uuid(),
    nameEn: z.string(),
    nameFr: z.string(),
    prefixHint: z.string().nullable(),
  })
  .openapi("ProfessionReference");

export const LanguageReferenceResponse = z
  .object({
    id: z.uuid(),
    code: z.string().length(2),
    nameEn: z.string(),
    nameFr: z.string(),
  })
  .openapi("LanguageReference");

export const ProfessionsPage = paginated(ProfessionReferenceResponse).openapi("Professions");
export const LanguagesPage = paginated(LanguageReferenceResponse).openapi("Languages");
