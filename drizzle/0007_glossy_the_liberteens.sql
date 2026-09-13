ALTER TABLE "practitioner_profile" ADD COLUMN "verification_submitted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "practitioner_profile"
SET "verification_submitted_at" = "updated_at"
WHERE "verification_status" <> 'incomplete';
