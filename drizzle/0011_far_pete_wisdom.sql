ALTER TABLE "practitioner_profile" ADD COLUMN "cancellation_notice_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "cancellation_fee_xaf" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD CONSTRAINT "practitioner_notice_range" CHECK ("practitioner_profile"."cancellation_notice_hours" between 0 and 720);--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD CONSTRAINT "practitioner_fee_nonnegative" CHECK ("practitioner_profile"."cancellation_fee_xaf" >= 0);