-- Typo-tolerant discovery search. pg_trgm powers the `word_similarity`/ILIKE
-- filters in the practitioner search repo; the GIN trigram indexes make both the
-- similarity operators and `ILIKE '%…%'` index-backed. Hand-authored because
-- drizzle-kit does not manage extensions/opclass indexes; kept out of the drizzle
-- schema snapshot so the migration-drift check stays green.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_surname_trgm_idx" ON "profile" USING gin ("surname" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_given_names_trgm_idx" ON "profile" USING gin ("given_names" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "practitioner_profile_specialty_trgm_idx" ON "practitioner_profile" USING gin ("specialty" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "practitioner_profile_location_trgm_idx" ON "practitioner_profile" USING gin ("location" gin_trgm_ops);
