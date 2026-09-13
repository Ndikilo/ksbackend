ALTER TABLE "practitioner_profile" ADD COLUMN "languages_legacy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "practitioner_profile" AS profile
SET "languages_legacy" = true
WHERE EXISTS (
  SELECT 1
  FROM unnest(profile."languages_spoken") AS value
  WHERE value NOT IN ('en', 'fr', 'de', 'es', 'ar', 'pt', 'sw')
);
