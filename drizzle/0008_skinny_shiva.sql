ALTER TABLE "availability_rule" DROP CONSTRAINT "availability_rule_weekday_range";--> statement-breakpoint
ALTER TABLE "availability_rule" DROP CONSTRAINT "availability_rule_time_order";--> statement-breakpoint
UPDATE "availability_rule" SET "weekday" = "weekday" % 7;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "cmc_certificate_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "nic_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "profile_photo_uploaded_at" timestamp with time zone;--> statement-breakpoint
UPDATE "practitioner_profile"
SET
  "cmc_certificate_uploaded_at" = CASE WHEN "cmc_certificate_file_key" IS NULL THEN NULL ELSE coalesce("verification_submitted_at", "updated_at") END,
  "nic_uploaded_at" = CASE WHEN "nic_file_key" IS NULL THEN NULL ELSE coalesce("verification_submitted_at", "updated_at") END,
  "profile_photo_uploaded_at" = CASE WHEN "profile_photo_file_key" IS NULL THEN NULL ELSE "updated_at" END;--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_weekday_range" CHECK ("availability_rule"."weekday" between 0 and 6);--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_time_order" CHECK ("availability_rule"."end_time" <> "availability_rule"."start_time");
